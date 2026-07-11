-- =====================================================================
-- Administrator Multi-Ferry Seat Reservation: lets a System
-- Administrator apply the same reservation (type/resort/seats/date
-- range/weekdays/reason) to several ferry schedules in one action,
-- instead of repeating the single-schedule "New Reservation" form once
-- per departure. Reuses the existing seat_reservations table as-is
-- (one row per selected schedule) and the existing
-- reserved_seats_for_schedule_date()/seat_reservation_log machinery -
-- the only schema change needed is two new nullable audit columns
-- capturing the before/after available-seat snapshot the spec's Audit
-- Log section calls for, which nothing existing tracked.
-- =====================================================================

ALTER TABLE seat_reservation_log ADD COLUMN IF NOT EXISTS seats_available_before INTEGER;
ALTER TABLE seat_reservation_log ADD COLUMN IF NOT EXISTS seats_available_after INTEGER;

NOTIFY pgrst, 'reload schema';
