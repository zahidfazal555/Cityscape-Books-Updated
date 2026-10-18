-- 0012_payroll_inventory: monthly staff, daily-wage labour, per-job contractors and material
-- purchase tracking (Req §4.17 FR-17, §4.18 FR-18; SPEC-FIXES C2; ENGINEERING-STANDARDS H2).
--
-- H2: every payroll run, staff advance, wage payment, contractor payment and salary/daily-rate/
-- job-value change entered by a non-owner is Pending and posts nothing until the Owner approves.
-- Rates live on the employee/job only once approved; a pending change sits in rate_change.

-- Pending (never-posted) money rows may still be rejected or withdrawn after their month is
-- locked; any other change needs the period open. TG_ARGV[0] is the row's date column.
CREATE FUNCTION pending_lock_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  v_col  text := TG_ARGV[0];
  v_skip text[] := ARRAY['status', 'decided_by', 'decided_at', 'reject_reason', 'deleted_at', 'deleted_by'];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status IN ('pending', 'rejected')
     AND NEW.journal_id IS NULL AND NEW.reversal_journal_id IS NULL
     AND (to_jsonb(NEW) - v_skip) = (to_jsonb(OLD) - v_skip) THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM assert_not_locked(OLD.company_id, (to_jsonb(OLD) ->> v_col)::date);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM assert_not_locked(NEW.company_id, (to_jsonb(NEW) ->> v_col)::date);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Employees: salaried staff and daily-wage workers. No Aadhaar, no PAN, no bank details (§9
-- minimisation): payroll in v1 needs none of them.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE employee (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id),
  kind                text NOT NULL CHECK (kind IN ('salaried', 'daily')),
  name                text NOT NULL CHECK (length(trim(name)) > 0),
  -- Designation for staff, trade for workers.
  role_title          text NOT NULL CHECK (length(trim(role_title)) > 0),
  -- A worker is paid against one project at a time; staff are overhead.
  project_id          uuid,
  monthly_gross       numeric(14,2) NOT NULL DEFAULT 0 CHECK (monthly_gross >= 0),
  daily_rate          numeric(14,2) NOT NULL DEFAULT 0 CHECK (daily_rate >= 0),
  monthly_tds         numeric(14,2) NOT NULL DEFAULT 0 CHECK (monthly_tds >= 0),
  pt_half_year        numeric(14,2) NOT NULL DEFAULT 0 CHECK (pt_half_year >= 0),
  recovery_instalment numeric(14,2) NOT NULL DEFAULT 0 CHECK (recovery_instalment >= 0),
  is_active           boolean NOT NULL DEFAULT true,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id),
  CHECK (kind = 'salaried' OR project_id IS NOT NULL),
  CHECK (kind = 'daily' OR daily_rate = 0),
  CHECK (kind = 'salaried' OR (monthly_gross = 0 AND monthly_tds = 0 AND pt_half_year = 0))
);
CREATE INDEX employee_kind ON employee (company_id, kind, is_active);
CREATE TRIGGER employee_touch BEFORE UPDATE ON employee FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER employee_no_delete BEFORE DELETE ON employee FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- ---------------------------------------------------------------------------------------------
-- Contract jobs: a contractor paid per job, with TDS u/s 194C.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE contract_job (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company(id),
  contractor  text NOT NULL CHECK (length(trim(contractor)) > 0),
  work        text NOT NULL CHECK (length(trim(work)) > 0),
  project_id  uuid NOT NULL,
  -- Approved job value; 0 until the Owner approves a non-owner's figure.
  value       numeric(14,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  tds_rate    smallint NOT NULL DEFAULT 0 CHECK (tds_rate IN (0, 1, 2)),
  progress    smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  is_closed   boolean NOT NULL DEFAULT false,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id)
);
CREATE INDEX contract_job_project ON contract_job (company_id, project_id);
CREATE TRIGGER contract_job_touch BEFORE UPDATE ON contract_job FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER contract_job_no_delete BEFORE DELETE ON contract_job FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- ---------------------------------------------------------------------------------------------
-- Rate changes (H2): monthly salary, daily rate or job value, waiting for the Owner.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE rate_change (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES company(id),
  field           text NOT NULL CHECK (field IN ('monthly_gross', 'daily_rate', 'job_value')),
  employee_id     uuid,
  contract_job_id uuid,
  old_value       numeric(14,2) NOT NULL CHECK (old_value >= 0),
  new_value       numeric(14,2) NOT NULL CHECK (new_value >= 0),
  status          text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_by      uuid,
  decided_at      timestamptz,
  reject_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, employee_id)     REFERENCES employee (company_id, id),
  FOREIGN KEY (company_id, contract_job_id) REFERENCES contract_job (company_id, id),
  CHECK ((field = 'job_value') = (contract_job_id IS NOT NULL)),
  CHECK ((field = 'job_value') = (employee_id IS NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
-- One open change per figure: a second request replaces nothing silently.
CREATE UNIQUE INDEX rate_change_one_pending
  ON rate_change (field, coalesce(employee_id, contract_job_id)) WHERE status = 'pending';
CREATE TRIGGER rate_change_no_delete BEFORE DELETE ON rate_change FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- ---------------------------------------------------------------------------------------------
-- Staff advances: Dr Staff advances (1300) / Cr cash, bank or UPI. Recovered through payslips.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE staff_advance (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id),
  employee_id         uuid NOT NULL,
  adv_date            date NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  mode                text NOT NULL CHECK (mode IN ('bank', 'upi', 'cash', 'cheque')),
  reference           text,
  account_code        text NOT NULL CHECK (account_code IN ('1000', '1010', '1020')),
  status              text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by          uuid,
  decided_at          timestamptz,
  reject_reason       text,
  journal_id          uuid,
  deleted_at          timestamptz,
  deleted_by          uuid,
  reversal_journal_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employee (company_id, id),
  FOREIGN KEY (company_id, journal_id)  REFERENCES journal (company_id, id),
  FOREIGN KEY (company_id, reversal_journal_id) REFERENCES journal (company_id, id),
  CHECK (mode = 'cash' OR length(trim(coalesce(reference, ''))) > 0),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
  CHECK (deleted_at IS NULL OR status <> 'approved' OR reversal_journal_id IS NOT NULL)
);
CREATE INDEX staff_advance_employee ON staff_advance (employee_id);

-- ---------------------------------------------------------------------------------------------
-- Payroll runs, one live run per month: Dr Salaries (6000) gross / Cr TDS payable (2310) /
-- Cr PT payable (2320) / Cr Staff advances (1300) / Cr cash, bank or UPI for the net.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE payroll_run (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id),
  period              char(7) NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  pay_date            date NOT NULL,
  mode                text NOT NULL CHECK (mode IN ('bank', 'upi', 'cash', 'cheque')),
  reference           text,
  account_code        text NOT NULL CHECK (account_code IN ('1000', '1010', '1020')),
  gross               numeric(14,2) NOT NULL CHECK (gross > 0),
  tds                 numeric(14,2) NOT NULL CHECK (tds >= 0),
  pt                  numeric(14,2) NOT NULL CHECK (pt >= 0),
  recovery            numeric(14,2) NOT NULL CHECK (recovery >= 0),
  net                 numeric(14,2) NOT NULL CHECK (net >= 0),
  status              text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by          uuid,
  decided_at          timestamptz,
  reject_reason       text,
  journal_id          uuid,
  deleted_at          timestamptz,
  deleted_by          uuid,
  reversal_journal_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, journal_id) REFERENCES journal (company_id, id),
  FOREIGN KEY (company_id, reversal_journal_id) REFERENCES journal (company_id, id),
  CHECK (gross = tds + pt + recovery + net),
  CHECK (mode = 'cash' OR length(trim(coalesce(reference, ''))) > 0),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
  CHECK (deleted_at IS NULL OR status <> 'approved' OR reversal_journal_id IS NOT NULL)
);
CREATE UNIQUE INDEX payroll_run_one_per_month ON payroll_run (company_id, period)
  WHERE status <> 'rejected' AND deleted_at IS NULL;

