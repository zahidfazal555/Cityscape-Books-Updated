-- 0003_project_client_index: client lists count projects per client; project lists sort newest first.
CREATE INDEX project_client ON project (company_id, client_id);
CREATE INDEX project_created ON project (company_id, created_at DESC);
