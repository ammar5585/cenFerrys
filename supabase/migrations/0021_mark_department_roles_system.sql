-- =====================================================================
-- Marks the 46 department job-title roles added in
-- 0020_add_department_roles.sql as System roles (is_system = true),
-- per the user's request - protects them from rename/delete via
-- protect_system_roles() (the trigger added in
-- 0012_permission_management.sql), same as the original 8 built-in
-- roles. Their permissions remain fully editable either way - is_system
-- only gates rename/delete, not permission assignment. These roles have
-- no entry in defaultRolePermissions.js, so their "Reset to Default"
-- button (now shown, since it's is_system-gated in the UI) simply
-- clears permissions back to none - a safe no-op-ish fallback, not a
-- crash, since that map lookup already handles a missing key as [].
-- =====================================================================

UPDATE roles SET is_system = true WHERE role_name IN (
    'Cluster General Manager', 'Secretary to Cluster General Manager',
    'Cluster Director of HR', 'Assistant HR Manager', 'HR Supervisor', 'Accomodation Manager',
    'Area Financial Controller', 'Chief Accountant', 'Finance Supervisor',
    'Cluster IT Manager', 'IT Supervisor',
    'Cluster Reservation Manager', 'Reservation Supervisor',
    'Front Office Manager', 'Duty Manager', 'Front Office Supervisor',
    'Cluster Executive Housekeeper', 'Assistant Housekeeping Manager', 'Housekeeping Supervisor',
    'Cluster Executive Chef', 'Executive Sous Chef', 'Cluster Pastry Chef', 'Kitchen Supervisor',
    'Cluster Chief Engineer', 'Maintenance Manager', 'Engineering Supervisor',
    'Cluster F&B Director', 'Food & Beverage Manager', 'Complex Restaurant Manager', 'Restaurant Manager', 'Assistant Restaurant Manager', 'Restaurant Supervisor',
    'Cluster Spa Manager', 'Cluster Assistant Spa Manager', 'Senior Spa Supervisor',
    'Cluster Recreation Manager', 'Cluster Recreation Supervisor', 'Recreation Coordinator',
    'Dive Center Manager',
    'Cluster Hygiene Manager', 'Cluster Quality Manager',
    'Sales Manager', 'Marketing Executive',
    'Cluster Security Manager', 'Security Supervisor', 'Security Officer'
);
