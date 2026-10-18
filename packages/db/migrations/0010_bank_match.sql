-- 0010_bank_match: statement-match ticks on cash, bank and UPI register lines (Req FR-13.2).
-- A tick is bookkeeping about the statement, not a posting: it never changes the journal.
CREATE TABLE bank_match (
  journal_line_id uuid PRIMARY KEY REFERENCES journal_line (id),
  company_id      uuid NOT NULL REFERENCES company(id),
  matched_by      uuid NOT NULL,
  matched_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bank_match ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_match FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON bank_match USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, DELETE ON bank_match TO csd_app;
