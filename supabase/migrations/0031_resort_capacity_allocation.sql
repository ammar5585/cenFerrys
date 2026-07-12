-- =====================================================================
-- Resort Capacity Allocator (CGLM / CMLM) - Phase 1: data model + a
-- purely additive read-only usage RPC. Lets an Administrator split a
-- ferry service's flat capacity between the two resorts. Absence of
-- any ferry_resort_capacity rows for a schedule_id means "not split
-- yet" - that service keeps behaving exactly as it does today (one
-- shared pool via get_remaining_seats()/book_ferry_seat(), untouched
-- by this migration). Actual enforcement of the split inside
-- book_ferry_seat() and waiting-list promotion is Phase 2, deliberately
-- deferred - this phase only adds configuration, audit, and read-only
-- usage stats, so the 2 live ferry services and their real bookings
-- are at zero risk from this migration.
-- =====================================================================

CREATE TABLE IF NOT EXISTS ferry_resort_capacity (
    allocation_id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_id        INTEGER NOT NULL REFERENCES ferry_schedule(schedule_id) ON DELETE CASCADE,
    resort_id          INTEGER NOT NULL REFERENCES resorts(resort_id),
    allocated_seats    INTEGER NOT NULL CHECK (allocated_seats >= 0),
    updated_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, resort_id)
);

CREATE INDEX IF NOT EXISTS idx_ferry_resort_capacity_schedule ON ferry_resort_capacity(schedule_id);