CREATE TABLE payslip (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company(id),
  run_id      uuid NOT NULL,
  employee_id uuid NOT NULL,
  -- Name and designation as on the run date, so a later rename leaves old payslips alone.
  name        text NOT NULL,
  role_title  text NOT NULL,
  gross       numeric(14,2) NOT NULL CHECK (gross > 0),
  tds         numeric(14,2) NOT NULL CHECK (tds >= 0),
  pt          numeric(14,2) NOT NULL CHECK (pt >= 0),
  recovery    numeric(14,2) NOT NULL CHECK (recovery >= 0),
  net         numeric(14,2) NOT NULL CHECK (net >= 0),
  UNIQUE (run_id, employee_id),
  FOREIGN KEY (company_id, run_id)      REFERENCES payroll_run (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employee (company_id, id),
  CHECK (gross = tds + pt + recovery + net)
);
CREATE INDEX payslip_employee ON payslip (employee_id);
CREATE TRIGGER payslip_immutable BEFORE UPDATE OR DELETE ON payslip
  FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- ---------------------------------------------------------------------------------------------
-- Attendance (in tenths of a day) at the daily rate in force that day; wages paid against it:
-- Dr Project cost – Labour (5010) / Cr cash, bank or UPI.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company(id),
  employee_id uuid NOT NULL,
  project_id  uuid NOT NULL,
  work_date   date NOT NULL,
  tenths      smallint NOT NULL CHECK (tenths IN (5, 10)),
  rate        numeric(14,2) NOT NULL CHECK (rate > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (employee_id, work_date),
  FOREIGN KEY (company_id, employee_id) REFERENCES employee (company_id, id),
  FOREIGN KEY (company_id, project_id)  REFERENCES project (company_id, id)
);
CREATE INDEX attendance_project ON attendance (company_id, project_id, work_date);
CREATE TRIGGER attendance_lock BEFORE INSERT OR UPDATE OR DELETE ON attendance
  FOR EACH ROW EXECUTE FUNCTION document_lock_guard('work_date');

CREATE TABLE wage_payment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id),
  employee_id         uuid NOT NULL,
  project_id          uuid NOT NULL,
  pay_date            date NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  mode                text NOT NULL CHECK (mode IN ('bank', 'upi', 'cash', 'cheque')),
  reference           text,
  account_code        text NOT NULL CHECK (account_code IN ('1000', '1010', '1020')),
  status              text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by          uuid,
  decided_at          timestamptz,
  reject_reason       text,
  journal_id          uuid,
  deleted_at          timestamptz,
  deleted_by          uuid,
  reversal_journal_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employee (company_id, id),
  FOREIGN KEY (company_id, project_id)  REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, journal_id)  REFERENCES journal (company_id, id),
  FOREIGN KEY (company_id, reversal_journal_id) REFERENCES journal (company_id, id),
  CHECK (mode = 'cash' OR length(trim(coalesce(reference, ''))) > 0),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
  CHECK (deleted_at IS NULL OR status <> 'approved' OR reversal_journal_id IS NOT NULL)
);
CREATE INDEX wage_payment_employee ON wage_payment (employee_id);

