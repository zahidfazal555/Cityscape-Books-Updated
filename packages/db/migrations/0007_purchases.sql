-- 0007_purchases: purchase orders, purchase bills and vendor payments (Req §4.9, §4.10;
-- SPEC-FIXES A1, A2; ENGINEERING-STANDARDS H2).
-- A PO posts nothing. A bill posts Dr project cost (+ input GST when ITC-eligible) / Cr AP.
-- A vendor payment posts Dr AP / Cr bank (net of TDS) / Cr TDS payable, and only once approved.

-- ---------------------------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------------------------
CREATE TABLE purchase_order (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company(id),
  number        text NOT NULL,
  vendor_id     uuid NOT NULL,
  vendor_gstin  text,
  project_id    uuid NOT NULL,
  gst_rate      numeric(4,2) NOT NULL CHECK (gst_rate IN (0, 5, 12, 18, 28)),
  po_date       date NOT NULL,
  deliver_by    date,
  terms         text,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'cancelled')),
  taxable       numeric(14,2) NOT NULL CHECK (taxable > 0),
  total         numeric(14,2) NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  UNIQUE (company_id, number),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, vendor_id)  REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id),
  CHECK (deliver_by IS NULL OR deliver_by >= po_date),
  -- Unregistered vendor → no GST (FR-9.2).
  CHECK (vendor_gstin IS NOT NULL OR gst_rate = 0)
);
CREATE INDEX purchase_order_project ON purchase_order (company_id, project_id);
CREATE TRIGGER purchase_order_touch BEFORE UPDATE ON purchase_order
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE purchase_order_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  sort        smallint NOT NULL,
  description text NOT NULL CHECK (length(trim(description)) > 0),
  sac_hsn     text NOT NULL CHECK (sac_hsn ~ '^\d{4,8}$'),
  qty         numeric(12,3) NOT NULL CHECK (qty > 0),
  unit        text NOT NULL,
  rate        numeric(14,2) NOT NULL CHECK (rate >= 0),
  gst_rate    numeric(4,2) NOT NULL CHECK (gst_rate IN (0, 5, 12, 18, 28)),
  FOREIGN KEY (company_id, purchase_order_id) REFERENCES purchase_order (company_id, id) ON DELETE CASCADE,
  UNIQUE (purchase_order_id, sort)
);

-- ---------------------------------------------------------------------------------------------
-- Purchase bills
-- ---------------------------------------------------------------------------------------------
CREATE TABLE bill (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id),
  vendor_id           uuid NOT NULL,
  vendor_name         text NOT NULL,
  vendor_gstin        text,
  bill_no             text NOT NULL CHECK (length(trim(bill_no)) > 0),
  bill_date           date NOT NULL,
  due_date            date NOT NULL,
  project_id          uuid NOT NULL,
  category            text NOT NULL CHECK (category IN ('material', 'labour', 'subcontract', 'transport',
                        'fuel', 'misc', 'incentives', 'site_visit', 'rent')),
  purchase_order_id   uuid,
  gst_rate            numeric(4,2) NOT NULL CHECK (gst_rate IN (0, 5, 12, 18, 28)),
  is_inter_state      boolean NOT NULL,
  -- SPEC-FIXES A2: GST is input credit only for a registered vendor and an eligible purchase.
  itc_eligible        boolean NOT NULL,
  taxable             numeric(14,2) NOT NULL CHECK (taxable > 0),
  cgst                numeric(14,2) NOT NULL DEFAULT 0,
  sgst                numeric(14,2) NOT NULL DEFAULT 0,
  igst                numeric(14,2) NOT NULL DEFAULT 0,
  round_off           numeric(14,2) NOT NULL DEFAULT 0,
  total               numeric(14,2) NOT NULL CHECK (total > 0),
  notes               text,
  journal_id          uuid NOT NULL,
  deleted_at          timestamptz,
  deleted_by          uuid,
  reversal_journal_id uuid,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, vendor_id)  REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, purchase_order_id) REFERENCES purchase_order (company_id, id),
  FOREIGN KEY (company_id, journal_id) REFERENCES journal (company_id, id),
  FOREIGN KEY (company_id, reversal_journal_id) REFERENCES journal (company_id, id),
  CHECK (due_date >= bill_date),
  CHECK (total = taxable + cgst + sgst + igst + round_off),
  CHECK (vendor_gstin IS NOT NULL OR (gst_rate = 0 AND NOT itc_eligible)),
  CHECK ((deleted_at IS NULL) = (reversal_journal_id IS NULL))
);
-- A vendor's bill number is entered once (live bills only).
CREATE UNIQUE INDEX bill_vendor_no ON bill (company_id, vendor_id, lower(bill_no)) WHERE deleted_at IS NULL;
CREATE INDEX bill_project ON bill (company_id, project_id);
CREATE INDEX bill_po ON bill (purchase_order_id);
CREATE TRIGGER bill_touch BEFORE UPDATE ON bill FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER bill_lock BEFORE INSERT OR UPDATE OR DELETE ON bill
  FOR EACH ROW EXECUTE FUNCTION document_lock_guard('bill_date');
