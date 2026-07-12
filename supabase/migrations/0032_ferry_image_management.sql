-- =====================================================================
-- Ferry Image Management: lets the Administrator (Ferry Services is
-- already Administrator-only end to end - see admin_ferry_services.js's
-- own header comment) upload/replace/remove/restore a display image
-- per ferry service. Reuses the existing ferry_service_log audit table
-- (this is a service-level property change, same category as renaming
-- a service or changing its capacity) rather than a new table, and the
-- existing 'portal-assets' Supabase Storage bucket (already used for
-- logos/favicons/backgrounds) rather than provisioning a new bucket.
-- =====================================================================

ALTER TABLE ferry_schedule ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Finds the action CHECK constraint's real name dynamically rather than
-- assuming Postgres's default auto-generated name - guessing wrong
-- would either silently no-op (DROP ... IF EXISTS on a name that isn't
-- the real one) or collide (ADD CONSTRAINT reusing a name that's still
-- attached to the old, narrower constraint).
DO $$
DECLARE
    v_constraint_name TEXT;
BEGIN
    SELECT con.conname INTO v_constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'ferry_service_log'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%action%'
    LIMIT 1;

    IF v_constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE ferry_service_log DROP CONSTRAINT %I', v_constraint_name);
    END IF;
END $$;

ALTER TABLE ferry_service_log ADD CONSTRAINT ferry_service_log_action_check CHECK (action IN (
    'created', 'modified', 'stop_added', 'stop_removed', 'stop_reordered',
    'activated', 'deactivated', 'archived', 'duplicated',
    'image_uploaded', 'image_replaced', 'image_removed', 'image_restored'
));
ALTER TABLE ferry_service_log ADD COLUMN IF NOT EXISTS previous_image_url TEXT;
ALTER TABLE ferry_service_log ADD COLUMN IF NOT EXISTS new_image_url TEXT;

-- ---------------------------------------------------------------------
-- Activity Logs never got a Ferry Services tab at all (ferry_service_log
-- has existed since 0028 with no audit-log UI to view it) - added now
-- since image actions specifically need to be auditable per spec.
-- Administrator only, matching admin_ferry_services.js's own role gate.
-- ---------------------------------------------------------------------
INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
('audit_logs.view_ferry_services', 'audit_logs', 'Audit Logs', 'View Ferry Service Log', 'Includes ferry image upload/replace/remove/restore actions.', false, 108)
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.role_name = 'Administrator' AND p.permission_key = 'audit_logs.view_ferry_services'
ON CONFLICT (role_id, permission_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Verification (same execution, per session convention).
-- ---------------------------------------------------------------------
SELECT 'ferry_schedule.image_url column' AS check_name, EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'ferry_schedule' AND column_name = 'image_url'
) AS passed
UNION ALL
SELECT 'ferry_service_log.previous_image_url column', EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'ferry_service_log' AND column_name = 'previous_image_url'
)
UNION ALL
SELECT 'ferry_service_log.new_image_url column', EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'ferry_service_log' AND column_name = 'new_image_url'
)
UNION ALL
SELECT 'action check constraint accepts image_uploaded', (
    SELECT pg_get_constraintdef(oid) LIKE '%image_uploaded%' FROM pg_constraint WHERE conname = 'ferry_service_log_action_check'
)
UNION ALL
SELECT 'audit_logs.view_ferry_services permission + role grant', (
    SELECT COUNT(*) FROM role_permissions rp
    JOIN permissions p ON p.permission_id = rp.permission_id
    JOIN roles r ON r.role_id = rp.role_id
    WHERE p.permission_key = 'audit_logs.view_ferry_services' AND r.role_name = 'Administrator'
) = 1;
