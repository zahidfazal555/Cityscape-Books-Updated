-- 0008_expenses: bill photos (attachments) and site expenses with Owner approval
-- (Req §4.11, §4.12; SPEC-FIXES B6, B10; ENGINEERING-STANDARDS H2, H4).
-- Pending and rejected expenses post nothing; an approved one posts Dr project cost / Cr cash,
-- bank or UPI on its date.

-- Metadata only; the bytes live in private object storage under storage_key.
CREATE TABLE attachment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES company(id),
  storage_key  text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes   integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256       char(64) NOT NULL,
  uploaded_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE TRIGGER attachment_immutable BEFORE UPDATE ON attachment
  FOR EACH ROW EXECUTE FUNCTION refuse_change();

CREATE TABLE expense (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id),
  project_id          uuid NOT NULL,
  txn_date            date NOT NULL,
  particulars         text NOT NULL CHECK (length(trim(particulars)) > 0),
  category            text NOT NULL CHECK (category IN ('material', 'labour', 'subcontract', 'transport',
                        'fuel', 'misc', 'incentives', 'site_visit', 'rent')),
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  -- FR-11.4: a label, not a wallet.
  paid_by             text NOT NULL CHECK (length(trim(paid_by)) > 0),
  mode                text NOT NULL CHECK (mode IN ('upi', 'cash', 'bank')),
  paid_to             text,
  account_code        text NOT NULL CHECK (account_code IN ('1000', '1010', '1020')),
  attachment_id       uuid,
  -- B6: rows imported from the Excel trackers have no photo.
  migrated            boolean NOT NULL DEFAULT false,
  -- B10: only manual (and visit) expenses are edited or deleted here.
  source              text NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual', 'payroll_wage', 'contract_payment', 'visit')),
  source_id           uuid,
  status              text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by          uuid,
  decided_at          timestamptz,
  reject_reason       text,
  journal_id          uuid,
  deleted_at          timestamptz,
  deleted_by          uuid,
  reversal_journal_id uuid,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id)    REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, attachment_id) REFERENCES attachment (company_id, id),
  FOREIGN KEY (company_id, journal_id)    REFERENCES journal (company_id, id),
  FOREIGN KEY (company_id, reversal_journal_id) REFERENCES journal (company_id, id),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
  CHECK (deleted_at IS NULL OR status <> 'approved' OR reversal_journal_id IS NOT NULL)
);
CREATE INDEX expense_project_date ON expense (company_id, project_id, txn_date);
CREATE INDEX expense_pending ON expense (company_id) WHERE status = 'pending' AND deleted_at IS NULL;
-- One photo backs one expense.
CREATE UNIQUE INDEX expense_attachment ON expense (attachment_id) WHERE attachment_id IS NOT NULL;
CREATE TRIGGER expense_touch BEFORE UPDATE ON expense FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER expense_no_delete BEFORE DELETE ON expense FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- Like vendor_payment_lock_guard (0007): an expense that never posted may still be rejected or
-- withdrawn after its month is locked; anything else needs the period open.
CREATE FUNCTION expense_lock_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status IN ('pending', 'rejected')
     AND NEW.journal_id IS NULL AND NEW.reversal_journal_id IS NULL
     AND (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'reject_reason', 'deleted_at',
                                'deleted_by', 'updated_at', 'updated_by', 'version'])
       = (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'reject_reason', 'deleted_at',
                                'deleted_by', 'updated_at', 'updated_by', 'version']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM assert_not_locked(OLD.company_id, OLD.txn_date); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM assert_not_locked(NEW.company_id, NEW.txn_date); END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER expense_lock BEFORE INSERT OR UPDATE OR DELETE ON expense
  FOR EACH ROW EXECUTE FUNCTION expense_lock_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attachment', 'expense']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) '
      'WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON attachment TO csd_app;
GRANT SELECT, INSERT, UPDATE ON expense TO csd_app;
