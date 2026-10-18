-- 0005_idempotency: replay protection for POSTs (ENGINEERING-STANDARDS §4: "Idempotency-Key on
-- every POST, stored 24 h. A double-click on 'Pay' returns the first result").

CREATE TABLE idempotency_key (
  company_id   uuid NOT NULL REFERENCES company(id),
  user_id      uuid NOT NULL,
  key          text NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,100}$'),
  method       text NOT NULL,
  path         text NOT NULL,
  request_hash text NOT NULL,
  status       smallint,          -- NULL while the first request is still running
  body         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id, key)
);
CREATE INDEX idempotency_key_created ON idempotency_key (created_at);

ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON idempotency_key
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_key TO csd_app;

-- 0004: an UPDATE that moves a child row to another parent must satisfy the lock for both parents.
CREATE OR REPLACE FUNCTION child_lock_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE v_date date;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_TABLE_NAME = 'invoice_line' THEN
      SELECT invoice_date INTO v_date FROM invoice WHERE id = OLD.invoice_id;
    ELSE
      SELECT receipt_date INTO v_date FROM receipt WHERE id = OLD.receipt_id;
    END IF;
    PERFORM assert_not_locked(OLD.company_id, v_date);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_TABLE_NAME = 'invoice_line' THEN
      SELECT invoice_date INTO v_date FROM invoice WHERE id = NEW.invoice_id;
    ELSE
      SELECT receipt_date INTO v_date FROM receipt WHERE id = NEW.receipt_id;
    END IF;
    PERFORM assert_not_locked(NEW.company_id, v_date);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
