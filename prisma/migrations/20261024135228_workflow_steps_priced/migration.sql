-- A workflow step keeps whether its step type was priced when the version was made, so changing the
-- step type later can't reroute pieces already running on the version.

-- AlterTable
ALTER TABLE "workflow_step" ADD COLUMN     "priced" BOOLEAN;

-- Existing steps take their step type's current flag. Row-level security is forced even for the table
-- owner, so each tenant is set in turn, as inTenant does.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);
    UPDATE workflow_step ws
    SET priced = (st.summary_group IS NOT NULL)
    FROM step_type st
    WHERE st.tenant_id = ws.tenant_id AND st.id = ws.step_type_id;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;

ALTER TABLE "workflow_step" ALTER COLUMN "priced" SET NOT NULL;
