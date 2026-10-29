-- The AI run log's row-level security, checks, commit-time keys and append-only protection, and the
-- owner's new permissions (AI 1 plan, Task 2). The tables are created by 20261029162415_ai_runs.

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE ai_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_run FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_run_isolation ON ai_run
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
ALTER TABLE ai_run_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_run_result FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_run_result_isolation ON ai_run_result
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
ALTER TABLE ai_limit_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_limit_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_limit_notice_isolation ON ai_limit_notice
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE tenant ADD CONSTRAINT tenant_ai_monthly_limit_usd_check CHECK (ai_monthly_limit_usd >= 0);
ALTER TABLE ai_run ADD CONSTRAINT ai_run_kind_check CHECK (kind IN ('ask', 'briefing'));
ALTER TABLE ai_run_result ADD CONSTRAINT ai_run_result_status_check CHECK (status IN ('done', 'failed'));
ALTER TABLE ai_run_result ADD CONSTRAINT ai_run_result_tokens_check CHECK (input_tokens >= 0 AND output_tokens >= 0);
ALTER TABLE ai_run_result ADD CONSTRAINT ai_run_result_cost_check CHECK (cost_usd >= 0);
ALTER TABLE ai_limit_notice ADD CONSTRAINT ai_limit_notice_level_check CHECK (level IN (80, 100));
ALTER TABLE ai_limit_notice ADD CONSTRAINT ai_limit_notice_month_check CHECK (month ~ '^\d{4}-\d{2}$');

-- Deleting a workspace cascades into its runs, their results and its users in no fixed order. These
-- keys are checked at commit, when the whole cascade is done.
ALTER TABLE ai_run ALTER CONSTRAINT ai_run_tenant_id_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_run_result ALTER CONSTRAINT ai_run_result_tenant_id_run_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- Append-only (ADR 0003). The workspace's cascading delete is let through by forbid_mutation.
SELECT make_append_only('ai_run');
SELECT make_append_only('ai_run_result');

-- Every existing workspace's owner role gets the three new permissions; new workspaces get them from
-- SYSTEM_ROLES.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t.id::text, true);
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, p.permission
    FROM role r
    CROSS JOIN (VALUES ('report.read'), ('ai.use'), ('knowledge.write')) AS p(permission)
    WHERE r.is_system AND r.name = 'owner'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;
