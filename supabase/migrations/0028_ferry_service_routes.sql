-- =====================================================================
-- Route-Based Ferry Service Management (Phase 1 - data model + Admin
-- management only; nothing about the live booking/security/reports
-- pipeline changes here - see the plan doc for the full phased
-- rationale). A "ferry service" is one continuous route (CGLM -> CMLM
-- -> Hulhumale -> Male) with independently configurable arrival/
-- departure times per stop, replacing the old mental model of one
-- ferry_schedule row per single leg.
--
-- Table strategy: ferry_schedule KEEPS its identity and PK rather than
-- being replaced by a parallel table - every existing FK
-- (bookings.schedule_id, security_action_log, seat_reservations,
-- hod_seat_assignment_log, etc.) keeps working completely unchanged.
-- ferry_schedule becomes "the service" in spirit; route_stops hangs
-- off its schedule_id. route_id is loosened to nullable since a new
-- multi-stop service created from the new Admin UI has no single
-- "direction" to link to a legacy ferry_routes row.
-- =====================================================================

ALTER TABLE ferry_schedule ALTER COLUMN route_id DROP NOT NULL;
ALTER TABLE ferry_schedule ADD COLUMN IF NOT EXISTS service_name TEXT;
ALTER TABLE ferry_schedule ADD COLUMN IF NOT EXISTS service_code TEXT;
ALTER TABLE ferry_schedule ADD COLUMN IF NOT EXISTS effective_date DATE;
ALTER TABLE ferry_schedule ADD COLUMN IF NOT EXISTS expiry_date DATE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ferry_schedule_service_code_key') THEN
        ALTER TABLE ferry_schedule ADD CONSTRAINT ferry_schedule_service_code_key UNIQUE (service_code);
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- route_stops: one row per stop along a service's route, ordered by
-- stop_order (always renumbered 1..N by the app on save, never trusted
-- as arbitrary input - see admin_ferry_services.js). arrival_time is
-- NULL for the first stop (nothing to arrive from), departure_time is
-- NULL for the last stop ("End of Route" - nowhere further to depart
-- to). ON DELETE CASCADE is correct here (unlike seat_reservation_log's
-- earlier CASCADE bug) - a stop has no independent audit meaning once
-- its parent service is gone; ferry_service_log below is the permanent
-- record, not this live table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_stops (
    stop_id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_id       INTEGER NOT NULL REFERENCES ferry_schedule(schedule_id) ON DELETE CASCADE,
    stop_order        INTEGER NOT NULL,
    stop_name         TEXT NOT NULL,
    arrival_time      TIME,
    departure_time    TIME,
    boarding_allowed  BOOLEAN NOT NULL DEFAULT true,
    dropoff_allowed   BOOLEAN NOT NULL DEFAULT true,
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, stop_order)
);

CREATE INDEX IF NOT EXISTS idx_route_stops_schedule ON route_stops(schedule_id, stop_order);

-- set_updated_at() already exists (0003_functions.sql) - reused as-is.
DROP TRIGGER IF EXISTS trg_route_stops_updated_at ON route_stops;
CREATE TRIGGER trg_route_stops_updated_at
    BEFORE UPDATE ON route_stops
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- ferry_service_log: structured, insert-only (same discipline as every
-- other *_log table in this app) - one row per service- or stop-level
-- change, with human-readable snapshots so it stays meaningful even
-- after the live service/stop is edited again or deleted.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ferry_service_log (
    log_id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_id              INTEGER REFERENCES ferry_schedule(schedule_id) ON DELETE SET NULL,
    service_name_snapshot    TEXT,
    service_code_snapshot    TEXT,
    route_snapshot           TEXT,
    stop_id                  INTEGER,
    stop_name_snapshot       TEXT,
    previous_arrival_time    TIME,
    new_arrival_time         TIME,
    previous_departure_time  TIME,
    new_departure_time       TIME,
    action                   TEXT NOT NULL CHECK (action IN (
        'created', 'modified', 'stop_added', 'stop_removed', 'stop_reordered',
        'activated', 'deactivated', 'archived', 'duplicated'
    )),
    actor_user_id            INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    reason                   TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ferry_service_log_created ON ferry_service_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ferry_service_log_schedule ON ferry_service_log(schedule_id);

-- ---------------------------------------------------------------------
-- One-time seed: backfill the existing single ferry_schedule row with
-- service_name/service_code/effective_date, and create its 2 route_stops
-- rows from its current ferry_routes.direction, so it shows correctly
-- in the new Ferry Services page immediately with zero manual re-entry.
-- Guarded by service_code IS NULL so this is safe to re-run.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_schedule RECORD;
BEGIN
    FOR v_schedule IN
        SELECT fs.schedule_id, fs.departure_time, fr.route_name, fr.direction
        FROM ferry_schedule fs
        LEFT JOIN ferry_routes fr ON fr.route_id = fs.route_id
        WHERE fs.service_code IS NULL
    LOOP
        UPDATE ferry_schedule
        SET service_name = COALESCE(v_schedule.route_name, 'Ferry Service ' || v_schedule.schedule_id),
            service_code = 'SVC-' || v_schedule.schedule_id,
            effective_date = CURRENT_DATE
        WHERE schedule_id = v_schedule.schedule_id;

        IF NOT EXISTS (SELECT 1 FROM route_stops WHERE schedule_id = v_schedule.schedule_id) THEN
            INSERT INTO route_stops (schedule_id, stop_order, stop_name, arrival_time, departure_time, boarding_allowed, dropoff_allowed)
            VALUES
                (v_schedule.schedule_id, 1, COALESCE(split_part(v_schedule.direction, ' to ', 1), 'Origin'), NULL, v_schedule.departure_time, true, false),
                (v_schedule.schedule_id, 2, COALESCE(split_part(v_schedule.direction, ' to ', 2), 'Destination'), v_schedule.departure_time + INTERVAL '30 minutes', NULL, false, true);
        END IF;
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
