-- 0006_quotations_proformas: quotations (with revisions) and proforma invoices with advances
-- (Req §4b, §4c; SPEC-FIXES A4). Neither posts revenue; advances post to Customer advances.

CREATE TABLE quotation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES company(id),
  number            text NOT NULL,
  revision          integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  client_id         uuid NOT NULL,
  place_of_supply   char(2) NOT NULL,
  title             text NOT NULL CHECK (length(trim(title)) > 0),
  site              text,
  quote_date        date NOT NULL,
  valid_till        date NOT NULL,
  discount_pct      numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 50),
  -- ENGINEERING-STANDARDS H2: any discount entered by a non-approver waits for the owner.
  discount_approved boolean NOT NULL DEFAULT true,
  terms             text,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined')),
  project_id        uuid,
  taxable           numeric(14,2) NOT NULL,
  total             numeric(14,2) NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  UNIQUE (company_id, number),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, client_id)  REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id),
  CHECK (valid_till >= quote_date),
  CHECK (discount_pct = 0 OR status = 'draft' OR discount_approved)
);
CREATE INDEX quotation_client ON quotation (company_id, client_id);
CREATE TRIGGER quotation_touch BEFORE UPDATE ON quotation FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE quotation_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL,
  quotation_id uuid NOT NULL,
  sort         smallint NOT NULL,
  description  text NOT NULL CHECK (length(trim(description)) > 0),
  sac_hsn      text NOT NULL CHECK (sac_hsn ~ '^\d{4,8}$'),
  qty          numeric(12,3) NOT NULL CHECK (qty > 0),
  unit         text NOT NULL,
  rate         numeric(14,2) NOT NULL CHECK (rate >= 0),
  gst_rate     numeric(4,2) NOT NULL CHECK (gst_rate IN (0, 5, 12, 18, 28)),
  FOREIGN KEY (company_id, quotation_id) REFERENCES quotation (company_id, id) ON DELETE CASCADE,
  UNIQUE (quotation_id, sort)
);

-- Each revision pushes the previous version here: rev, date, total, status and the full lines.
CREATE TABLE quotation_revision (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL,
  quotation_id uuid NOT NULL,
  revision     integer NOT NULL,
  status       text NOT NULL,
  quote_date   date NOT NULL,
  total        numeric(14,2) NOT NULL,
  snapshot     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  -- No cascade (BUG-082): a quote with history (revision > 0) is never deleted.
  FOREIGN KEY (company_id, quotation_id) REFERENCES quotation (company_id, id),
  UNIQUE (quotation_id, revision)
);
CREATE TRIGGER quotation_revision_immutable BEFORE UPDATE OR DELETE ON quotation_revision
  FOR EACH ROW EXECUTE FUNCTION refuse_change();

CREATE TABLE proforma (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES company(id),
  number          text NOT NULL,
  project_id      uuid NOT NULL,
  client_id       uuid NOT NULL,
  quotation_id    uuid,
  stage           text NOT NULL CHECK (length(trim(stage)) > 0),
  place_of_supply char(2) NOT NULL,
  pf_date         date NOT NULL,
  due_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'converted', 'cancelled')),
  invoice_id      uuid,
  converted_at    date,
  advance_journal_id uuid,
  taxable         numeric(14,2) NOT NULL,
  cgst            numeric(14,2) NOT NULL DEFAULT 0,
  sgst            numeric(14,2) NOT NULL DEFAULT 0,
  igst            numeric(14,2) NOT NULL DEFAULT 0,
  round_off       numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL CHECK (total > 0),
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  UNIQUE (company_id, number),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id)   REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, client_id)    REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, quotation_id) REFERENCES quotation (company_id, id),
  FOREIGN KEY (company_id, invoice_id)   REFERENCES invoice (company_id, id),
  FOREIGN KEY (company_id, advance_journal_id) REFERENCES journal (company_id, id),
  CHECK (due_date >= pf_date),
  CHECK ((status = 'converted') = (invoice_id IS NOT NULL AND converted_at IS NOT NULL)),
  CHECK (total = taxable + cgst + sgst + igst + round_off)
);
CREATE INDEX proforma_project ON proforma (company_id, project_id);
CREATE TRIGGER proforma_touch BEFORE UPDATE ON proforma FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER proforma_lock BEFORE INSERT OR DELETE ON proforma
  FOR EACH ROW EXECUTE FUNCTION document_lock_guard('pf_date');
-- Proformas are cancelled, never deleted (their number is in the gapless PI series).
CREATE TRIGGER proforma_no_delete BEFORE DELETE ON proforma FOR EACH ROW EXECUTE FUNCTION refuse_change();

