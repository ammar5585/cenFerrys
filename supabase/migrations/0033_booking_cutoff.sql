-- =====================================================================
-- Automatic Ferry Booking Cut-Off: blocks new self-service/HR-manual
-- bookings once a configurable window before departure has passed.
-- This exact restriction existed before and was deliberately removed
-- (see 0015_remove_booking_cutoff.sql's header) - circumstances have
-- changed and the user has asked for it back. Reactivates the same
-- booking.override_cutoff permission (rather than creating a new key)
-- and finally puts hr_manual_booking_log.cutoff_overridden (dormant
-- since 0014/0015) to use, per this migration set's established
-- discipline of reusing soft-deprecated pieces instead of duplicating.
-- =====================================================================

ALTER TABLE ferry_schedule ADD COLUMN IF NOT EXISTS booking_cutoff_minutes INTEGER;

-- Reactivate, don't recreate - getEffectivePermissions() filters on
-- is_active = true, so this alone brings the permission back for
-- anyone still holding a role_permissions grant. 0015 deleted the old
-- grants, so re-grant Administrator + HR Manager (the original 0014
-- scope) explicitly.
UPDATE permissions SET is_active = true WHERE permission_key = 'booking.override_cutoff';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.role_name IN ('Administrator', 'HR Manager') AND p.permission_key = 'booking.override_cutoff'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- One shared audit table for both blocked attempts and overrides, since
-- both can happen from either the self-service booking page or the HR
-- Manual Booking modal.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_cutoff_log (
    log_id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_id             INTEGER REFERENCES ferry_schedule(schedule_id) ON DELETE SET NULL,
    service_name_snapshot   TEXT,
    travel_date             DATE NOT NULL,
    employee_user_id        INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    employee_name_snapshot  TEXT,
    attempted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    cutoff_instant          TIMESTAMPTZ,
    departure_time_snapshot TIMESTAMPTZ,
    action                  TEXT NOT NULL CHECK (action IN ('blocked', 'overridden')),
    performed_by_user_id    INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    reason                  TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- New setting key rather than repurposing the orphaned
-- booking_cutoff_hours (which is in hours, unused since 0015, and left
-- alone as harmless per that migration's own header) - this one is in
-- minutes to match the admin UI's preset dropdown (30/60/120/180).
INSERT INTO settings (setting_key, setting_value) VALUES
('default_booking_cutoff_minutes', '120')
ON CONFLICT (setting_key) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Verification (same execution, per session convention).
-- ---------------------------------------------------------------------
SELECT 'ferry_schedule.booking_cutoff_minutes column' AS check_name, EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'ferry_schedule' AND column_name = 'booking_cutoff_minutes'
) AS passed
UNION ALL
SELECT 'booking.override_cutoff reactivated', (
    SELECT is_active FROM permissions WHERE permission_key = 'booking.override_cutoff'
) = true
UNION ALL
SELECT 'booking.override_cutoff granted to Administrator + HR Manager', (
    SELECT COUNT(*) FROM role_permissions rp
    JOIN permissions p ON p.permission_id = rp.permission_id
    JOIN roles r ON r.role_id = rp.role_id
    WHERE p.permission_key = 'booking.override_cutoff' AND r.role_name IN ('Administrator', 'HR Manager')
) = 2
UNION ALL
SELECT 'booking_cutoff_log table exists', EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'booking_cutoff_log'
)
UNION ALL
SELECT 'default_booking_cutoff_minutes setting seeded', EXISTS (
    SELECT 1 FROM settings WHERE setting_key = 'default_booking_cutoff_minutes'
);