-- set_updated_at() already exists (0003_functions.sql) - reused as-is.
DROP TRIGGER IF EXISTS trg_ferry_resort_capacity_updated_at ON ferry_resort_capacity;
CREATE TRIGGER trg_ferry_resort_capacity_updated_at
    BEFORE UPDATE ON ferry_resort_capacity
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- ferry_resort_capacity_log: insert-only audit (same discipline as
-- seat_reservation_log/ferry_service_log/hod_seat_assignment_log).
-- Flattened to 2 resort slots (ordered by resort_id ascending) rather
-- than one row per resort - this app has exactly 2 active resorts and
-- the spec explicitly wants a side-by-side before/after in one record.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ferry_resort_capacity_log (
    log_id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_id               INTEGER REFERENCES ferry_schedule(schedule_id) ON DELETE SET NULL,
    service_name_snapshot     TEXT,
    resort_a_id               INTEGER,
    resort_a_name_snapshot    TEXT,
    previous_resort_a_seats   INTEGER,
    new_resort_a_seats        INTEGER,
    resort_b_id               INTEGER,
    resort_b_name_snapshot    TEXT,
    previous_resort_b_seats   INTEGER,
    new_resort_b_seats        INTEGER,
    total_capacity            INTEGER,
    action                    TEXT NOT NULL CHECK (action IN ('created', 'modified', 'removed', 'bulk_applied')),
    actor_user_id             INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    reason                    TEXT NOT NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ferry_resort_capacity_log_created ON ferry_resort_capacity_log(created_at DESC);

-- ---------------------------------------------------------------------
-- get_remaining_seats_by_resort: purely additive - does NOT redefine
-- get_remaining_seats/get_remaining_seats_batch/book_ferry_seat, so
-- every one of their ~10 existing callers is completely unaffected.
-- Returns zero rows for a schedule_id with no configured allocation
-- (the opt-in signal). "Booked" mirrors get_remaining_seats()'s own
-- exclusion list; "reserved" mirrors reserved_seats_for_schedule_date()
-- (0023_hod_seat_assignment.sql)'s already-assigned-seats subtraction,
-- attributed per resort - a "Both Resorts" reservation (resort_id
-- NULL) splits ceil(seats/2) to the lower resort_id, floor(seats/2) to
-- the other (exactly 2 resorts exist in this app, so this is written
-- directly rather than generalized to N resorts).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_remaining_seats_by_resort(p_schedule_id INTEGER, p_travel_date DATE)
RETURNS TABLE(resort_id INTEGER, resort_name TEXT, allocated INTEGER, booked INTEGER, reserved INTEGER, remaining INTEGER) AS $$
DECLARE
    v_weekday TEXT;
    v_lowest_resort_id INTEGER;
    v_row RECORD;
    v_booked INTEGER;
    v_reserved INTEGER;
BEGIN
    -- No rows at all for this schedule = not split yet; caller treats an
    -- empty result set as "use the flat shared-pool numbers instead."
    IF NOT EXISTS (SELECT 1 FROM ferry_resort_capacity frc WHERE frc.schedule_id = p_schedule_id) THEN
        RETURN;
    END IF;

    v_weekday := (ARRAY['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])[EXTRACT(DOW FROM p_travel_date)::INTEGER + 1];
    SELECT MIN(frc.resort_id) INTO v_lowest_resort_id FROM ferry_resort_capacity frc WHERE frc.schedule_id = p_schedule_id;

    FOR v_row IN
        SELECT frc.resort_id AS r_id, r.resort_name AS r_name, frc.allocated_seats AS r_allocated
        FROM ferry_resort_capacity frc
        JOIN resorts r ON r.resort_id = frc.resort_id
        WHERE frc.schedule_id = p_schedule_id
        ORDER BY frc.resort_id
    LOOP
        SELECT COALESCE(SUM(b.seats), 0) INTO v_booked
        FROM bookings b
        JOIN booking_status bs ON bs.status_id = b.status_id
        JOIN users u ON u.user_id = b.user_id
        WHERE b.schedule_id = p_schedule_id
          AND b.travel_date = p_travel_date
          AND bs.status_name NOT IN ('Rejected', 'Cancelled', 'Expired')
          AND u.resort_id = v_row.r_id;

        -- Reserved: same "seats minus already-assigned" logic as
        -- reserved_seats_for_schedule_date() (0023) - a resort-specific
        -- reservation counts in full toward that resort; a "Both
        -- Resorts" one (resort_id NULL) splits its still-unassigned
        -- seats ceil/floor(n/2), remainder to the lower resort_id.
        SELECT COALESCE(SUM(
            CASE
                WHEN sr.resort_id = v_row.r_id THEN GREATEST(0, sr.seats - assigned.cnt)
                WHEN sr.resort_id IS NULL AND v_row.r_id = v_lowest_resort_id THEN CEIL(GREATEST(0, sr.seats - assigned.cnt)::NUMERIC / 2)
                WHEN sr.resort_id IS NULL THEN FLOOR(GREATEST(0, sr.seats - assigned.cnt)::NUMERIC / 2)
                ELSE 0
            END
        ), 0)::INTEGER INTO v_reserved
        FROM seat_reservations sr
        CROSS JOIN LATERAL (
            SELECT COUNT(*) AS cnt
            FROM bookings b2
            JOIN booking_status bs2 ON bs2.status_id = b2.status_id
            WHERE b2.source_reservation_id = sr.reservation_id
              AND b2.travel_date = p_travel_date
              AND bs2.status_name NOT IN ('Rejected', 'Cancelled', 'Expired', 'No Show')
        ) assigned
        WHERE sr.schedule_id = p_schedule_id
          AND sr.status = 'active'
          AND p_travel_date BETWEEN sr.start_date AND sr.end_date
          AND v_weekday = ANY(sr.weekdays)
          AND (sr.resort_id = v_row.r_id OR sr.resort_id IS NULL);

        resort_id := v_row.r_id;
        resort_name := v_row.r_name;
        allocated := v_row.r_allocated;
        booked := v_booked;
        reserved := v_reserved;
        remaining := GREATEST(0, v_row.r_allocated - v_booked - v_reserved);
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- Permission catalog: view access for the 4 named roles + Administrator
-- (all 5 exact role names already verified live against the roles table
-- earlier this session, for the Bulk Transfer feature); modify access
-- for Administrator only, matching "Only the System Administrator may
-- modify capacity allocations."
-- ---------------------------------------------------------------------
INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
('booking.manage_resort_capacity', 'booking', 'Ferry Booking', 'Manage Resort Capacity Allocation',
    'Configure how a ferry service''s total capacity is split between CGLM and CMLM.', false, 55),
('booking.view_resort_capacity', 'booking', 'Ferry Booking', 'View Resort Capacity Allocation',
    'View (read-only) how a ferry service''s capacity is split between CGLM and CMLM, and live usage per resort.', false, 56),
('audit_logs.view_resort_capacity', 'audit_logs', 'Audit Logs', 'View Resort Capacity Allocation Log', NULL, false, 107)
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('Administrator', 'booking.manage_resort_capacity'),
    ('Administrator', 'booking.view_resort_capacity'),
    ('Administrator', 'audit_logs.view_resort_capacity'),
    ('Cluster General Manager', 'booking.view_resort_capacity'),
    ('Resident Manager', 'booking.view_resort_capacity'),
    ('Cluster Director of HR', 'booking.view_resort_capacity'),
    ('Assistant HR Manager', 'booking.view_resort_capacity')
) AS rp(role_name, permission_key)
JOIN roles r ON r.role_name = rp.role_name
JOIN permissions p ON p.permission_key = rp.permission_key
ON CONFLICT (role_id, permission_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Verification (same execution, per session convention).
-- ---------------------------------------------------------------------
SELECT 'ferry_resort_capacity table' AS check_name, EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'ferry_resort_capacity'
) AS passed
UNION ALL
SELECT 'ferry_resort_capacity_log table', EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'ferry_resort_capacity_log'
)
UNION ALL
SELECT 'get_remaining_seats_by_resort function', EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'get_remaining_seats_by_resort'
)
UNION ALL
SELECT 'permissions inserted (expect 3)', (SELECT COUNT(*) FROM permissions WHERE permission_key IN ('booking.manage_resort_capacity', 'booking.view_resort_capacity', 'audit_logs.view_resort_capacity')) = 3
UNION ALL
SELECT 'role_permissions seeded (expect 7)', (SELECT COUNT(*) FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id WHERE p.permission_key IN ('booking.manage_resort_capacity', 'booking.view_resort_capacity', 'audit_logs.view_resort_capacity')) = 7;