-- Dr Project cost – Subcontract (5020) gross / Cr cash, bank or UPI net / Cr TDS payable (2310).
CREATE TABLE contract_payment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id),
  job_id              uuid NOT NULL,
  project_id          uuid NOT NULL,
  pay_date            date NOT NULL,
  -- Settled against the job value; the cash paid is amount − tds.
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  tds                 numeric(14,2) NOT NULL DEFAULT 0 CHECK (tds >= 0 AND tds < amount),
  mode                text NOT NULL CHECK (mode IN ('bank', 'upi', 'cash', 'cheque')),
  reference           text,
  account_code        text NOT NULL CHECK (account_code IN ('1000', '1010', '1020')),
  status              text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by          uuid,
  decided_at          timestamptz,
  reject_reason       text,
  journal_id          uuid,
  deleted_at          timestamptz,
  deleted_by          uuid,
  reversal_journal_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, job_id)     REFERENCES contract_job (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, journal_id) REFERENCES journal (company_id, id),
  FOREIGN KEY (company_id, reversal_journal_id) REFERENCES journal (company_id, id),
  CHECK (mode = 'cash' OR length(trim(coalesce(reference, ''))) > 0),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
  CHECK (deleted_at IS NULL OR status <> 'approved' OR reversal_journal_id IS NOT NULL)
);
CREATE INDEX contract_payment_job ON contract_payment (job_id);

DO $$
DECLARE t text; c text;
BEGIN
  FOR t, c IN VALUES ('staff_advance', 'adv_date'), ('payroll_run', 'pay_date'),
                     ('wage_payment', 'pay_date'), ('contract_payment', 'pay_date')
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I '
                   'FOR EACH ROW EXECUTE FUNCTION pending_lock_guard(%L)', t || '_lock', t, c);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION refuse_change()',
                   t || '_no_delete', t);
    EXECUTE format('CREATE INDEX %I ON %I (company_id) WHERE status = ''pending'' AND deleted_at IS NULL',
                   t || '_pending', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Inventory (FR-18): material purchase tracking only; posts nothing (the bill or expense does).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE material_purchase (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company(id),
  project_id    uuid NOT NULL,
  purchase_date date NOT NULL,
  item          text NOT NULL CHECK (length(trim(item)) > 0),
  category      text NOT NULL CHECK (length(trim(category)) > 0),
  unit          text NOT NULL CHECK (length(trim(unit)) > 0),
  qty_milli     bigint NOT NULL CHECK (qty_milli > 0),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  vendor_name   text NOT NULL CHECK (length(trim(vendor_name)) > 0),
  bill_id       uuid,
  deleted_at    timestamptz,
  deleted_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, bill_id)    REFERENCES bill (company_id, id)
);
CREATE INDEX material_purchase_project ON material_purchase (company_id, project_id, purchase_date);
CREATE TRIGGER material_purchase_lock BEFORE INSERT OR UPDATE OR DELETE ON material_purchase
  FOR EACH ROW EXECUTE FUNCTION document_lock_guard('purchase_date');
CREATE TRIGGER material_purchase_no_delete BEFORE DELETE ON material_purchase
  FOR EACH ROW EXECUTE FUNCTION refuse_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee', 'contract_job', 'rate_change', 'staff_advance', 'payroll_run',
                           'payslip', 'attendance', 'wage_payment', 'contract_payment', 'material_purchase']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) '
      'WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON employee, contract_job, rate_change, staff_advance, payroll_run,
  wage_payment, contract_payment, material_purchase TO csd_app;
GRANT SELECT, INSERT ON payslip TO csd_app;
GRANT SELECT, INSERT, DELETE ON attendance TO csd_app;
