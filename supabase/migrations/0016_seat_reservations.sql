-- =====================================================================
-- HR Seat Reservation Management: lets HR Manager (and Administrator)
-- hold ferry seats out of general circulation - for a specific
-- employee, a department, VIP/Executive use, general operational
-- buffer, or an emergency hold - over a date range with an optional
-- weekday pattern (daily = all 7 days, weekly = specific weekday(s),
-- "monthly" = a longer custom range; true day-of-month recurrence is
-- out of scope).
--
-- Key design decision: rather than touching every one of the ~6 call
-- sites that read seat availability today (ajax.js's live seat widget,
-- the admin/transport/security dashboards, security.js's waiting-list
-- promotion capacity re-check), this migration redefines the two
-- existing capacity RPCs (get_remaining_seats, book_ferry_seat) to
-- also subtract active reservations - every caller becomes
-- reservation-aware for free, with zero Node.js changes to any of
-- them. Accepted tradeoff: book_ferry_seat's FOR UPDATE lock is on
-- ferry_schedule only, not seat_reservations - a reservation created in
-- true concurrent race with the very last seat being booked isn't
-- fully serialized against it. Reservations are a low-frequency,
-- HR-operated action, not a high-contention path, so this is accepted
-- rather than adding lock complexity.
-- =====================================================================

