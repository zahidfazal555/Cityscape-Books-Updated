-- 0011_advance_events: dated history of each proforma advance being applied to its tax invoice
-- and released again (when that invoice is cancelled). GST Table 11A/11B for any month is
-- derived from this history, so a filed month never changes when a later document does.
CREATE TABLE advance_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company(id),
  allocation_id uuid NOT NULL REFERENCES receipt_allocation (id),
  kind          text NOT NULL CHECK (kind IN ('applied', 'released')),
  event_date    date NOT NULL,
  invoice_id    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX advance_event_allocation ON advance_event (allocation_id);
CREATE TRIGGER advance_event_immutable BEFORE UPDATE OR DELETE ON advance_event
  FOR EACH ROW EXECUTE FUNCTION refuse_change();
ALTER TABLE advance_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE advance_event FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON advance_event USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON advance_event TO csd_app;

-- Advances already applied before this migration.
INSERT INTO advance_event (company_id, allocation_id, kind, event_date, invoice_id)
SELECT company_id, id, 'applied', applied_at, invoice_id FROM receipt_allocation WHERE applied_at IS NOT NULL;
