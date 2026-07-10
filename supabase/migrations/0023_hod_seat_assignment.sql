-- =====================================================================
-- Security Module Enhancement: lets Security (and HR Manager/
-- Administrator, as an override) assign a specific named employee to
-- an HOD/department reserved seat during boarding. HOD/department
-- seat_reservations rows (0016/0017) only ever carried a free-text
-- contact_name - there was no way to turn a reserved block into a real,
-- checked-in passenger. This migration:
--   1. Adds bookings.source_reservation_id, linking an assigned booking
--      back to the reservation slot it fulfills.
--   2. Extends bookings.booking_method with a new value for these
--      bookings.
--   3. Fixes reserved_seats_for_schedule_date() so a reservation's
--      seats stop being double-counted once individually assigned -
--      each assigned seat is counted exactly once, in `booked`, not
--      twice (once in `booked`, once still in `reserved`). This
--      propagates for free to get_remaining_seats(),
--      get_remaining_seats_batch(), and book_ferry_seat(), since they
--      all call this same function (per 0016's own design).
--   4. Adds a dedicated insert-only audit table, matching the
--      established one-table-per-feature pattern (seat_reservation_log,
--      hr_manual_booking_log, permission_audit_log).
--   5. Adds new permission catalog rows.
-- =====================================================================

-- ---------------------------------------------------------------------
-- bookings.source_reservation_id: NULL for every pre-existing booking
-- and every normal self/admin_override/hr_manual booking - only set
-- when a booking was created via this feature.
-- ---------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source_reservation_id INTEGER
    REFERENCES seat_reservations(reservation_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_source_reservation_date
    ON bookings(source_reservation_id, travel_date) WHERE source_reservation_id IS NOT NULL;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_booking_method_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_booking_method_check
    CHECK (booking_method IN ('self', 'admin_override', 'hr_manual', 'hod_seat_assignment'));

-- ---------------------------------------------------------------------
-- hod_seat_assignment_log: structured, insert-only (same discipline as
-- seat_reservation_log/hr_manual_booking_log/security_action_log/
-- permission_audit_log). One row per assign/reassign/release/auto-
-- release action, with employee identities denormalized at write time.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hod_seat_assignment_log (
    log_id                          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reservation_id                  INTEGER REFERENCES seat_reservations(reservation_id) ON DELETE SET NULL,
    schedule_id                     INTEGER REFERENCES ferry_schedule(schedule_id),
    direction                       TEXT,
    travel_date                     DATE NOT NULL,
    resort_id                       INTEGER REFERENCES resorts(resort_id) ON DELETE SET NULL,
    department_id                   INTEGER REFERENCES departments(department_id) ON DELETE SET NULL,
    department_name_snapshot        TEXT,
    booking_id                      INTEGER REFERENCES bookings(booking_id) ON DELETE SET NULL,
    action                          TEXT NOT NULL CHECK (action IN ('assigned', 'reassigned', 'released', 'auto_released_no_show')),
    employee_assigned_user_id       INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    employee_assigned_name_snapshot TEXT,
    employee_assigned_id_snapshot   TEXT,
    employee_removed_user_id        INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    employee_removed_name_snapshot  TEXT,
    employee_removed_id_snapshot    TEXT,
    assigned_by_user_id             INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    remarks                         TEXT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hod_seat_assignment_log_created ON hod_seat_assignment_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hod_seat_assignment_log_reservation ON hod_seat_assignment_log(reservation_id);

-- ---------------------------------------------------------------------
-- reserved_seats_for_schedule_date: the critical fix. Was a flat
-- SUM(seats) over every active/date-matching reservation; now
-- subtracts, per reservation, however many non-cancelled/rejected/
-- expired/no-show bookings are already linked to it for this exact
-- date (a reservation can span a date range, so this must be computed
-- per specific travel_date, not once per reservation). Floored at 0 so
-- a reservation can never go "negative" if more bookings than seats
-- somehow exist against it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reserved_seats_for_schedule_date(p_schedule_id INTEGER, p_travel_date DATE)
RETURNS INTEGER AS $$
DECLARE
    v_weekday TEXT;
    v_reserved INTEGER;
BEGIN
    v_weekday := (ARRAY['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])[EXTRACT(DOW FROM p_travel_date)::INTEGER + 1];

    SELECT COALESCE(SUM(
        GREATEST(0, sr.seats - (
            SELECT COUNT(*)
            FROM bookings b
            JOIN booking_status bs ON bs.status_id = b.status_id
            WHERE b.source_reservation_id = sr.reservation_id
              AND b.travel_date = p_travel_date
              AND bs.status_name NOT IN ('Rejected', 'Cancelled', 'Expired', 'No Show')
        ))
    ), 0) INTO v_reserved
    FROM seat_reservations sr
    WHERE sr.schedule_id = p_schedule_id
      AND sr.status = 'active'
      AND p_travel_date BETWEEN sr.start_date AND sr.end_date
      AND v_weekday = ANY(sr.weekdays);

    RETURN v_reserved;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- New permission catalog rows (existing granular RBAC system).
-- ---------------------------------------------------------------------
INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
('security.assign_hod_seats', 'security', 'Security Module', 'Assign HOD Reserved Seats',
    'Search employees within a department and assign/reassign/release HOD or department reserved seats during boarding.', false, 63),
('audit_logs.view_hod_seat_assignments', 'audit_logs', 'Audit Logs', 'View HOD Seat Assignment Log', NULL, false, 105)
ON CONFLICT (permission_key) DO NOTHING;

-- HR Manager currently has no security.manage_manifest at all (only
-- security.access + security.manage_waiting_list), so their override
-- capability needs it granted here to have a page to act from.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('Security', 'security.assign_hod_seats'),
    ('Administrator', 'security.assign_hod_seats'),
    ('Administrator', 'audit_logs.view_hod_seat_assignments'),
    ('HR Manager', 'security.manage_manifest'),
    ('HR Manager', 'security.assign_hod_seats'),
    ('HR Manager', 'audit_logs.view_hod_seat_assignments')
) AS rp(role_name, permission_key)
JOIN roles r ON r.role_name = rp.role_name
JOIN permissions p ON p.permission_key = rp.permission_key
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Force PostgREST to pick up the new column/table immediately rather
-- than waiting for its own schema-cache refresh cycle.
NOTIFY pgrst, 'reload schema';
