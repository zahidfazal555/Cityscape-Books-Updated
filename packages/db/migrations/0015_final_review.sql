-- 0015_final_review: database backstops from the final whole-codebase review.

-- BUG-194: a posting and a lock-date change could interleave. A posting checked the lock (not
-- locked), the Owner then locked the period and committed, and the posting committed a journal
-- inside the now-locked period. The check now takes a share lock on the company row: a lock-date
-- change waits for postings in flight, and a posting after it reads the new date. (FOR SHARE is
-- not allowed in a STABLE function, hence VOLATILE.)
CREATE OR REPLACE FUNCTION assert_not_locked(p_company uuid, p_date date) RETURNS void
  LANGUAGE plpgsql VOLATILE AS
$$
DECLARE v_lock date;
BEGIN
  SELECT lock_date INTO v_lock FROM company WHERE id = p_company FOR SHARE;
  IF v_lock IS NOT NULL AND p_date <= v_lock THEN
    RAISE EXCEPTION 'Books are locked till %. Pick a later date.', to_char(v_lock, 'DD Mon YYYY')
      USING ERRCODE = 'CB423';
  END IF;
END
$$;

-- BUG-195: least privilege. Sessions are revoked (their device and IP history feeds the new
-- sign-in alert), masters are deactivated and receipts keep their allocations: the app never
-- deletes these rows, so the app role cannot.
REVOKE DELETE ON session, contact, project, account, receipt_allocation FROM csd_app;

-- BUG-196: foreign keys are checked without row-level security, so a key on `id` alone would let
-- a row in one company point at a row in another. These three now include company_id, like every
-- other child table.
ALTER TABLE journal_line ADD CONSTRAINT journal_line_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE session ADD CONSTRAINT session_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE receipt_allocation
  ADD CONSTRAINT receipt_allocation_company_id_id_key UNIQUE (company_id, id);

ALTER TABLE bank_match DROP CONSTRAINT bank_match_journal_line_id_fkey,
  ADD FOREIGN KEY (company_id, journal_line_id) REFERENCES journal_line (company_id, id);
ALTER TABLE advance_event DROP CONSTRAINT advance_event_allocation_id_fkey,
  ADD FOREIGN KEY (company_id, allocation_id) REFERENCES receipt_allocation (company_id, id);
ALTER TABLE session_rotated DROP CONSTRAINT session_rotated_session_id_fkey,
  ADD FOREIGN KEY (company_id, session_id) REFERENCES session (company_id, id);

-- BUG-197: the 40% slab in force from 22 Sep 2025. 12% and 28% stay valid for earlier documents
-- and their credit notes.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'c' AND c.conname LIKE '%gst_rate_check'
       AND pg_get_constraintdef(c.oid) LIKE '%12%28%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK (gst_rate IN (0, 5, 12, 18, 28, 40))',
      r.tbl, r.conname);
  END LOOP;
END
$$;
