-- =====================================================================
-- Trigger functions + RPCs. book_ferry_seat() is the highest-risk piece
-- of this port: it replaces the PHP app's `SELECT ... FOR UPDATE`
-- transaction (staff/book.php) that made concurrent overbooking
-- impossible. A single RPC call is one Postgres transaction, so the
-- lock+recheck+insert here gives the same guarantee.
-- =====================================================================

-- ---------------------------------------------------------------------
-- updated_at auto-touch (Postgres has no `ON UPDATE CURRENT_TIMESTAMP`)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_manager_availability_updated_at
    BEFORE UPDATE ON manager_availability
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_bookings_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- get_remaining_seats: single source of truth for the "active booking"
-- exclusion list (Rejected/Cancelled/Expired don't count against
-- capacity) - ported from includes/functions.php's get_booked_seats().
-- Used by the AJAX seat-check endpoint, the booking page, the admin
-- dashboard KPI, and book_ferry_seat() itself below.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_remaining_seats(p_schedule_id INTEGER, p_travel_date DATE)
RETURNS TABLE(capacity INTEGER, booked INTEGER, remaining INTEGER) AS $$
DECLARE
    v_capacity INTEGER;
    v_booked INTEGER;
BEGIN
    SELECT s.capacity INTO v_capacity FROM ferry_schedule s WHERE s.schedule_id = p_schedule_id;

    SELECT COALESCE(SUM(b.seats), 0) INTO v_booked
    FROM bookings b
    JOIN booking_status bs ON bs.status_id = b.status_id
    WHERE b.schedule_id = p_schedule_id
      AND b.travel_date = p_travel_date
      AND bs.status_name NOT IN ('Rejected', 'Cancelled', 'Expired');

    RETURN QUERY SELECT v_capacity, v_booked, GREATEST(0, v_capacity - v_booked);
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- book_ferry_seat: atomic capacity-checked booking insert.
-- Raises exception 'CAPACITY_EXCEEDED' if there isn't room; the Node
-- caller catches this and shows the same message as the PHP version
-- ("Not enough seats remaining on this ferry. Please choose another
-- time."). status_id 1 = Pending (matches booking_status seed order).
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
BEGIN
    -- Row-level lock on the schedule row: serializes concurrent booking
    -- attempts for this schedule for the life of this transaction.
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
        RAISE EXCEPTION 'CAPACITY_EXCEEDED';
    END IF;

    INSERT INTO bookings (user_id, schedule_id, travel_date, direction, purpose, remarks, seats, status_id)
    VALUES (p_user_id, p_schedule_id, p_travel_date, p_direction, p_purpose, p_remarks, p_seats, 1)
    RETURNING * INTO v_booking;

    RETURN v_booking;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- expire_old_bookings: same two-step logic as the PHP version, called
-- from the Netlify Scheduled Function (netlify/functions/expire-bookings.mts)
-- instead of on every dashboard load.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION expire_old_bookings()
RETURNS void AS $$
BEGIN
    UPDATE bookings
    SET status_id = (SELECT status_id FROM booking_status WHERE status_name = 'Expired')
    WHERE travel_date < CURRENT_DATE
      AND status_id IN (
          SELECT status_id FROM booking_status
          WHERE status_name = 'Pending' OR status_name LIKE 'Waiting%'
      );

    UPDATE bookings
    SET status_id = (SELECT status_id FROM booking_status WHERE status_name = 'Completed')
    WHERE travel_date < CURRENT_DATE
      AND status_id = (SELECT status_id FROM booking_status WHERE status_name = 'Approved');
END;
$$ LANGUAGE plpgsql;
