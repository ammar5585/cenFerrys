-- =====================================================================
-- Direction Management: promotes "direction" from a hardcoded 2-value
-- CHECK constraint into a fully manageable entity (name, description,
-- resort association, active/inactive, display order).
--
-- ferry_routes keeps its existing `direction` TEXT column - dropping it
-- and switching every reader across the app to a join would touch ~12
-- files that only ever display it. Instead ferry_routes gains a new
-- direction_id FK, and a trigger keeps the existing `direction` text
-- column automatically in sync whenever a direction is renamed - every
-- existing read of ferry_routes.direction across the app keeps working
-- unchanged and automatically reflects edits.
--
-- bookings.direction is intentionally left as a free-text snapshot (no
-- FK ever existed there, and shouldn't now - a past booking's recorded
-- direction is a historical fact, not something that should change
-- retroactively if a direction is later renamed). Its CHECK constraint
-- is only loosened so future direction names beyond the original 2
-- aren't rejected at insert time.
-- =====================================================================

CREATE TABLE directions (
    direction_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    description        TEXT,
    resort_id           INTEGER REFERENCES resorts(resort_id), -- NULL = both resorts
    status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    display_order         INTEGER NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_directions_updated_at
    BEFORE UPDATE ON directions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO directions (name, resort_id, status, display_order) VALUES
('Resort to City', NULL, 'active', 1),
('City to Resort', NULL, 'active', 2);

ALTER TABLE ferry_routes ADD COLUMN direction_id INTEGER REFERENCES directions(direction_id);

UPDATE ferry_routes fr
SET direction_id = d.direction_id
FROM directions d
WHERE fr.direction = d.name;

ALTER TABLE ferry_routes ALTER COLUMN direction_id SET NOT NULL;

-- Drop the old hardcoded-2-value CHECK constraints (Postgres's default
-- auto-generated names for an inline, unnamed column CHECK - same
-- naming convention already relied on in 0004_department_approval.sql's
-- `booking_approvals_action_check` drop).
ALTER TABLE ferry_routes DROP CONSTRAINT ferry_routes_direction_check;
ALTER TABLE bookings DROP CONSTRAINT bookings_direction_check;

-- Keeps ferry_routes.direction (the plain-text display column every
-- other part of the app already reads) automatically in sync whenever
-- a direction is renamed in Direction Management.
CREATE OR REPLACE FUNCTION sync_ferry_routes_direction()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.name IS DISTINCT FROM OLD.name THEN
        UPDATE ferry_routes SET direction = NEW.name WHERE direction_id = NEW.direction_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_ferry_routes_direction
    AFTER UPDATE OF name ON directions
    FOR EACH ROW EXECUTE FUNCTION sync_ferry_routes_direction();
