-- =====================================================================
-- Read-only candidate-finder functions for the SLA/inactive-approver
-- escalation Scheduled Function. Written as SQL rather than fought
-- through the supabase-js query builder because they need a genuine
-- cross-table time comparison (now() - bookings.current_approval_assigned_at
-- > department_approval_config.sla_hours) that isn't cleanly
-- expressible via PostgREST filters. Each returns candidate rows only -
-- the actual escalation (with its compare-and-swap safety) happens in
-- Node via approval.js's escalateApproval(), exactly like
-- get_remaining_seats() is a read-only RPC that Node then acts on.
-- =====================================================================

-- Bookings whose department has SLA auto-escalation enabled and have
-- sat with their current approver longer than that department's
-- configured sla_hours.
DROP FUNCTION IF EXISTS find_sla_overdue_bookings();
CREATE OR REPLACE FUNCTION find_sla_overdue_bookings()
RETURNS TABLE(booking_id INTEGER, status_id INTEGER, current_approver_id INTEGER, department_id INTEGER, resort_id INTEGER) AS $$
BEGIN
    RETURN QUERY
    SELECT b.booking_id, b.status_id, b.current_approver_id, u.department_id, u.resort_id
    FROM bookings b
    JOIN users u ON u.user_id = b.user_id
    JOIN booking_status bs ON bs.status_id = b.status_id
    JOIN department_approval_config dac ON dac.department_id = u.department_id AND dac.resort_id = u.resort_id
    WHERE bs.status_name LIKE 'Pending%'
      AND dac.approval_mode = 'department_hierarchy'
      AND dac.auto_escalation_enabled = true
      AND dac.sla_hours IS NOT NULL
      AND dac.sla_hours > 0
      AND now() - b.current_approval_assigned_at > (dac.sla_hours || ' hours')::interval;
END;
$$ LANGUAGE plpgsql STABLE;

-- Bookings whose CURRENT approver has since been deactivated - this
-- must escalate regardless of a department's SLA/auto_escalation_enabled
-- settings, since "the assigned person literally cannot act" is a
-- distinct trigger from a timeout (see the project's plan doc,
-- "Corrections from validation" #4).
DROP FUNCTION IF EXISTS find_inactive_approver_bookings();
CREATE OR REPLACE FUNCTION find_inactive_approver_bookings()
RETURNS TABLE(booking_id INTEGER, status_id INTEGER, current_approver_id INTEGER, department_id INTEGER, resort_id INTEGER) AS $$
BEGIN
    RETURN QUERY
    SELECT b.booking_id, b.status_id, b.current_approver_id, u.department_id, u.resort_id
    FROM bookings b
    JOIN users u ON u.user_id = b.user_id
    JOIN booking_status bs ON bs.status_id = b.status_id
    JOIN department_approval_config dac ON dac.department_id = u.department_id AND dac.resort_id = u.resort_id
    JOIN users approver ON approver.user_id = b.current_approver_id
    WHERE bs.status_name LIKE 'Pending%'
      AND dac.approval_mode = 'department_hierarchy'
      AND approver.status = 'inactive';
END;
$$ LANGUAGE plpgsql STABLE;
