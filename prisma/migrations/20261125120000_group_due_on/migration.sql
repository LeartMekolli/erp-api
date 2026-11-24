-- Hand-written (Production lists plan, Task 1): when a group's pieces are due, so the work list sorts by it.
ALTER TABLE "work_order_group" ADD COLUMN "due_on" DATE;
CREATE INDEX "work_order_group_tenant_id_due_on_queue_rank_id_idx" ON "work_order_group" ("tenant_id", "due_on", "queue_rank", "id");

-- Groups started before this get theirs now. Row security is forced on the owner too, so each workspace is
-- set in turn (see row_level_security).
DO $$
DECLARE
  workspace uuid;
BEGIN
  FOR workspace IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', workspace::text, true);

    -- An order line's group: its order's promise.
    UPDATE "work_order_group" g SET "due_on" = o."promised_on"
    FROM "order_line" l JOIN "order" o ON o."id" = l."order_id"
    WHERE g."source_type" = 'order_line' AND l."id" = g."source_id";

    -- A part of an assembly: its assembly order's promise.
    UPDATE "work_order_group" g SET "due_on" = o."promised_on"
    FROM "order_line_part" p JOIN "order_line" l ON l."id" = p."line_id" JOIN "order" o ON o."id" = l."order_id"
    WHERE g."source_type" = 'order_line' AND p."id" = g."source_id";

    -- A remake: the order's speed in working days from the decision's local day, Monday to Friday, without the
    -- workspace's closed dates or end of day (a one-time approximation; every remake started from now on uses
    -- groupPromise).
    UPDATE "work_order_group" g SET "due_on" = (
      SELECT d::date
      FROM generate_series(
        (COALESCE(cl."decided_at", c."created_at") AT TIME ZONE 'UTC' AT TIME ZONE t."timezone")::date,
        (COALESCE(cl."decided_at", c."created_at") AT TIME ZONE 'UTC' AT TIME ZONE t."timezone")::date + 90,
        interval '1 day') d
      WHERE extract(isodow FROM d) < 6
      ORDER BY d OFFSET COALESCE(s."working_days", 0) LIMIT 1)
    FROM "claim_line" cl
    JOIN "claim" c ON c."id" = cl."claim_id"
    JOIN "order" o ON o."id" = c."order_id"
    JOIN "tenant" t ON t."id" = o."tenant_id"
    LEFT JOIN "delivery_speed" s ON s."tenant_id" = o."tenant_id" AND s."key" = o."delivery_speed_key"
    WHERE g."source_type" = 'claim_line' AND cl."id" = g."source_id";
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END $$;