-- Bills are soft-deleted with a reversing journal.
CREATE TRIGGER bill_no_delete BEFORE DELETE ON bill FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- ---------------------------------------------------------------------------------------------
-- Vendor payments. H2: a non-owner's payment is Pending and posts nothing until approved.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE vendor_payment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id),
  bill_id             uuid NOT NULL,
  vendor_id           uuid NOT NULL,
  project_id          uuid NOT NULL,
  pay_date            date NOT NULL,
  -- Amount settled against the bill; the cash paid is amount − tds.
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  tds                 numeric(14,2) NOT NULL DEFAULT 0 CHECK (tds >= 0 AND tds < amount),
  mode                text NOT NULL CHECK (mode IN ('bank', 'upi', 'cash', 'cheque')),
  reference           text,
  paid_by             text,
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
  FOREIGN KEY (company_id, bill_id)    REFERENCES bill (company_id, id),
  FOREIGN KEY (company_id, vendor_id)  REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, journal_id) REFERENCES journal (company_id, id),
  FOREIGN KEY (company_id, reversal_journal_id) REFERENCES journal (company_id, id),
  CHECK (mode = 'cash' OR length(trim(coalesce(reference, ''))) > 0),
  -- Only an approved payment has a journal; pending and rejected ones post nothing.
  CHECK ((status = 'approved') = (journal_id IS NOT NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
  CHECK (deleted_at IS NULL OR status <> 'approved' OR reversal_journal_id IS NOT NULL)
);
CREATE INDEX vendor_payment_bill ON vendor_payment (bill_id);
CREATE INDEX vendor_payment_pending ON vendor_payment (company_id) WHERE status = 'pending' AND deleted_at IS NULL;
-- Like document_lock_guard, except that a payment which never posted (pending → rejected, or a
-- pending one withdrawn) may still be closed after its month is locked: it changes no books,
-- and otherwise it would hold the bill's balance for ever.
CREATE FUNCTION vendor_payment_lock_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status IN ('pending', 'rejected')
     AND NEW.journal_id IS NULL AND NEW.reversal_journal_id IS NULL
     AND (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'reject_reason', 'deleted_at', 'deleted_by'])
       = (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'reject_reason', 'deleted_at', 'deleted_by']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM assert_not_locked(OLD.company_id, OLD.pay_date); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM assert_not_locked(NEW.company_id, NEW.pay_date); END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER vendor_payment_lock BEFORE INSERT OR UPDATE OR DELETE ON vendor_payment
  FOR EACH ROW EXECUTE FUNCTION vendor_payment_lock_guard();
CREATE TRIGGER vendor_payment_no_delete BEFORE DELETE ON vendor_payment
  FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- Paid = approved live payments; pending = awaiting the owner. Balance excludes both from the
-- total so a bill can never be over-committed.
CREATE VIEW bill_balance WITH (security_invoker = true) AS
SELECT b.id AS bill_id,
       b.company_id,
       coalesce(sum(p.amount) FILTER (WHERE p.status = 'approved' AND p.deleted_at IS NULL), 0)::numeric(14,2) AS paid,
       coalesce(sum(p.amount) FILTER (WHERE p.status = 'pending' AND p.deleted_at IS NULL), 0)::numeric(14,2) AS pending,
       (b.total - coalesce(sum(p.amount) FILTER (WHERE p.status = 'approved' AND p.deleted_at IS NULL), 0))::numeric(14,2) AS balance
  FROM bill b
  LEFT JOIN vendor_payment p ON p.bill_id = b.id
 GROUP BY b.id;

-- Billed against a PO: taxable value of its live bills.
CREATE VIEW purchase_order_billed WITH (security_invoker = true) AS
SELECT o.id AS purchase_order_id,
       o.company_id,
       coalesce(sum(b.taxable) FILTER (WHERE b.deleted_at IS NULL), 0)::numeric(14,2) AS billed,
       count(b.id) FILTER (WHERE b.deleted_at IS NULL) AS bills
  FROM purchase_order o
  LEFT JOIN bill b ON b.purchase_order_id = o.id
 GROUP BY o.id;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_order', 'purchase_order_line', 'bill', 'vendor_payment']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) '
      'WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order, purchase_order_line TO csd_app;
GRANT SELECT, INSERT, UPDATE ON bill, vendor_payment TO csd_app;
GRANT SELECT ON bill_balance, purchase_order_billed TO csd_app;
