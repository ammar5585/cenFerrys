-- =====================================================================
-- Adds a "HOD Reservation" (Head of Department) reservation type and a
-- free-text `contact_name` field - shown for 'department' and 'hod'
-- reservations, which aren't tied to a specific users(user_id) row the
-- way 'employee_specific' is, so there was previously no way to record
-- WHO within the department the reservation is actually for/held by.
-- =====================================================================

ALTER TABLE seat_reservations DROP CONSTRAINT seat_reservations_reservation_type_check;
ALTER TABLE seat_reservations ADD CONSTRAINT seat_reservations_reservation_type_check
    CHECK (reservation_type IN ('employee_specific', 'department', 'hod', 'vip_executive', 'operational', 'emergency'));

ALTER TABLE seat_reservations ADD COLUMN contact_name TEXT;

-- seat_reservation_log.reservation_type is a plain denormalized TEXT
-- snapshot with no CHECK constraint of its own, so no constraint
-- update is needed there - just the new snapshot column.
ALTER TABLE seat_reservation_log ADD COLUMN contact_name_snapshot TEXT;
