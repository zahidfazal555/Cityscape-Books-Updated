-- 0004_sales_invoices_receipts: tax invoices, credit notes, client receipts and allocations.
-- Every document posts through the journal (0001). Invoices are never deleted: they are
-- cancelled with a credit note (FR-3.3.4). The lock date guards every document table.

-- ---------------------------------------------------------------------------------------------
-- Generic lock-date guard for dated documents: refuses INSERT/UPDATE/DELETE when the old or
-- new document date is on or before the company's lock date (FR-3.3.1). TG_ARGV[0] names the
-- date column.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION document_lock_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE v_col text := TG_ARGV[0];
BEGIN
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
-- Tax invoices
-- ---------------------------------------------------------------------------------------------
CREATE TABLE invoice (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES company(id),
  number            text NOT NULL,
  fy                text NOT NULL,
  project_id        uuid NOT NULL,
  client_id         uuid NOT NULL,
  -- Bill-to snapshot as issued: later edits to the contact never change a tax document.
  client_name       text NOT NULL,
  client_gstin      text,
  client_address    text,
  place_of_supply   char(2) NOT NULL,
  is_inter_state    boolean NOT NULL,
  invoice_date      date NOT NULL,
  due_date          date NOT NULL,
  subtotal          numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  discount          numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  taxable           numeric(14,2) NOT NULL CHECK (taxable >= 0),
  cgst              numeric(14,2) NOT NULL DEFAULT 0 CHECK (cgst >= 0),
  sgst              numeric(14,2) NOT NULL DEFAULT 0 CHECK (sgst >= 0),
  igst              numeric(14,2) NOT NULL DEFAULT 0 CHECK (igst >= 0),
  round_off         numeric(14,2) NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -0.50 AND 0.50),
  total             numeric(14,2) NOT NULL CHECK (total >= 0),
  notes             text,
  status            text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'cancelled')),
  journal_id        uuid NOT NULL,
  quotation_id      uuid,
  proforma_id       uuid,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  UNIQUE (company_id, number),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, client_id)  REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, journal_id) REFERENCES journal (company_id, id),
  CHECK (due_date >= invoice_date),
  CHECK ((is_inter_state AND cgst = 0 AND sgst = 0) OR (NOT is_inter_state AND igst = 0)),
  CHECK (total = taxable + cgst + sgst + igst + round_off)
);
CREATE INDEX invoice_project ON invoice (company_id, project_id);
CREATE INDEX invoice_client_status ON invoice (company_id, client_id, status);
CREATE INDEX invoice_date ON invoice (company_id, invoice_date);
CREATE TRIGGER invoice_touch BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
-- Like document_lock_guard, with one exception: an invoice in a locked period may still be
-- cancelled (issued → cancelled, nothing else changing), because its credit note is dated in an
-- open period (README "Credit notes": a later-month credit note reduces that later month).
CREATE FUNCTION invoice_lock_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'issued' AND NEW.status = 'cancelled'
     AND (to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at', 'updated_by'])
       = (to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at', 'updated_by']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM assert_not_locked(OLD.company_id, OLD.invoice_date); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM assert_not_locked(NEW.company_id, NEW.invoice_date); END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER invoice_lock BEFORE INSERT OR UPDATE OR DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_lock_guard();
-- Never deleted (FR-3.3.4), for any role.
CREATE TRIGGER invoice_no_delete BEFORE DELETE ON invoice FOR EACH ROW EXECUTE FUNCTION refuse_change();

CREATE TABLE invoice_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  invoice_id  uuid NOT NULL,
  sort        smallint NOT NULL,
  description text NOT NULL CHECK (length(trim(description)) > 0),
  sac_hsn     text NOT NULL CHECK (sac_hsn ~ '^\d{4,8}$'),
  qty         numeric(12,3) NOT NULL CHECK (qty > 0),
  unit        text NOT NULL,
  rate        numeric(14,2) NOT NULL CHECK (rate >= 0),
  gst_rate    numeric(4,2) NOT NULL CHECK (gst_rate IN (0, 5, 12, 18, 28)),
  amount      numeric(14,2) NOT NULL,
  discount    numeric(14,2) NOT NULL DEFAULT 0,
  taxable     numeric(14,2) NOT NULL,
  cgst        numeric(14,2) NOT NULL DEFAULT 0,
  sgst        numeric(14,2) NOT NULL DEFAULT 0,
  igst        numeric(14,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoice (company_id, id) ON DELETE CASCADE,
  UNIQUE (invoice_id, sort),
  CHECK (taxable = amount - discount)
);

-- ---------------------------------------------------------------------------------------------
-- Credit notes: one per cancelled invoice, CN/26-27/#### (gapless).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE credit_note (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company(id),
  number      text NOT NULL,
  invoice_id  uuid NOT NULL,
  cn_date     date NOT NULL,
  reason      text NOT NULL CHECK (length(trim(reason)) > 0),
  taxable     numeric(14,2) NOT NULL,
  cgst        numeric(14,2) NOT NULL,
  sgst        numeric(14,2) NOT NULL,
  igst        numeric(14,2) NOT NULL,
  round_off   numeric(14,2) NOT NULL,
  total       numeric(14,2) NOT NULL,
  journal_id  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (company_id, number),
  UNIQUE (invoice_id),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoice (company_id, id),
  FOREIGN KEY (company_id, journal_id) REFERENCES journal (company_id, id)
);
CREATE TRIGGER credit_note_lock BEFORE INSERT OR UPDATE OR DELETE ON credit_note
  FOR EACH ROW EXECUTE FUNCTION document_lock_guard('cn_date');
CREATE TRIGGER credit_note_immutable BEFORE UPDATE OR DELETE ON credit_note
  FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- ---------------------------------------------------------------------------------------------
-- Client receipts and their allocation to invoices (or, from 0005, proformas). SPEC-FIXES A4.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE receipt (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES company(id),
  number             text NOT NULL,
  receipt_date       date NOT NULL,
  client_id          uuid NOT NULL,
  project_id         uuid NOT NULL,
  amount             numeric(14,2) NOT NULL CHECK (amount > 0),
  mode               text NOT NULL CHECK (mode IN ('bank', 'upi', 'cash', 'cheque')),
  reference          text,
  received_by        text,
  account_code       text NOT NULL CHECK (account_code IN ('1000', '1010', '1020')),
  journal_id         uuid NOT NULL,
  deleted_at         timestamptz,
  deleted_by         uuid,
  reversal_journal_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  UNIQUE (company_id, number),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, client_id)  REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, journal_id) REFERENCES journal (company_id, id),
  FOREIGN KEY (company_id, reversal_journal_id) REFERENCES journal (company_id, id),
  CHECK (mode = 'cash' OR length(trim(coalesce(reference, ''))) > 0),
  CHECK ((deleted_at IS NULL) = (reversal_journal_id IS NULL))
);
CREATE INDEX receipt_project ON receipt (company_id, project_id);
CREATE TRIGGER receipt_lock BEFORE INSERT OR UPDATE OR DELETE ON receipt
  FOR EACH ROW EXECUTE FUNCTION document_lock_guard('receipt_date');
