-- =====================================================================
-- HOD Self-Service Reserved Seats: lets a Department Manager (or any
-- role granted this permission) request, assign, and cancel their OWN
-- department's HOD reserved seat blocks directly, rather than relying
-- on Security/HR/Administrator to do it for them (routes/security.js's
-- existing assign-only flow, 0023_hod_seat_assignment.sql). All
-- business logic is reused as-is from hodSeatAssignment.js; this
-- migration only adds the new permission catalog row and its default
-- grant to Department Manager.
-- =====================================================================

INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
('approval_workflow.manage_reserved_seats', 'approval_workflow', 'Approval Workflow', 'Manage Department Reserved Seats',
    'Request, assign, and cancel HOD reserved seat allocations for one''s own department.', false, 57)
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('Department Manager', 'approval_workflow.manage_reserved_seats')
) AS rp(role_name, permission_key)
JOIN roles r ON r.role_name = rp.role_name
JOIN permissions p ON p.permission_key = rp.permission_key
ON CONFLICT (role_id, permission_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
