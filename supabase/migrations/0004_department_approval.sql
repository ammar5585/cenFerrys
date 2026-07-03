-- =====================================================================
-- Department-Based Approval Workflow
-- Adds a per-department 3-tier approval hierarchy (Department Manager ->
-- Assistant Manager -> Supervisor) that coexists with the existing
-- global GM -> RM -> HR chain. Each department opts in explicitly via
-- approval_mode; departments left at the default 'legacy' value (or
-- with no config row at all - see approval.js's null-check) keep using
-- the untouched existing routeBookingApproval() engine.
-- =====================================================================

-- ---------------------------------------------------------------------
-- department_approval_config: one row per department. Pre-seeded below
-- for admin-UI convenience (so the config form always has a row to
-- upsert against), but application code must not rely on a row always
-- existing - see approval.js's explicit null-check.
-- ---------------------------------------------------------------------
CREATE TABLE department_approval_config (
    department_id            INTEGER PRIMARY KEY REFERENCES departments(department_id) ON DELETE CASCADE,
    approval_mode              TEXT NOT NULL DEFAULT 'legacy' CHECK (approval_mode IN ('legacy', 'department_hierarchy')),
    manager_user_id             INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    assistant_manager_user_id   INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    supervisor_user_id          INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    sla_hours                   INTEGER, -- NULL or 0 = SLA timer disabled
    auto_escalation_enabled     BOOLEAN NOT NULL DEFAULT true,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_department_approval_config_updated_at
    BEFORE UPDATE ON department_approval_config
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO department_approval_config (department_id, approval_mode)
    SELECT department_id, 'legacy' FROM departments;

-- ---------------------------------------------------------------------
-- bookings: track when the CURRENT approver/status was assigned, so the
-- SLA escalation cron has something precise to compare against (the
-- general updated_at trigger fires on ANY update, not just routing
-- changes, so it can't be reused for this).
-- ---------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN current_approval_assigned_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------
-- booking_approvals: widen the audit trail for department-hierarchy
-- actions (escalation, HR override, reassignment, return-to-department).
-- department_id is denormalized here (captured at write-time), not
-- joined through users - the audit trail must reflect the department
-- that actually routed the decision, immune to a later department
-- transfer silently rewriting history.
-- ---------------------------------------------------------------------
ALTER TABLE booking_approvals
    ADD COLUMN approval_level TEXT,
    ADD COLUMN department_id INTEGER REFERENCES departments(department_id),
    ADD COLUMN original_approver_id INTEGER REFERENCES users(user_id),
    ADD COLUMN escalated_to_approver_id INTEGER REFERENCES users(user_id),
    ADD COLUMN escalation_reason TEXT,
    ADD COLUMN is_hr_override BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE booking_approvals DROP CONSTRAINT booking_approvals_action_check;
ALTER TABLE booking_approvals ADD CONSTRAINT booking_approvals_action_check
    CHECK (action IN ('approved', 'rejected', 'escalated', 'reassigned', 'returned'));

-- ---------------------------------------------------------------------
-- booking_status: new department-hierarchy statuses. Deliberately NO
-- 'Escalated' row - a booking's live status is always a concrete
-- "Pending {Level} Approval" or a terminal state. 'escalated' exists
-- only as a booking_approvals.action value (an audit event, not a
-- state-machine node); any "was this escalated" UI computes it via
-- EXISTS(...action='escalated'), not from booking_status.
-- Existing rows (ids 1-9) are untouched - the legacy chain keeps working.
-- ---------------------------------------------------------------------
INSERT INTO booking_status (status_name, badge_color) VALUES
('Pending Department Manager Approval', 'warning'),
('Pending Assistant Manager Approval', 'warning'),
('Pending Supervisor Approval', 'warning'),
('Pending HR Approval', 'warning');

-- ---------------------------------------------------------------------
-- expire_old_bookings(): fix a regression this feature would otherwise
-- introduce. The old WHERE clause exact-matched status_name = 'Pending',
-- which never matches the new 'Pending Department Manager Approval' etc.
-- - those bookings would never auto-expire past their travel date.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION expire_old_bookings()
RETURNS void AS $$
BEGIN
    UPDATE bookings
    SET status_id = (SELECT status_id FROM booking_status WHERE status_name = 'Expired')
    WHERE travel_date < CURRENT_DATE
      AND status_id IN (
          SELECT status_id FROM booking_status
          WHERE status_name LIKE 'Pending%' OR status_name LIKE 'Waiting%'
      );

    UPDATE bookings
    SET status_id = (SELECT status_id FROM booking_status WHERE status_name = 'Completed')
    WHERE travel_date < CURRENT_DATE
      AND status_id = (SELECT status_id FROM booking_status WHERE status_name = 'Approved');
END;
$$ LANGUAGE plpgsql;
