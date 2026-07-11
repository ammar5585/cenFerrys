-- =====================================================================
-- Administrator-only hard delete for Seat Reservations (admin_seat_
-- reservations.js): the page accumulates a lot of already-Cancelled/
-- Released/Expired clutter with no way to remove it. Before adding
-- that, seat_reservation_log.reservation_id must stop using
-- ON DELETE CASCADE (0016_seat_reservations.sql) - as written, hard-
-- deleting a reservation would delete its entire audit trail with it,
-- breaking the insert-only/permanent-history convention every other
-- log table in this app follows (seat_reservation_log's own sibling
-- hod_seat_assignment_log already uses ON DELETE SET NULL, 0023). Log
-- rows already denormalize everything they need (department/employee
-- name snapshots, seats, dates) to stay meaningful with reservation_id
-- turned NULL.
-- =====================================================================

ALTER TABLE seat_reservation_log DROP CONSTRAINT IF EXISTS seat_reservation_log_reservation_id_fkey;
ALTER TABLE seat_reservation_log ALTER COLUMN reservation_id DROP NOT NULL;
ALTER TABLE seat_reservation_log ADD CONSTRAINT seat_reservation_log_reservation_id_fkey
    FOREIGN KEY (reservation_id) REFERENCES seat_reservations(reservation_id) ON DELETE SET NULL;

-- One more log action so the delete itself is recorded (Performed By,
-- reason, snapshot fields) before the row disappears.
ALTER TABLE seat_reservation_log DROP CONSTRAINT IF EXISTS seat_reservation_log_action_check;
ALTER TABLE seat_reservation_log ADD CONSTRAINT seat_reservation_log_action_check
    CHECK (action IN ('created', 'modified', 'released', 'cancelled', 'expired', 'deleted'));

NOTIFY pgrst, 'reload schema';
