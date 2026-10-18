-- 0013_support: service desk tickets, site visits with photos, reply templates and the knowledge
-- base (Req §4.19–4.21, Technical Spec §14). Tickets are never deleted (ENGINEERING-STANDARDS §4).

CREATE TABLE ticket (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES company(id),
  number             text NOT NULL,
  project_id         uuid NOT NULL,
  type               text NOT NULL CHECK (type IN ('snag', 'warranty', 'service', 'amc', 'billing', 'change')),
  subject            text NOT NULL CHECK (length(trim(subject)) > 0),
  description        text,
  priority           text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status             text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'in_progress', 'awaiting_client', 'visit_scheduled', 'resolved', 'closed')),
  channel            text NOT NULL CHECK (channel IN ('phone', 'walk_in', 'whatsapp', 'email', 'site_visit')),
  -- Personal data: anonymised 3 years after closure (§9 retention).
  caller_name        text,
  caller_phone       text CHECK (caller_phone IS NULL OR caller_phone ~ '^[6-9]\d{9}$'),
  assignee_id        uuid,
  -- Decided when logged and never recomputed (Technical Spec §14).
  coverage           text NOT NULL CHECK (coverage IN ('warranty', 'amc', 'contract', 'chargeable', 'na')),
  chargeable         boolean NOT NULL,
  first_response_at  timestamptz,
  resolved_at        timestamptz,
  closed_at          timestamptz,
  rating             smallint CHECK (rating BETWEEN 1 AND 5),
  rating_comment     text,
  rating_by          uuid,
  rating_at          timestamptz,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  -- FR-19.4, calendar hours by priority; set by ticket_sla_due (timestamptz + interval is not
  -- immutable, so these cannot be generated columns).
  resp_due           timestamptz NOT NULL,
  resolve_due        timestamptz NOT NULL,
  UNIQUE (company_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (company_id, project_id)  REFERENCES project (company_id, id),
  FOREIGN KEY (company_id, assignee_id) REFERENCES app_user (company_id, id),
  CHECK ((rating IS NULL) = (rating_at IS NULL)),
  CHECK (rating IS NULL OR status IN ('resolved', 'closed')),
  CHECK (status NOT IN ('resolved', 'closed') OR resolved_at IS NOT NULL),
  CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);
CREATE INDEX ticket_queue ON ticket (company_id, status, priority, created_at);
CREATE INDEX ticket_project ON ticket (company_id, project_id);
CREATE FUNCTION ticket_sla_due() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  NEW.resp_due := NEW.created_at + CASE NEW.priority
    WHEN 'urgent' THEN interval '1 hour' WHEN 'high' THEN interval '4 hours'
    WHEN 'normal' THEN interval '8 hours' ELSE interval '24 hours' END;
  NEW.resolve_due := NEW.created_at + CASE NEW.priority
    WHEN 'urgent' THEN interval '4 hours' WHEN 'high' THEN interval '24 hours'
    WHEN 'normal' THEN interval '72 hours' ELSE interval '168 hours' END;
  RETURN NEW;
END
$$;
CREATE TRIGGER ticket_sla BEFORE INSERT OR UPDATE OF priority, created_at ON ticket
  FOR EACH ROW EXECUTE FUNCTION ticket_sla_due();
CREATE TRIGGER ticket_touch BEFORE UPDATE ON ticket FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER ticket_no_delete BEFORE DELETE ON ticket FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- Append-only activity thread.
CREATE TABLE ticket_event (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  ticket_id  uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('system', 'reply', 'call', 'note')),
  body       text NOT NULL CHECK (length(trim(body)) > 0),
  author_id  uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Events written in one transaction share now(); the thread is ordered by this (BUG-162).
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  FOREIGN KEY (company_id, ticket_id) REFERENCES ticket (company_id, id)
);
CREATE INDEX ticket_event_ticket ON ticket_event (ticket_id, created_at);
CREATE TRIGGER ticket_event_immutable BEFORE UPDATE OR DELETE ON ticket_event
  FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- Expenses from a visit (B10 source 'visit'), and service quotations and invoices, name the ticket.
ALTER TABLE expense ADD COLUMN ticket_id uuid;
ALTER TABLE expense ADD FOREIGN KEY (company_id, ticket_id) REFERENCES ticket (company_id, id);
ALTER TABLE quotation ADD COLUMN ticket_id uuid;
ALTER TABLE quotation ADD FOREIGN KEY (company_id, ticket_id) REFERENCES ticket (company_id, id);
ALTER TABLE invoice ADD COLUMN ticket_id uuid;
ALTER TABLE invoice ADD FOREIGN KEY (company_id, ticket_id) REFERENCES ticket (company_id, id);
CREATE INDEX expense_ticket ON expense (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX quotation_ticket ON quotation (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX invoice_ticket ON invoice (ticket_id) WHERE ticket_id IS NOT NULL;

CREATE TABLE site_visit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES company(id),
  ticket_id    uuid NOT NULL,
  visit_date   date NOT NULL,
  slot         text NOT NULL CHECK (slot IN ('morning', 'afternoon', 'evening')),
  engineer_id  uuid NOT NULL,
  instructions text,
  status       text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  work_done    text,
  cost         numeric(14,2) CHECK (cost IS NULL OR cost > 0),
  expense_id   uuid,
  completed_at timestamptz,
  completed_by uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, ticket_id)   REFERENCES ticket (company_id, id),
  FOREIGN KEY (company_id, engineer_id) REFERENCES app_user (company_id, id),
  FOREIGN KEY (company_id, expense_id)  REFERENCES expense (company_id, id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (status <> 'completed' OR length(trim(coalesce(work_done, ''))) > 0),
  CHECK ((cost IS NULL) = (expense_id IS NULL))
);
CREATE INDEX site_visit_ticket ON site_visit (ticket_id);
CREATE INDEX site_visit_engineer ON site_visit (company_id, engineer_id, status, visit_date);
CREATE TRIGGER site_visit_no_delete BEFORE DELETE ON site_visit FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- Before and after photos (private attachments, EXIF stripped, re-encoded on upload).
CREATE TABLE visit_photo (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company(id),
  visit_id      uuid NOT NULL,
  attachment_id uuid NOT NULL UNIQUE,
  phase         text NOT NULL CHECK (phase IN ('before', 'after')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, visit_id)      REFERENCES site_visit (company_id, id),
  FOREIGN KEY (company_id, attachment_id) REFERENCES attachment (company_id, id)
);
CREATE INDEX visit_photo_visit ON visit_photo (visit_id);
CREATE TRIGGER visit_photo_immutable BEFORE UPDATE OR DELETE ON visit_photo
  FOR EACH ROW EXECUTE FUNCTION refuse_change();

CREATE TABLE reply_template (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  title      text NOT NULL CHECK (length(trim(title)) > 0),
  body       text NOT NULL CHECK (length(trim(body)) > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
CREATE TRIGGER reply_template_touch BEFORE UPDATE ON reply_template FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE kb_article (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  title      text NOT NULL CHECK (length(trim(title)) > 0),
  category   text NOT NULL CHECK (category IN ('care', 'warranty', 'howto', 'checklist')),
  body       text NOT NULL CHECK (length(trim(body)) > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
CREATE TRIGGER kb_article_touch BEFORE UPDATE ON kb_article FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket', 'ticket_event', 'site_visit', 'visit_photo', 'reply_template', 'kb_article']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) '
      'WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON ticket, site_visit, reply_template, kb_article TO csd_app;
GRANT SELECT, INSERT ON ticket_event, visit_photo TO csd_app;
