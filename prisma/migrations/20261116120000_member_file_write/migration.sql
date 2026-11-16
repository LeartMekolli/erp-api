-- Members may upload files, so staff can take a customer's model and quote and order for them. New
-- workspaces get this from SYSTEM_ROLES; existing ones need it added here. Row security is forced on the
-- owner too, so each workspace is set in turn (see row_level_security).
DO $$
DECLARE
  workspace uuid;
BEGIN
  FOR workspace IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', workspace::text, true);
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'file.write'
    FROM role r
    WHERE r.is_system AND r.name = 'member'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END $$;
