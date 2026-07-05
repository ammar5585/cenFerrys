-- =====================================================================
-- Security Operations Module: a new Security role, day-of-travel
-- passenger movement statuses (Waiting List/Checked-In/Departed/
-- Arrived/No Show), timestamp columns on bookings for check-in/
-- departure/arrival, and a dedicated insert-only audit table for every
-- Security action (structured, unlike the free-text activity_logs).
-- book_ferry_seat() is redefined so a full ferry waitlists a booking
-- (skipping the approval chain entirely) instead of rejecting it
-- outright - the caller distinguishes this by checking the returned
-- row's status_id against the new 'Waiting List' status id.
-- =====================================================================

-- ---------------------------------------------------------------------
-- roles: Security is additive, appended after the existing 7 (role_id
-- assignment is sequential/insertion-order, same discipline the
-- resorts/CRON_SECRET-era migrations already followed for new rows).
-- ---------------------------------------------------------------------
INSERT INTO roles (role_name, description) VALUES
('Security', 'Manages passenger check-in, departure, arrival, no-show, and waiting list operations');

-- ---------------------------------------------------------------------
-- booking_status: day-of-travel movement statuses. 'Waiting List'
-- deliberately starts with "Waiting" so it's automatically swept by
-- expire_old_bookings()'s existing `status_name LIKE 'Waiting%'` clause
-- if its travel date passes unprocessed - no change needed there.
-- ---------------------------------------------------------------------
INSERT INTO booking_status (status_name, badge_color) VALUES
('Waiting List', 'warning'),
('Checked-In', 'info'),
('Departed', 'primary'),
('Arrived', 'success'),
('No Show', 'danger');

-- ---------------------------------------------------------------------
-- bookings: direct timestamp columns for the three movement events, so
-- manifest/report queries stay simple selects with no extra join.
-- ---------------------------------------------------------------------
ALTER TABLE bookings
    ADD COLUMN checked_in_at TIMESTAMPTZ,
    ADD COLUMN departed_at TIMESTAMPTZ,
    ADD COLUMN arrived_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- security_action_log: insert-only audit trail for every Security
-- action (movement + waiting-list promotion). resort_id/department_id/
-- schedule_id are denormalized at write-time (captured from the
-- booking's booker), same discipline booking_approvals already uses -
-- immune to a later transfer/reassignment silently rewriting history.
-- No UPDATE/DELETE grant or application code path ever targets this
-- table - "no audit records shall be editable or deleted" is enforced
-- by simply never writing that code, matching this codebase's existing
-- reliance on the service-role key + application-level discipline
-- rather than DB-level policies (see db.js's header comment).
-- ---------------------------------------------------------------------
CREATE TABLE security_action_log (
    log_id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id               INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
    action                    TEXT NOT NULL CHECK (action IN ('check_in', 'departed', 'no_show', 'arrived', 'promoted', 'released_seat')),
    previous_status_id        INTEGER REFERENCES booking_status(status_id),
    new_status_id             INTEGER REFERENCES booking_status(status_id),
    security_officer_id       INTEGER NOT NULL REFERENCES users(user_id),
    remarks                   TEXT,
    resort_id                 INTEGER REFERENCES resorts(resort_id),
    department_id             INTEGER REFERENCES departments(department_id),
    schedule_id                INTEGER REFERENCES ferry_schedule(schedule_id),
    -- Promotion-only fields (NULL for every other action).
    original_booking_id        INTEGER REFERENCES bookings(booking_id),
    promotion_method            TEXT CHECK (promotion_method IN ('automatic', 'manual')),
    promotion_reason             TEXT,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_security_action_log_booking ON security_action_log(booking_id);
CREATE INDEX idx_security_action_log_schedule_date ON security_action_log(schedule_id, created_at);

-- ---------------------------------------------------------------------
-- book_ferry_seat: on capacity overflow, insert as 'Waiting List'
-- instead of raising CAPACITY_EXCEEDED. Still SCHEDULE_NOT_FOUND on a
-- bad schedule id (unchanged). The caller (seats.js/staff.js) tells the
-- two outcomes apart by comparing the returned row's status_id against
-- the 'Waiting List' status id (fetched once via approval.js's
-- getStatusId(), same cached helper already used everywhere else).
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

    IF v_booked + p_seats > v_capacity THEN
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
