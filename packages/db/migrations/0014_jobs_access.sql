-- 0014_jobs_access: scheduled jobs (docs/GO-LIVE.md §5) must see every company without a
-- superuser or BYPASSRLS role (BUG-173). Like auth_find_user (0001), a SECURITY DEFINER function
-- owned by the migration role turns on a narrow policy for one read: the company list and each
-- company's Owner. All per-company work then runs as csd_app inside that company's tenant.

CREATE POLICY jobs_lookup ON company FOR SELECT TO CURRENT_USER
  USING (current_setting('app.jobs_lookup', true) = 'on');

CREATE FUNCTION jobs_companies()
  RETURNS TABLE (id uuid, name text, owner_id uuid, owner_active boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  PERFORM set_config('app.jobs_lookup', 'on', true);
  PERFORM set_config('app.auth_lookup', 'on', true);
  RETURN QUERY
    SELECT c.id, c.name, o.id, o.is_active
      FROM company c
      LEFT JOIN LATERAL (
        SELECT u.id, u.is_active FROM app_user u
         WHERE u.company_id = c.id AND u.role = 'owner' ORDER BY u.created_at LIMIT 1) o ON true
     ORDER BY c.name;
  PERFORM set_config('app.jobs_lookup', 'off', true);
  PERFORM set_config('app.auth_lookup', 'off', true);
END
$$;

REVOKE ALL ON FUNCTION jobs_companies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_companies() TO csd_app;
