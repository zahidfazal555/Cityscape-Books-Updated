-- 0002_auth_tokens_notifications: invite / password-reset tokens, refresh-token reuse
-- detection, and in-app notifications (Tech Spec §4, §7).

-- ---------------------------------------------------------------------------------------------
-- Single-use email tokens (invite and password reset), 24-hour expiry. Only the SHA-256 of
-- the token is stored.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE auth_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('invite', 'reset')),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  FOREIGN KEY (company_id, user_id) REFERENCES app_user (company_id, id),
  CHECK (expires_at <= created_at + interval '24 hours')
);
CREATE INDEX auth_token_user ON auth_token (user_id) WHERE used_at IS NULL;

ALTER TABLE auth_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_token FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON auth_token
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY auth_lookup ON auth_token TO CURRENT_USER
  USING (current_setting('app.auth_lookup', true) = 'on')
  WITH CHECK (current_setting('app.auth_lookup', true) = 'on');
GRANT SELECT, INSERT, UPDATE ON auth_token TO csd_app;

-- Consumes a token atomically: returns its user only if it is unused, unexpired and the
-- user is active, and marks it used in the same statement (single use, race-free).
CREATE FUNCTION auth_consume_token(p_token_hash text, p_purpose text)
  RETURNS TABLE (user_id uuid, company_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  RETURN QUERY
    UPDATE auth_token t SET used_at = now()
     WHERE t.token_hash = p_token_hash AND t.purpose = p_purpose
       AND t.used_at IS NULL AND t.expires_at > now()
       AND EXISTS (SELECT 1 FROM app_user u WHERE u.id = t.user_id AND u.is_active)
    RETURNING t.user_id, t.company_id;
  PERFORM set_config('app.auth_lookup', '', true);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Refresh-token rotation with reuse detection: presenting an already-rotated token means it
-- was stolen, so every session of that user is revoked.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE session ADD COLUMN previous_token_hash text UNIQUE;

CREATE FUNCTION auth_detect_reuse(p_token_hash text)
  RETURNS TABLE (user_id uuid, company_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  RETURN QUERY
    UPDATE session s SET revoked_at = now()
     WHERE s.user_id IN (SELECT r.user_id FROM session r WHERE r.previous_token_hash = p_token_hash)
       AND s.revoked_at IS NULL
    RETURNING s.user_id, s.company_id;
  PERFORM set_config('app.auth_lookup', '', true);
END
$$;

-- The session lookup policy from 0001 only covers SELECT; reuse detection also revokes.
DROP POLICY auth_lookup ON session;
CREATE POLICY auth_lookup ON session TO CURRENT_USER
  USING (current_setting('app.auth_lookup', true) = 'on')
  WITH CHECK (current_setting('app.auth_lookup', true) = 'on');

REVOKE ALL ON FUNCTION auth_consume_token(text, text), auth_detect_reuse(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_consume_token(text, text), auth_detect_reuse(text) TO csd_app;

-- ---------------------------------------------------------------------------------------------
-- In-app notifications (v1 is in-app only). Each has a stable key per user, so the same
-- event is never notified twice.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE notification (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  user_id    uuid NOT NULL,
  key        text NOT NULL,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  FOREIGN KEY (company_id, user_id) REFERENCES app_user (company_id, id),
  UNIQUE (user_id, key)
);
CREATE INDEX notification_unread ON notification (user_id, created_at DESC) WHERE read_at IS NULL;

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON notification
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON notification TO csd_app;

-- Lockouts happen before a tenant context exists; this notifies the company's owner.
CREATE FUNCTION auth_notify_owner_lockout(p_user uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  PERFORM set_config('app.company_id', (SELECT company_id::text FROM app_user WHERE id = p_user), true);
  INSERT INTO notification (company_id, user_id, key, type, title, body, link)
  SELECT u.company_id, o.id,
         'lockout:' || u.id || ':' || to_char(now(), 'YYYYMMDDHH24MI'),
         'security', 'Account locked after 5 failed sign-ins',
         u.name || ' (' || u.email || ') is locked for 15 minutes.', '/settings/users'
    FROM app_user u JOIN app_user o ON o.company_id = u.company_id AND o.role = 'owner'
   WHERE u.id = p_user
  ON CONFLICT (user_id, key) DO NOTHING;
  INSERT INTO audit_log (company_id, user_id, action, entity, entity_id, outcome)
  SELECT company_id, id, 'lockout', 'user', id::text, 'denied' FROM app_user WHERE id = p_user;
  PERFORM set_config('app.company_id', '', true);
  PERFORM set_config('app.auth_lookup', '', true);
END
$$;
REVOKE ALL ON FUNCTION auth_notify_owner_lockout(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_notify_owner_lockout(uuid) TO csd_app;
