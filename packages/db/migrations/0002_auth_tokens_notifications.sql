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

-- Reads a token without consuming it, so the new password can be validated first (a rejected
-- password must not burn the link).
CREATE FUNCTION auth_peek_token(p_token_hash text, p_purpose text)
  RETURNS TABLE (user_id uuid, company_id uuid, email citext, name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  RETURN QUERY
    SELECT t.user_id, t.company_id, u.email, u.name
      FROM auth_token t JOIN app_user u ON u.id = t.user_id
     WHERE t.token_hash = p_token_hash AND t.purpose = p_purpose
       AND t.used_at IS NULL AND t.expires_at > now() AND u.is_active;
  PERFORM set_config('app.auth_lookup', '', true);
END
$$;

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

ALTER TABLE session ADD COLUMN device_id text;   -- long-lived random cookie: "new device" alerts

-- Every refresh token ever rotated out, so a replay of ANY old token is detected, not just the
-- last one. Rows are kept for the session's lifetime (sessions last at most 7 days, no sliding).
CREATE TABLE session_rotated (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES session(id),
  company_id uuid NOT NULL,
  user_id    uuid NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_rotated_session ON session_rotated (session_id, rotated_at DESC);
ALTER TABLE session_rotated ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_rotated FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON session_rotated
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY auth_lookup ON session_rotated TO CURRENT_USER
  USING (current_setting('app.auth_lookup', true) = 'on');
GRANT SELECT, INSERT ON session_rotated TO csd_app;

-- A presented token that was already rotated out. If it is the session's latest rotation and
-- under 60 seconds old, it is a benign race (two tabs, a retried request): returns 'race' and
-- revokes nothing. Otherwise it is a replay of a stolen token: every session of the user is
-- revoked and 'reuse' is returned.
CREATE FUNCTION auth_detect_reuse(p_token_hash text)
  RETURNS TABLE (verdict text, user_id uuid, company_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE r session_rotated%ROWTYPE; v_latest boolean;
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  SELECT * INTO r FROM session_rotated WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN
    PERFORM set_config('app.auth_lookup', '', true);
    RETURN;
  END IF;
  SELECT NOT EXISTS (SELECT 1 FROM session_rotated x
                      WHERE x.session_id = r.session_id AND x.rotated_at > r.rotated_at)
    INTO v_latest;
  IF v_latest AND r.rotated_at > now() - interval '60 seconds' THEN
    verdict := 'race';
  ELSE
    UPDATE session SET revoked_at = now() WHERE session.user_id = r.user_id AND revoked_at IS NULL;
    verdict := 'reuse';
  END IF;
  user_id := r.user_id;
  company_id := r.company_id;
  PERFORM set_config('app.auth_lookup', '', true);
  RETURN NEXT;
END
$$;

-- The session lookup policy from 0001 only covers SELECT; reuse detection also revokes.
DROP POLICY auth_lookup ON session;
CREATE POLICY auth_lookup ON session TO CURRENT_USER
  USING (current_setting('app.auth_lookup', true) = 'on')
  WITH CHECK (current_setting('app.auth_lookup', true) = 'on');

-- Sign-in attempts for one user are serialised: the app opens a transaction, calls this
-- (row lock held until COMMIT), verifies the password, then records success or failure in the
-- same transaction. Concurrent guesses therefore can never exceed the 5-failure limit.
CREATE FUNCTION auth_begin_attempt(p_email citext)
  RETURNS TABLE (id uuid, company_id uuid, email citext, name text, password_hash text, role text,
                 is_active boolean, access_expires_at timestamptz, locked boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  RETURN QUERY
    SELECT u.id, u.company_id, u.email, u.name, u.password_hash, u.role, u.is_active,
           u.access_expires_at, coalesce(u.locked_until > now(), false)
      FROM app_user u WHERE u.email = p_email
       FOR UPDATE;
  PERFORM set_config('app.auth_lookup', '', true);
END
$$;

-- Clears the failure count after a correct password, unless the account is locked.
-- Returns false when locked (the caller must refuse the sign-in).
CREATE FUNCTION auth_record_success(p_user uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_ok boolean;
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  UPDATE app_user SET failed_attempts = 0, last_login_at = now()
   WHERE id = p_user AND (locked_until IS NULL OR locked_until <= now());
  v_ok := FOUND;
  PERFORM set_config('app.auth_lookup', '', true);
  RETURN v_ok;
END
$$;

REVOKE ALL ON FUNCTION auth_consume_token(text, text), auth_detect_reuse(text), auth_peek_token(text, text),
  auth_begin_attempt(citext), auth_record_success(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_consume_token(text, text), auth_detect_reuse(text), auth_peek_token(text, text),
  auth_begin_attempt(citext), auth_record_success(uuid) TO csd_app;

-- 0001's auth_record_failure inferred "just locked" from timestamps. Replace it so the database
-- reports the transition itself (no clock-skew guessing, one lockout per burst).
DROP FUNCTION auth_record_failure(uuid);
CREATE FUNCTION auth_record_failure(p_user uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_locked boolean;
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  UPDATE app_user
     SET failed_attempts = CASE WHEN failed_attempts + 1 >= 5 THEN 0 ELSE failed_attempts + 1 END,
         locked_until    = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes'
                                ELSE locked_until END
   WHERE id = p_user AND (locked_until IS NULL OR locked_until <= now())
  RETURNING locked_until > now() INTO v_locked;
  PERFORM set_config('app.auth_lookup', '', true);
  RETURN coalesce(v_locked, false);
END
$$;
REVOKE ALL ON FUNCTION auth_record_failure(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_record_failure(uuid) TO csd_app;

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
CREATE FUNCTION auth_notify_owner_lockout(p_user uuid, p_ip inet) RETURNS void
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
  INSERT INTO audit_log (company_id, user_id, ip, action, entity, entity_id, outcome)
  SELECT company_id, id, p_ip, 'lockout', 'user', id::text, 'denied' FROM app_user WHERE id = p_user;
  PERFORM set_config('app.company_id', '', true);
  PERFORM set_config('app.auth_lookup', '', true);
END
$$;
REVOKE ALL ON FUNCTION auth_notify_owner_lockout(uuid, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_notify_owner_lockout(uuid, inet) TO csd_app;
