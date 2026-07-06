-- =====================================================================
-- Performance pass: missing indexes on genuinely hot, unindexed filter
-- paths, plus a batched seat-availability function that collapses N
-- network round-trips (one get_remaining_seats() call per schedule)
-- into 1 - reusing get_remaining_seats() unchanged via
-- unnest(...) CROSS JOIN LATERAL, so there is no duplicated/re-implemented
-- capacity or reservation logic and zero drift risk against the
-- existing single source of truth.
-- =====================================================================

-- staff.js's dashboard + My Bookings queries filter bookings by
-- user_id and sort by travel_date - both previously unindexed (full
-- scan on every staff login/booking-history view).
CREATE INDEX idx_bookings_user_travel_date ON bookings(user_id, travel_date DESC);

-- manager.js's approver dashboard counts filter booking_approvals by
-- approver_id - previously unindexed.
CREATE INDEX idx_booking_approvals_approver ON booking_approvals(approver_id);

CREATE OR REPLACE FUNCTION get_remaining_seats_batch(p_schedule_ids INTEGER[], p_travel_date DATE)
RETURNS TABLE(schedule_id INTEGER, capacity INTEGER, booked INTEGER, reserved INTEGER, remaining INTEGER) AS $$
BEGIN
    RETURN QUERY
    SELECT s.schedule_id, r.capacity, r.booked, r.reserved, r.remaining
    FROM unnest(p_schedule_ids) AS s(schedule_id)
    CROSS JOIN LATERAL get_remaining_seats(s.schedule_id, p_travel_date) AS r;
END;
$$ LANGUAGE plpgsql STABLE;
