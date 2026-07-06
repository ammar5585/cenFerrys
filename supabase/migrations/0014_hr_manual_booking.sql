-- =====================================================================
-- HR Manual Booking: lets HR Manager (and Administrator) create a
-- ferry booking on behalf of any employee, independent of the normal
-- self-service flow in staff.js, with three independently-toggleable
-- overrides (cutoff, seat capacity, approval chain) - each a deliberate
-- per-booking choice, not an all-or-nothing bypass like the existing
-- Administrator-only "Admin Override" feature (which stays untouched,
-- its own separate feature/audit trail).
-- =====================================================================

-- ---------------------------------------------------------------------
-- bookings.booking_method: distinguishes a normal self-service booking
-- from the two existing/new "created by someone else" paths, purely
-- for display (badges) - the pre-existing admin_override boolean
-- column is untouched and still drives its own existing "Override"
-- badge/behavior.
-- ---------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN booking_method TEXT NOT NULL DEFAULT 'self'
    CHECK (booking_method IN ('self', 'admin_override', 'hr_manual'));

UPDATE bookings SET booking_method = 'admin_override' WHERE admin_override = true;

-- ---------------------------------------------------------------------
-- hr_manual_booking_log: structured, insert-only (mirrors
-- security_action_log's/permission_audit_log's precedent) - captures
-- exactly the fields the spec's Audit Log section asks for, with
-- employee id/name denormalized at write time (immune to a later
-- profile edit silently rewriting history, same discipline used
-- elsewhere in this codebase).
-- ---------------------------------------------------------------------
CREATE TABLE hr_manual_booking_log (
    log_id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id             INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
    employee_user_id         INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    employee_id_snapshot       TEXT NOT NULL,
    employee_name_snapshot      TEXT NOT NULL,
    schedule_id                   INTEGER REFERENCES ferry_schedule(schedule_id),
    direction                      TEXT,
    resort_id                       INTEGER REFERENCES resorts(resort_id) ON DELETE SET NULL,
    travel_date                      DATE NOT NULL,
    created_by_user_id                 INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    cutoff_overridden                    BOOLEAN NOT NULL DEFAULT false,
    capacity_overridden                    BOOLEAN NOT NULL DEFAULT false,
    approval_overridden                      BOOLEAN NOT NULL DEFAULT false,
    remarks                                    TEXT,
    created_at                                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_hr_manual_booking_log_created ON hr_manual_booking_log(created_at DESC);

-- ---------------------------------------------------------------------
-- New permission catalog rows (existing granular RBAC system - see
-- supabase/migrations/0012_permission_management.sql).
-- ---------------------------------------------------------------------
INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
('booking.hr_manual_booking',  'booking', 'Ferry Booking', 'HR Manual Booking (Any Employee)', 'Create a booking on behalf of any employee, bypassing the self-service flow.', false, 49),
('booking.override_cutoff',     'booking', 'Ferry Booking', 'Override Booking Cut-Off Time', NULL, false, 50),
('booking.override_capacity',    'booking', 'Ferry Booking', 'Override Seat Capacity', NULL, false, 51),
('booking.override_approval',     'booking', 'Ferry Booking', 'Override Approval Workflow', NULL, false, 52),
('audit_logs.view_hr_manual_bookings', 'audit_logs', 'Audit Logs', 'View HR Manual Booking Log', NULL, false, 103);

-- ---------------------------------------------------------------------
-- Seed role_permissions: HR Manager currently has NO booking.* key at
-- all (not even the booking.access module toggle) - grant it alongside
-- the new fine permissions, or getEffectivePermissions()'s
-- module-toggle stripping would mask them. Administrator already has
-- booking.access/booking.view_all/audit_logs.access.
-- ---------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('HR Manager', 'booking.access'),
    ('HR Manager', 'booking.view_all'),
    ('HR Manager', 'booking.hr_manual_booking'),
    ('HR Manager', 'booking.override_cutoff'),
    ('HR Manager', 'booking.override_capacity'),
    ('HR Manager', 'booking.override_approval'),
    ('HR Manager', 'audit_logs.access'),
    ('HR Manager', 'audit_logs.view_hr_manual_bookings'),

    ('Administrator', 'booking.hr_manual_booking'),
    ('Administrator', 'booking.override_cutoff'),
    ('Administrator', 'booking.override_capacity'),
    ('Administrator', 'booking.override_approval'),
    ('Administrator', 'audit_logs.view_hr_manual_bookings')
) AS rp(role_name, permission_key)
JOIN roles r ON r.role_name = rp.role_name
JOIN permissions p ON p.permission_key = rp.permission_key;
