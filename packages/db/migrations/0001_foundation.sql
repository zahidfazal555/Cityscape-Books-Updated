-- 0001_foundation: Phase 1 schema.
-- Company isolation (RLS), users and per-module rights, project scoping, sessions, contacts,
-- projects, gapless number series, append-only audit log, chart of accounts and the
-- balanced, immutable, lock-date-aware journal.
--
-- The app connects as a login role that is a member of `csd_app`. `csd_app` has no
-- BYPASSRLS, and no UPDATE/DELETE on audit_log, journal or journal_line.

CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'csd_app') THEN
    CREATE ROLE csd_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Tenant context helpers
-- ---------------------------------------------------------------------------------------------

-- The company of the current transaction, set by the app with
-- `SELECT set_config('app.company_id', $1, true)`. Never taken from request bodies.
CREATE FUNCTION app_company_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;

CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); NEW.updated_by := app_user_id(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------------------------
-- Company
-- ---------------------------------------------------------------------------------------------

CREATE TABLE company (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL CHECK (length(trim(name)) > 0),
  legal_name              text,
  gstin                   text CHECK (gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code              char(2) NOT NULL DEFAULT '33',
  address                 text,
  phone                   text,
  email                   citext,
  bank_name               text,
  bank_acc                text,
  bank_ifsc               text,
  bank_branch             text,
  fy_start_month          smallint NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  lock_date               date,
  require_bill_attachment boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid
);
CREATE TRIGGER company_touch BEFORE UPDATE ON company FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Users, rights and project scope
-- ---------------------------------------------------------------------------------------------

CREATE TABLE app_user (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id),
  name                text NOT NULL CHECK (length(trim(name)) > 0),
  email               citext NOT NULL UNIQUE,
  phone               text CHECK (phone IS NULL OR phone ~ '^[6-9]\d{9}$'),
  password_hash       text,                               -- argon2id; NULL until invite accepted
  role                text NOT NULL CHECK (role IN ('owner','admin','manager','asstmgr','site','auditor')),
  projects_all        boolean NOT NULL DEFAULT true,
  is_active           boolean NOT NULL DEFAULT true,
  access_expires_at   timestamptz,                        -- auditor access expiry (H3)
  failed_attempts     integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until        timestamptz,
  last_login_at       timestamptz,
  password_changed_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  UNIQUE (company_id, id),
  CHECK (role <> 'auditor' OR access_expires_at IS NOT NULL)
);
-- Exactly one owner per company; the owner row can never be deactivated.
CREATE UNIQUE INDEX app_user_one_owner ON app_user (company_id) WHERE role = 'owner';
ALTER TABLE app_user ADD CONSTRAINT owner_always_active CHECK (role <> 'owner' OR is_active);
CREATE TRIGGER app_user_touch BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE user_permission (
  company_id uuid NOT NULL,
  user_id    uuid NOT NULL,
  module     text NOT NULL CHECK (module IN (
    'dashboard','projects','contacts','quotes','proformas','invoices','receipts','pos','bills',
    'expenses','approvals','pnl','banking','outstanding','gst','reports','payroll','inventory',
    'tickets','warranty','kb')),
  level      text NOT NULL CHECK (level IN ('none','view','edit','full')),
  PRIMARY KEY (user_id, module),
  FOREIGN KEY (company_id, user_id) REFERENCES app_user (company_id, id) ON DELETE CASCADE,
  CHECK (module NOT IN ('dashboard','outstanding','reports','pnl') OR level IN ('none','view')),
  CHECK (module <> 'approvals' OR level IN ('none','full'))
);

CREATE TABLE session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL,
  user_id            uuid NOT NULL,
  refresh_token_hash text NOT NULL UNIQUE,                -- sha-256 of the opaque token
  ip                 inet,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  FOREIGN KEY (company_id, user_id) REFERENCES app_user (company_id, id)
);
CREATE INDEX session_user_active ON session (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Contacts (one table for clients, vendors, employees, contractors — SPEC-FIXES B5)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE contact (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES company(id),
  type               text NOT NULL CHECK (type IN ('client','vendor','employee','contractor')),
  name               text NOT NULL CHECK (length(trim(name)) > 0),
  contact_person     text,
  gstin              text CHECK (gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan                text CHECK (pan ~ '^[A-Z]{5}\d{4}[A-Z]$'),
  state_code         char(2) NOT NULL,
  address            text,
  phone              text,
  email              citext,
  payment_terms_days integer CHECK (payment_terms_days BETWEEN 0 AND 365),
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  UNIQUE (company_id, id),
  CHECK (gstin IS NULL OR left(gstin, 2) = state_code)
);
CREATE UNIQUE INDEX contact_unique_name ON contact (company_id, type, lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER contact_touch BEFORE UPDATE ON contact FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------------------------

CREATE TABLE project (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES company(id),
  code            text NOT NULL,
  name            text NOT NULL CHECK (length(trim(name)) > 0),
  client_id       uuid NOT NULL,
  site_address    text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','completed','cancelled')),
  start_date      date NOT NULL,
  end_date        date,
  contract_value  numeric(14,2) NOT NULL DEFAULT 0 CHECK (contract_value >= 0),
  cost_budget     numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost_budget >= 0),
  manager_id      uuid,
  engineer_id     uuid,
  handover_date   date,
  warranty_months smallint NOT NULL DEFAULT 12 CHECK (warranty_months IN (6, 12, 24, 60)),
  amc_until       date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  UNIQUE (company_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, client_id)   REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, manager_id)  REFERENCES app_user (company_id, id),
  FOREIGN KEY (company_id, engineer_id) REFERENCES app_user (company_id, id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (handover_date IS NULL OR handover_date >= start_date)
);
CREATE TRIGGER project_touch BEFORE UPDATE ON project FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE user_project (
  company_id uuid NOT NULL,
  user_id    uuid NOT NULL,
  project_id uuid NOT NULL,
  PRIMARY KEY (user_id, project_id),
  FOREIGN KEY (company_id, user_id)    REFERENCES app_user (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------------------------
-- Gapless number series (SPEC-FIXES A8). Call inside the same transaction as the document
-- insert: the row lock serialises concurrent callers and a rollback releases the number.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE number_series (
  company_id uuid NOT NULL REFERENCES company(id),
  series     text NOT NULL,
  period     text NOT NULL,                               -- '26-27', or '-' for non-FY series
  next_value integer NOT NULL CHECK (next_value >= 1),
  PRIMARY KEY (company_id, series, period)
);

CREATE FUNCTION next_number(p_series text, p_period text) RETURNS integer
  LANGUAGE sql VOLATILE AS
$$
  INSERT INTO number_series (company_id, series, period, next_value)
  VALUES (app_company_id(), p_series, p_period, 2)
  ON CONFLICT (company_id, series, period)
    DO UPDATE SET next_value = number_series.next_value + 1
  RETURNING next_value - 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit log: append-only (FR-3.3.3). Blocked for every role by trigger, and csd_app has
-- only INSERT/SELECT on it.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES company(id),
  user_id    uuid,
  at         timestamptz NOT NULL DEFAULT now(),
  ip         inet,
  action     text NOT NULL,                               -- create/update/delete/approve/login/export…
  entity     text NOT NULL,
  entity_id  text,
  outcome    text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','denied','failed')),
  before     jsonb,
  after      jsonb
);
CREATE INDEX audit_log_entity ON audit_log (company_id, entity, entity_id);
CREATE INDEX audit_log_at ON audit_log (company_id, at DESC);

CREATE FUNCTION refuse_change() RETURNS trigger
  LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'CB409'; END $$;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_change();

-- ---------------------------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------------------------

CREATE TABLE account (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  code       text NOT NULL,
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  subtype    text,
  is_system  boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

-- System accounts every company starts with. Codes are referenced by posting rules.
CREATE FUNCTION seed_company_accounts(p_company uuid) RETURNS void
  LANGUAGE sql AS
$$
  INSERT INTO account (company_id, code, name, type, subtype, is_system)
  SELECT p_company, v.code, v.name, v.type, v.subtype, true
  FROM (VALUES
    ('1000','Cash in hand','asset','cash'),
    ('1010','Bank – current account','asset','bank'),
    ('1020','UPI clearing','asset','upi'),
    ('1100','Accounts receivable','asset','receivable'),
    ('1200','Input CGST','asset','gst_input'),
    ('1201','Input SGST','asset','gst_input'),
    ('1202','Input IGST','asset','gst_input'),
    ('1300','Staff advances','asset',NULL),
    ('1400','TDS receivable','asset',NULL),
    ('2000','Accounts payable','liability','payable'),
    ('2100','Customer advances','liability','advance'),
    ('2200','Output CGST','liability','gst_output'),
    ('2201','Output SGST','liability','gst_output'),
    ('2202','Output IGST','liability','gst_output'),
    ('2210','GST payable – reverse charge','liability','gst_rcm'),
    ('2300','Salaries payable','liability',NULL),
    ('2310','TDS payable','liability','tds'),
    ('2320','Professional tax payable','liability',NULL),
    ('3000','Owner''s capital','equity',NULL),
    ('3100','Opening balance equity','equity',NULL),
    ('4000','Sales – works contract','income','sales'),
    ('4900','Round off','income','round_off'),
    ('5000','Project cost – Material','expense','project_cost'),
    ('5010','Project cost – Labour','expense','project_cost'),
    ('5020','Project cost – Subcontract (FC)','expense','project_cost'),
    ('5030','Project cost – Transport','expense','project_cost'),
    ('5040','Project cost – Fuel','expense','project_cost'),
    ('5050','Project cost – Miscellaneous','expense','project_cost'),
    ('5060','Project cost – Incentives','expense','project_cost'),
    ('5070','Project cost – Site visit','expense','project_cost'),
    ('5080','Project cost – Rent/Equipment','expense','project_cost'),
    ('6000','Salaries','expense','overhead')
  ) AS v(code, name, type, subtype)
$$;

-- ---------------------------------------------------------------------------------------------
-- Journal: every document posts one balanced journal. Posted journals are immutable;
-- corrections are reversing journals (ENGINEERING-STANDARDS §4).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE journal (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id),
  txn_date            date NOT NULL,
  source_type         text NOT NULL,
  source_id           uuid,
  narration           text NOT NULL,
  reverses_journal_id uuid,
  posted_at           timestamptz NOT NULL DEFAULT now(),
  posted_by           uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, reverses_journal_id) REFERENCES journal (company_id, id)
);
CREATE INDEX journal_source ON journal (company_id, source_type, source_id);
CREATE INDEX journal_date ON journal (company_id, txn_date);
-- A document can be reversed only once.
CREATE UNIQUE INDEX journal_single_reversal ON journal (reverses_journal_id) WHERE reverses_journal_id IS NOT NULL;

CREATE TABLE journal_line (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  journal_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid,
  contact_id uuid,
  debit      numeric(14,2) NOT NULL DEFAULT 0,
  credit     numeric(14,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (company_id, journal_id) REFERENCES journal (company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES account (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id),
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit = 0) <> (credit = 0))                      -- exactly one side is non-zero
);
CREATE INDEX journal_line_journal ON journal_line (journal_id);
CREATE INDEX journal_line_project ON journal_line (company_id, project_id, account_id);

-- Lock date enforced in the database too (FR-3.3.1). SQLSTATE CB423 → HTTP 423.
CREATE FUNCTION assert_not_locked(p_company uuid, p_date date) RETURNS void
  LANGUAGE plpgsql STABLE AS
$$
DECLARE v_lock date;
BEGIN
  SELECT lock_date INTO v_lock FROM company WHERE id = p_company;
  IF v_lock IS NOT NULL AND p_date <= v_lock THEN
    RAISE EXCEPTION 'Books are locked till %. Pick a later date.', to_char(v_lock, 'DD Mon YYYY')
      USING ERRCODE = 'CB423';
  END IF;
END
$$;

CREATE FUNCTION journal_check_lock() RETURNS trigger
  LANGUAGE plpgsql AS
$$ BEGIN PERFORM assert_not_locked(NEW.company_id, NEW.txn_date); RETURN NEW; END $$;

CREATE TRIGGER journal_lock BEFORE INSERT ON journal
  FOR EACH ROW EXECUTE FUNCTION journal_check_lock();
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON journal
  FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- Debits = credits and at least two lines, checked at COMMIT (deferred). SQLSTATE CB422.
CREATE FUNCTION journal_check_balanced() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE v_dr numeric; v_cr numeric; v_n integer; v_id uuid;
BEGIN
  -- Separate branches: PL/pgSQL resolves every NEW.<field> in an expression, even unused ones.
  IF TG_TABLE_NAME = 'journal' THEN
    v_id := NEW.id;
  ELSE
    v_id := NEW.journal_id;
  END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO v_dr, v_cr, v_n
    FROM journal_line WHERE journal_id = v_id;
  IF v_n < 2 OR v_dr <> v_cr THEN
    RAISE EXCEPTION 'Journal % is not balanced (debits %, credits %, lines %)', v_id, v_dr, v_cr, v_n
      USING ERRCODE = 'CB422';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();

-- ---------------------------------------------------------------------------------------------
-- Login lookup: runs before a company context exists, so it bypasses RLS in a controlled way
-- and returns only what sign-in needs.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION auth_find_user(p_email citext)
  RETURNS TABLE (id uuid, company_id uuid, password_hash text, role text, is_active boolean,
                 access_expires_at timestamptz, failed_attempts integer, locked_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT u.id, u.company_id, u.password_hash, u.role, u.is_active, u.access_expires_at,
         u.failed_attempts, u.locked_until
  FROM app_user u WHERE u.email = p_email
$$;

-- Records a failed sign-in: 5 failures lock the account for 15 minutes (Tech Spec §7).
CREATE FUNCTION auth_record_failure(p_user uuid) RETURNS timestamptz
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  UPDATE app_user
     SET failed_attempts = CASE WHEN failed_attempts + 1 >= 5 THEN 0 ELSE failed_attempts + 1 END,
         locked_until    = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes'
                                ELSE locked_until END
   WHERE id = p_user
  RETURNING locked_until
$$;

REVOKE ALL ON FUNCTION auth_find_user(citext), auth_record_failure(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(citext), auth_record_failure(uuid) TO csd_app;

-- ---------------------------------------------------------------------------------------------
-- Row-level security on every company-owned table
-- ---------------------------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_user','user_permission','session','contact','project',
                           'user_project','number_series','audit_log','account','journal',
                           'journal_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE also applies RLS to the table owner. app_user is left unforced so the two
    -- SECURITY DEFINER auth functions (owned by the migration role) can find a user by email
    -- before a company context exists. csd_app is never the owner, so RLS still binds it.
    IF t <> 'app_user' THEN
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    END IF;
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) '
      'WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

ALTER TABLE company ENABLE ROW LEVEL SECURITY;
ALTER TABLE company FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company USING (id = app_company_id()) WITH CHECK (id = app_company_id());

-- ---------------------------------------------------------------------------------------------
-- Grants for the app role
-- ---------------------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO csd_app;
GRANT SELECT, UPDATE ON company TO csd_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_user, user_permission, session, contact, project,
  user_project, account TO csd_app;
GRANT SELECT, INSERT, UPDATE ON number_series TO csd_app;
GRANT SELECT, INSERT ON audit_log, journal, journal_line TO csd_app;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO csd_app;