CREATE TABLE proforma_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  proforma_id uuid NOT NULL,
  sort        smallint NOT NULL,
  description text NOT NULL CHECK (length(trim(description)) > 0),
  sac_hsn     text NOT NULL CHECK (sac_hsn ~ '^\d{4,8}$'),
  qty         numeric(12,3) NOT NULL CHECK (qty > 0),
  unit        text NOT NULL,
  rate        numeric(14,2) NOT NULL CHECK (rate >= 0),
  gst_rate    numeric(4,2) NOT NULL CHECK (gst_rate IN (0, 5, 12, 18, 28)),
  FOREIGN KEY (company_id, proforma_id) REFERENCES proforma (company_id, id) ON DELETE CASCADE,
  UNIQUE (proforma_id, sort)
);

-- Advances: a receipt allocated to a proforma (0004 left the FK for this migration).
ALTER TABLE receipt_allocation
  ADD CONSTRAINT receipt_allocation_proforma_fk FOREIGN KEY (company_id, proforma_id)
  REFERENCES proforma (company_id, id);
CREATE INDEX receipt_allocation_proforma ON receipt_allocation (proforma_id);
-- An advance applied to its tax invoice records both; before conversion only the proforma.
ALTER TABLE receipt_allocation
  ADD CONSTRAINT receipt_allocation_applied CHECK (applied_at IS NULL OR (proforma_id IS NOT NULL AND invoice_id IS NOT NULL));

-- Two allocation changes are lock-checked on the invoice, not on the receipt's own month, so an
-- advance received in a now-locked month still follows its proforma:
--  * apply (invoice_id + applied_at set on a row that had neither): the target invoice must be
--    the proforma's own, in an open period, and applied_at must be its date (BUG-083);
--  * un-apply (both cleared): only while the invoice is cancelled, whose credit note is dated
--    in an open period.
-- Any other change to an allocation still needs the receipt's month to be open.
CREATE OR REPLACE FUNCTION child_lock_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE v_date date; v_inv record;
BEGIN
  -- Nested IFs: PL/pgSQL may evaluate every operand, and invoice_line rows have no applied_at.
  IF TG_TABLE_NAME = 'receipt_allocation' AND TG_OP = 'UPDATE' THEN
    IF NEW.id = OLD.id AND NEW.company_id = OLD.company_id AND NEW.receipt_id = OLD.receipt_id
       AND NEW.proforma_id IS NOT DISTINCT FROM OLD.proforma_id AND NEW.amount = OLD.amount THEN
      IF OLD.invoice_id IS NULL AND OLD.applied_at IS NULL
         AND NEW.invoice_id IS NOT NULL AND NEW.applied_at IS NOT NULL THEN
        SELECT invoice_date, proforma_id INTO v_inv FROM invoice WHERE id = NEW.invoice_id;
        IF v_inv.proforma_id IS DISTINCT FROM NEW.proforma_id OR NEW.applied_at <> v_inv.invoice_date THEN
          RAISE EXCEPTION 'an advance can only be applied to its own proforma''s invoice, on its date'
            USING ERRCODE = 'CB422';
        END IF;
        PERFORM assert_not_locked(NEW.company_id, v_inv.invoice_date);
        RETURN NEW;
      END IF;
      IF OLD.invoice_id IS NOT NULL AND OLD.applied_at IS NOT NULL
         AND NEW.invoice_id IS NULL AND NEW.applied_at IS NULL THEN
        IF NOT EXISTS (SELECT 1 FROM invoice WHERE id = OLD.invoice_id AND status = 'cancelled') THEN
          RAISE EXCEPTION 'an advance can only be released from a cancelled invoice' USING ERRCODE = 'CB422';
        END IF;
        RETURN NEW;
      END IF;
    END IF;
  END IF;
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

-- Advances held against a proforma (live receipts only).
CREATE VIEW proforma_balance WITH (security_invoker = true) AS
SELECT p.id AS proforma_id,
       p.company_id,
       coalesce(sum(a.amount) FILTER (WHERE r.deleted_at IS NULL), 0)::numeric(14,2) AS advances,
       (p.total - coalesce(sum(a.amount) FILTER (WHERE r.deleted_at IS NULL), 0))::numeric(14,2) AS balance
  FROM proforma p
  LEFT JOIN receipt_allocation a ON a.proforma_id = p.id
  LEFT JOIN receipt r ON r.id = a.receipt_id
 GROUP BY p.id;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotation', 'quotation_line', 'quotation_revision', 'proforma', 'proforma_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) '
      'WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON quotation, quotation_line, proforma_line TO csd_app;
GRANT SELECT, INSERT, UPDATE ON proforma TO csd_app;
GRANT SELECT, INSERT ON quotation_revision TO csd_app;
GRANT SELECT ON proforma_balance TO csd_app;