CREATE TABLE seat_reservations (
    reservation_id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_id          INTEGER NOT NULL REFERENCES ferry_schedule(schedule_id),
    resort_id             INTEGER REFERENCES resorts(resort_id), -- metadata only, see header comment - no resort column exists on ferry_schedule/ferry_routes
    reservation_type       TEXT NOT NULL CHECK (reservation_type IN ('employee_specific', 'department', 'vip_executive', 'operational', 'emergency')),
    employee_user_id         INTEGER REFERENCES users(user_id) ON DELETE SET NULL, -- only meaningful for 'employee_specific'
    department_id              INTEGER REFERENCES departments(department_id) ON DELETE SET NULL, -- only meaningful for 'department'
    seats                        INTEGER NOT NULL CHECK (seats > 0),
    start_date                    DATE NOT NULL,
    end_date                       DATE NOT NULL CHECK (end_date >= start_date),
    weekdays                        TEXT[] NOT NULL DEFAULT ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    reason                            TEXT NOT NULL,
    status                             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired', 'cancelled')),
    created_by_user_id                   INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    created_at                             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_seat_reservations_schedule_active ON seat_reservations(schedule_id, status) WHERE status = 'active';

CREATE TRIGGER trg_seat_reservations_updated_at
    BEFORE UPDATE ON seat_reservations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- seat_reservation_log: structured, insert-only (same discipline as
-- security_action_log/permission_audit_log/hr_manual_booking_log).
-- One row per action - "Created By"/"Modified By"/"Released By" are
-- each just a different row's actor_user_id, not three separate
-- columns on the live reservation.
-- ---------------------------------------------------------------------
CREATE TABLE seat_reservation_log (
    log_id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reservation_id         INTEGER NOT NULL REFERENCES seat_reservations(reservation_id) ON DELETE CASCADE,
    schedule_id              INTEGER REFERENCES ferry_schedule(schedule_id),
    direction                  TEXT,
    resort_id                    INTEGER REFERENCES resorts(resort_id) ON DELETE SET NULL,
    reservation_type               TEXT,
    employee_name_snapshot           TEXT,
    department_name_snapshot           TEXT,
    seats                                INTEGER,
    start_date                            DATE,
    end_date                                DATE,
    action                                    TEXT NOT NULL CHECK (action IN ('created', 'modified', 'released', 'cancelled', 'expired')),
    actor_user_id                              INTEGER REFERENCES users(user_id) ON DELETE SET NULL, -- NULL for the automatic 'expired' action
    reason                                        TEXT,
    created_at                                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_seat_reservation_log_created ON seat_reservation_log(created_at DESC);

-- ---------------------------------------------------------------------
-- reserved_seats_for_schedule_date: weekday computed via EXTRACT(DOW),
-- not to_char(), so it's never affected by the server's locale.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reserved_seats_for_schedule_date(p_schedule_id INTEGER, p_travel_date DATE)
RETURNS INTEGER AS $$
DECLARE
    v_weekday TEXT;
    v_reserved INTEGER;
BEGIN
    v_weekday := (ARRAY['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])[EXTRACT(DOW FROM p_travel_date)::INTEGER + 1];

    SELECT COALESCE(SUM(seats), 0) INTO v_reserved
    FROM seat_reservations
    WHERE schedule_id = p_schedule_id
      AND status = 'active'
      AND p_travel_date BETWEEN start_date AND end_date
      AND v_weekday = ANY(weekdays);

    RETURN v_reserved;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- get_remaining_seats: adds a `reserved` output column (additive -
-- existing callers that destructure only capacity/booked/remaining are
-- unaffected) and subtracts reservations from `remaining`. Postgres
-- won't let CREATE OR REPLACE change a function's OUT-parameter row
-- type, so the old 3-column signature must be dropped first.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS get_remaining_seats(INTEGER, DATE);

CREATE OR REPLACE FUNCTION get_remaining_seats(p_schedule_id INTEGER, p_travel_date DATE)
RETURNS TABLE(capacity INTEGER, booked INTEGER, reserved INTEGER, remaining INTEGER) AS $$
DECLARE
    v_capacity INTEGER;
    v_booked INTEGER;
    v_reserved INTEGER;
BEGIN
    SELECT s.capacity INTO v_capacity FROM ferry_schedule s WHERE s.schedule_id = p_schedule_id;

    SELECT COALESCE(SUM(b.seats), 0) INTO v_booked
    FROM bookings b
    JOIN booking_status bs ON bs.status_id = b.status_id
    WHERE b.schedule_id = p_schedule_id
      AND b.travel_date = p_travel_date
      AND bs.status_name NOT IN ('Rejected', 'Cancelled', 'Expired');

    v_reserved := reserved_seats_for_schedule_date(p_schedule_id, p_travel_date);

    RETURN QUERY SELECT v_capacity, v_booked, v_reserved, GREATEST(0, v_capacity - v_booked - v_reserved);
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- book_ferry_seat: over-capacity comparison now also accounts for
-- active reservations, so a normal booking against a fully-reserved
-- schedule auto-waitlists exactly like it does today against a
-- fully-booked one. Otherwise unchanged from 0009_security_module.sql's
-- redefinition (still auto-waitlists rather than raising
-- CAPACITY_EXCEEDED).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION book_ferry_seat(
    p_user_id INTEGER,
    p_schedule_id INTEGER,
    p_travel_date DATE,
    p_direction TEXT,
    p_purpose TEXT,
    p_remarks TEXT,
    p_seats INTEGER
)
RETURNS bookings AS $$
DECLARE
    v_capacity INTEGER;
    v_booked INTEGER;
    v_reserved INTEGER;
    v_booking bookings;
    v_status_id INTEGER;
BEGIN
    SELECT capacity INTO v_capacity FROM ferry_schedule WHERE schedule_id = p_schedule_id FOR UPDATE;

    IF v_capacity IS NULL THEN
        RAISE EXCEPTION 'SCHEDULE_NOT_FOUND';
    END IF;

    SELECT COALESCE(SUM(b.seats), 0) INTO v_booked
    FROM bookings b
    JOIN booking_status bs ON bs.status_id = b.status_id
    WHERE b.schedule_id = p_schedule_id
      AND b.travel_date = p_travel_date
      AND bs.status_name NOT IN ('Rejected', 'Cancelled', 'Expired');

    v_reserved := reserved_seats_for_schedule_date(p_schedule_id, p_travel_date);

    IF v_booked + v_reserved + p_seats > v_capacity THEN
        SELECT status_id INTO v_status_id FROM booking_status WHERE status_name = 'Waiting List';
    ELSE
        v_status_id := 1; -- Pending, matches booking_status seed order (unchanged default)
    END IF;

    INSERT INTO bookings (user_id, schedule_id, travel_date, direction, purpose, remarks, seats, status_id)
    VALUES (p_user_id, p_schedule_id, p_travel_date, p_direction, p_purpose, p_remarks, p_seats, v_status_id)
    RETURNING * INTO v_booking;

    RETURN v_booking;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- expire_old_seat_reservations: mirrors expire_old_bookings()'s shape.
-- Called from the same cron endpoint as expire_old_bookings
-- (api/cron/expire-bookings.js).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION expire_old_seat_reservations()
RETURNS void AS $$
BEGIN
    INSERT INTO seat_reservation_log (
        reservation_id, schedule_id, direction, resort_id, reservation_type,
        employee_name_snapshot, department_name_snapshot, seats, start_date, end_date,
        action, actor_user_id, reason
    )
    SELECT sr.reservation_id, sr.schedule_id, fr.direction, sr.resort_id, sr.reservation_type,
           u.full_name, d.department_name, sr.seats, sr.start_date, sr.end_date,
           'expired', NULL, 'Automatically expired - end date passed.'
    FROM seat_reservations sr
    JOIN ferry_schedule fs ON fs.schedule_id = sr.schedule_id
    JOIN ferry_routes fr ON fr.route_id = fs.route_id
    LEFT JOIN users u ON u.user_id = sr.employee_user_id
    LEFT JOIN departments d ON d.department_id = sr.department_id
    WHERE sr.status = 'active' AND sr.end_date < CURRENT_DATE;

    UPDATE seat_reservations
    SET status = 'expired'
    WHERE status = 'active' AND end_date < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- New permission catalog rows (existing granular RBAC system).
-- ---------------------------------------------------------------------
INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
('booking.manage_seat_reservations', 'booking', 'Ferry Booking', 'Manage Seat Reservations', 'Create, edit, release, and cancel HR seat reservations that hold seats out of general circulation.', false, 53),
('audit_logs.view_seat_reservations', 'audit_logs', 'Audit Logs', 'View Seat Reservation Log', NULL, false, 104);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('HR Manager', 'booking.manage_seat_reservations'),
    ('HR Manager', 'audit_logs.view_seat_reservations'),
    ('Administrator', 'booking.manage_seat_reservations'),
    ('Administrator', 'audit_logs.view_seat_reservations')
) AS rp(role_name, permission_key)
JOIN roles r ON r.role_name = rp.role_name
JOIN permissions p ON p.permission_key = rp.permission_key;
