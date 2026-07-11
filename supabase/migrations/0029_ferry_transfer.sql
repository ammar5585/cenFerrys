-- =====================================================================
-- Emergency Passenger Transfer - Bulk Ferry Reallocation: lets an
-- authorized user move all (or a chosen subset of) passengers from one
-- ferry service+date to another in a single action, for operational
-- disruptions (breakdown, cancellation, maintenance, weather,
-- capacity adjustment). Reuses the existing flat per-schedule capacity
-- math (get_remaining_seats) - a transferred booking is simply
-- re-pointed at the destination's schedule_id, so both schedules'
-- remaining-seat counts update automatically with zero other changes.
-- =====================================================================

CREATE TABLE IF NOT EXISTS ferry_transfer_log (
    log_id                              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_schedule_id                  INTEGER REFERENCES ferry_schedule(schedule_id) ON DELETE SET NULL,
    destination_schedule_id             INTEGER REFERENCES ferry_schedule(schedule_id) ON DELETE SET NULL,
    source_service_name_snapshot        TEXT,
    destination_service_name_snapshot   TEXT,
    travel_date                         DATE NOT NULL,
    transfer_option                     TEXT NOT NULL CHECK (transfer_option IN ('all', 'confirmed', 'confirmed_and_waiting', 'selected')),
    passengers_transferred_count        INTEGER NOT NULL DEFAULT 0,
    waiting_list_transferred_count      INTEGER NOT NULL DEFAULT 0,
    skipped_count                       INTEGER NOT NULL DEFAULT 0,
    actor_user_id                       INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    reason                              TEXT,
    created_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ferry_transfer_log_created ON ferry_transfer_log(created_at DESC);

-- ---------------------------------------------------------------------
-- Permission catalog: exactly the roles named in the spec, which - all
-- 5, checked against the live roles table - already exist verbatim:
-- Administrator, Cluster Director of HR, Assistant HR Manager, Cluster
-- General Manager, Resident Manager. Security gets no grant here -
-- their existing security.manage_manifest permission already gives
-- them read-only visibility into the page; they cannot perform a
-- transfer without this separate permission.
-- ---------------------------------------------------------------------
INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
('booking.bulk_transfer_passengers', 'booking', 'Ferry Booking', 'Bulk Passenger Transfer (Emergency Reallocation)',
    'Move all or a chosen subset of passengers from one ferry service/date to another - ferry breakdown, cancellation, maintenance, weather, or capacity adjustment.', false, 54),
('audit_logs.view_ferry_transfers', 'audit_logs', 'Audit Logs', 'View Ferry Transfer Log', NULL, false, 106)
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('Administrator', 'booking.bulk_transfer_passengers'),
    ('Administrator', 'audit_logs.view_ferry_transfers'),
    ('Cluster Director of HR', 'booking.bulk_transfer_passengers'),
    ('Assistant HR Manager', 'booking.bulk_transfer_passengers'),
    ('Cluster General Manager', 'booking.bulk_transfer_passengers'),
    ('Resident Manager', 'booking.bulk_transfer_passengers')
) AS rp(role_name, permission_key)
JOIN roles r ON r.role_name = rp.role_name
JOIN permissions p ON p.permission_key = rp.permission_key
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- New email template (mailer.js's sendTemplatedEmail, matching the
-- established 0019_email_settings.sql pattern) - only sent if email
-- notifications are enabled (checked inside sendTemplatedEmail itself).
-- ---------------------------------------------------------------------
INSERT INTO email_templates (template_key, label, subject, body) VALUES
('ferry_transfer', 'Ferry Transfer Notification',
 'Your Ferry Booking Has Been Transferred',
 'Hi {{full_name}},' || E'\n\n' ||
 'Due to operational requirements, your ferry booking has been transferred to a different ferry service.' || E'\n\n' ||
 'New Ferry: {{new_ferry_name}}' || E'\n' ||
 'Date: {{travel_date}}' || E'\n' ||
 'Departure: {{departure_time}}' || E'\n' ||
 'Boarding Location: {{boarding_location}}' || E'\n' ||
 'Destination: {{destination}}' || E'\n' ||
 'Reason: {{reason}}' || E'\n' ||
 'Booking ID: {{booking_id}}' || E'\n\n' ||
 'We apologize for any inconvenience.')
ON CONFLICT (template_key) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Verification (run as part of the same execution - see session
-- convention: a bare "Success" message from the SQL Editor has
-- repeatedly turned out to mean the DDL silently no-op'd, so every
-- migration this session pastes its own proof-of-effect query
-- immediately after the DDL, in the same Run).
-- ---------------------------------------------------------------------
SELECT 'ferry_transfer_log table' AS check_name, EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'ferry_transfer_log'
) AS passed
UNION ALL
SELECT 'permissions inserted', (SELECT COUNT(*) FROM permissions WHERE permission_key IN ('booking.bulk_transfer_passengers', 'audit_logs.view_ferry_transfers')) = 2
UNION ALL
SELECT 'role_permissions seeded (expect 6)', (SELECT COUNT(*) FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id WHERE p.permission_key IN ('booking.bulk_transfer_passengers', 'audit_logs.view_ferry_transfers')) = 6
UNION ALL
SELECT 'email template inserted', (SELECT COUNT(*) FROM email_templates WHERE template_key = 'ferry_transfer') = 1;