-- Receipts are soft-deleted with a reversing journal; the row itself stays.
CREATE TRIGGER receipt_no_delete BEFORE DELETE ON receipt FOR EACH ROW EXECUTE FUNCTION refuse_change();

CREATE TABLE receipt_allocation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  receipt_id  uuid NOT NULL,
  invoice_id  uuid,
  proforma_id uuid,           -- FK added in 0005
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  applied_at  date,           -- set when a proforma advance is applied to its tax invoice
  FOREIGN KEY (company_id, receipt_id) REFERENCES receipt (company_id, id),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoice (company_id, id),
  CHECK (invoice_id IS NOT NULL OR proforma_id IS NOT NULL)
);
CREATE INDEX receipt_allocation_invoice ON receipt_allocation (invoice_id);
CREATE INDEX receipt_allocation_receipt ON receipt_allocation (receipt_id);

-- Child rows inherit their parent document's lock: an invoice line or an allocation cannot be
-- changed on its own to alter a locked document.
CREATE FUNCTION child_lock_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE v_row record; v_date date;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_TABLE_NAME = 'invoice_line' THEN
    SELECT invoice_date INTO v_date FROM invoice WHERE id = v_row.invoice_id;
  ELSE
    SELECT receipt_date INTO v_date FROM receipt WHERE id = v_row.receipt_id;
  END IF;
  PERFORM assert_not_locked(v_row.company_id, v_date);
  RETURN v_row;
END
$$;
CREATE TRIGGER invoice_line_lock BEFORE INSERT OR UPDATE OR DELETE ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION child_lock_guard();
CREATE TRIGGER receipt_allocation_lock BEFORE INSERT OR UPDATE OR DELETE ON receipt_allocation
  FOR EACH ROW EXECUTE FUNCTION child_lock_guard();

-- Balance due per invoice: total − live receipts allocated; a cancelled invoice owes nothing.
CREATE VIEW invoice_balance WITH (security_invoker = true) AS
SELECT i.id AS invoice_id,
       i.company_id,
       coalesce(sum(a.amount) FILTER (WHERE r.deleted_at IS NULL), 0)::numeric(14,2) AS received,
       CASE WHEN i.status = 'cancelled' THEN 0
            ELSE i.total - coalesce(sum(a.amount) FILTER (WHERE r.deleted_at IS NULL), 0)
       END::numeric(14,2) AS balance
  FROM invoice i
  LEFT JOIN receipt_allocation a ON a.invoice_id = i.id
  LEFT JOIN receipt r ON r.id = a.receipt_id
 GROUP BY i.id;

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice', 'invoice_line', 'credit_note', 'receipt', 'receipt_allocation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) '
      'WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON invoice, receipt TO csd_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_line, receipt_allocation TO csd_app;
GRANT SELECT, INSERT ON credit_note TO csd_app;
GRANT SELECT ON invoice_balance TO csd_app;
