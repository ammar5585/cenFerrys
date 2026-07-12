-- =====================================================================
-- Ferry Service / Seat Reservation synchronization fix.
--
-- expire_old_seat_reservations() (0016_seat_reservations.sql) INNER
-- JOINs ferry_routes to build its audit-log INSERT ... SELECT. A Ferry
-- Service created via the Route-Based Ferry Service Management feature
-- (0028_ferry_service_routes.sql) has route_id = NULL by design, so
-- that INNER JOIN silently drops its reservations from the query
-- entirely - the UPDATE statement right below still expires them
-- correctly (it has no JOIN), but no 'expired' row is ever written to
-- seat_reservation_log for them, leaving a silent audit-trail gap.
-- Switched to a LEFT JOIN with a service_name fallback, matching the
-- pattern already used everywhere else in the app (see
-- getWholeRouteDirections() in ferryServices.js).
-- =====================================================================

CREATE OR REPLACE FUNCTION expire_old_seat_reservations()
RETURNS void AS $$
BEGIN
    INSERT INTO seat_reservation_log (
        reservation_id, schedule_id, direction, resort_id, reservation_type,
        employee_name_snapshot, department_name_snapshot, seats, start_date, end_date,
        action, actor_user_id, reason
    )
    SELECT sr.reservation_id, sr.schedule_id, COALESCE(fr.direction, fs.service_name), sr.resort_id, sr.reservation_type,
           u.full_name, d.department_name, sr.seats, sr.start_date, sr.end_date,
           'expired', NULL, 'Automatically expired - end date passed.'
    FROM seat_reservations sr
    JOIN ferry_schedule fs ON fs.schedule_id = sr.schedule_id
    LEFT JOIN ferry_routes fr ON fr.route_id = fs.route_id
    LEFT JOIN users u ON u.user_id = sr.employee_user_id
    LEFT JOIN departments d ON d.department_id = sr.department_id
    WHERE sr.status = 'active' AND sr.end_date < CURRENT_DATE;

    UPDATE seat_reservations
    SET status = 'expired'
    WHERE status = 'active' AND end_date < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

NOTIFY pgrst, 'reload schema';

-- Verification (same execution, per session convention).
SELECT 'expire_old_seat_reservations redefined' AS check_name, EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'expire_old_seat_reservations'
) AS passed
UNION ALL
SELECT 'function source contains LEFT JOIN ferry_routes', (
    SELECT pg_get_functiondef(oid) LIKE '%LEFT JOIN ferry_routes%' FROM pg_proc WHERE proname = 'expire_old_seat_reservations'
);
