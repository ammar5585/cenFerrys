-- =====================================================================
-- Multi-resort support: adds a resorts table, replaces the flat
-- 8-department list with the 16 standard departments, and makes
-- department_approval_config keyed by (resort_id, department_id) so
-- each resort has a fully independent approval hierarchy per
-- department. bookings/booking_approvals are confirmed empty before
-- this runs, so the department_id replacement is a clean break with no
-- historical rows to remap.
-- =====================================================================

BEGIN;

-- department_approval_config has no dependents other than its own
-- updated_at trigger (recreated below) - safe to drop and recreate
-- with the new composite PK rather than ALTER it column-by-column.
DROP TABLE department_approval_config;

-- users.department_id -> NULL via ON DELETE SET NULL; booking_approvals
-- has 0 rows so its RESTRICT default can't fire.
DELETE FROM departments;

CREATE TABLE resorts (
    resort_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    resort_name TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);
INSERT INTO resorts (resort_name) VALUES ('CGLM'), ('CMLM');

ALTER TABLE departments ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'));
INSERT INTO departments (department_name) VALUES
    ('Human Resources'), ('Information Technology'), ('Finance'), ('Front Office'),
    ('Housekeeping'), ('Engineering'), ('Food & Beverage Service'), ('Culinary'),
    ('Security'), ('Recreation'), ('Spa'), ('Sales & Marketing'),
    ('Reservations'), ('Laundry'), ('Administration'), ('Executive Office');

CREATE TABLE department_approval_config (
    resort_id               INTEGER NOT NULL REFERENCES resorts(resort_id) ON DELETE CASCADE,
    department_id           INTEGER NOT NULL REFERENCES departments(department_id) ON DELETE CASCADE,
    approval_mode           TEXT NOT NULL DEFAULT 'legacy' CHECK (approval_mode IN ('legacy', 'department_hierarchy')),
    manager_user_id         INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    assistant_manager_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    supervisor_user_id      INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    sla_hours               INTEGER,
    auto_escalation_enabled BOOLEAN NOT NULL DEFAULT true,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (resort_id, department_id)
);
CREATE TRIGGER trg_department_approval_config_updated_at
    BEFORE UPDATE ON department_approval_config
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO department_approval_config (resort_id, department_id, approval_mode)
    SELECT r.resort_id, d.department_id, 'legacy' FROM resorts r CROSS JOIN departments d;

ALTER TABLE users ADD COLUMN resort_id INTEGER REFERENCES resorts(resort_id);
UPDATE users SET resort_id = (SELECT resort_id FROM resorts WHERE resort_name = 'CGLM');

-- Remap the 8 existing seeded users' department_id (NULL after the
-- cascade above) to equivalent new departments.
UPDATE users SET department_id = (SELECT department_id FROM departments WHERE department_name = 'Front Office')
    WHERE username = 'staff.maria';
UPDATE users SET department_id = (SELECT department_id FROM departments WHERE department_name = 'Food & Beverage Service')
    WHERE username IN ('dept.angela', 'staff.john');
UPDATE users SET department_id = (SELECT department_id FROM departments WHERE department_name = 'Human Resources')
    WHERE username = 'hr.nadia';
UPDATE users SET department_id = (SELECT department_id FROM departments WHERE department_name = 'Administration')
    WHERE username IN ('admin', 'gm.richard', 'rm.susan', 'transport.tom');

ALTER TABLE users ALTER COLUMN resort_id SET NOT NULL;
ALTER TABLE users ALTER COLUMN department_id SET NOT NULL;

-- Denormalized, mirrors the existing department_id column on this table.
ALTER TABLE booking_approvals ADD COLUMN resort_id INTEGER REFERENCES resorts(resort_id);

COMMIT;
