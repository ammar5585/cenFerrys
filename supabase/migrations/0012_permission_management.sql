-- =====================================================================
-- User Permission Management: granular RBAC layered on top of the
-- existing role system. `permissions` is a fixed, code-owned catalog
-- (permission_id doubles as the stable JWT bitmask bit index - IDENTITY
-- columns are never reused/renumbered by Postgres even after a delete,
-- and this app's convention is to soft-deprecate via is_active rather
-- than ever deleting a seeded lookup row, so permission_id is safe to
-- use directly as the bit position with no separate column needed).
-- `role_permissions` seed reproduces EXACTLY today's 53 requireRole()
-- call sites + 8 sidebar gates (verified against the live route files,
-- not guessed) so this migration changes zero existing user's access
-- on its own - only the mechanism checking it will change, in later
-- application-code commits. See ferry-portal-netlify's plan doc.
-- =====================================================================

-- ---------------------------------------------------------------------
-- roles: mark the 8 built-in roles as system roles (rename/delete
-- blocked both in the admin UI and here, via trigger, as defense in
-- depth - several places in the app have business logic tied to these
-- exact role_name strings, e.g. approval.js's APPROVAL_CHAIN).
-- ---------------------------------------------------------------------
ALTER TABLE roles ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT false;

UPDATE roles SET is_system = true WHERE role_name IN (
    'Administrator', 'General Manager', 'Resident Manager', 'HR Manager',
    'Transport Coordinator', 'Department Manager', 'Staff', 'Security'
);

CREATE OR REPLACE FUNCTION protect_system_roles() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.is_system THEN
            RAISE EXCEPTION 'System roles cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.is_system AND NEW.role_name IS DISTINCT FROM OLD.role_name THEN
        RAISE EXCEPTION 'System roles cannot be renamed';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_system_roles
    BEFORE UPDATE OR DELETE ON roles
    FOR EACH ROW EXECUTE FUNCTION protect_system_roles();

-- ---------------------------------------------------------------------
-- permissions: fixed catalog. is_module_access marks each category's
-- one master toggle row ("<category>.access") - turning it off for a
-- role/user hides every fine permission in that category regardless of
-- individual grants (getEffectivePermissions() enforces this in code).
-- ---------------------------------------------------------------------
CREATE TABLE permissions (
    permission_id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    permission_key   TEXT NOT NULL UNIQUE,
    category         TEXT NOT NULL,
    category_label   TEXT NOT NULL,
    label            TEXT NOT NULL,
    description      TEXT,
    is_module_access BOOLEAN NOT NULL DEFAULT false,
    display_order    INTEGER NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insertion order is significant (see file header) - matches
-- permissions.js's PERMISSION_BITS map 1:1 by permission_key, not by
-- position, so re-ordering this list is actually safe; do not, however,
-- delete or renumber existing rows once this migration has shipped.
INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
-- Dashboard
('dashboard.access',        'dashboard', 'Dashboard', 'Access Dashboard', 'Base dashboard access - granted to every role.', true, 1),
('dashboard.view_admin',    'dashboard', 'Dashboard', 'View Administrator Dashboard', NULL, false, 2),
('dashboard.view_manager',  'dashboard', 'Dashboard', 'View Manager Dashboard', NULL, false, 3),
('dashboard.view_transport','dashboard', 'Dashboard', 'View Transport Dashboard', NULL, false, 4),
('dashboard.view_staff',    'dashboard', 'Dashboard', 'View Staff Dashboard', NULL, false, 5),
('dashboard.view_security', 'dashboard', 'Dashboard', 'View Security Dashboard', NULL, false, 6),

-- User Management (includes Departments)
('user_management.access',                 'user_management', 'User Management', 'Access User Management', NULL, true, 10),
('user_management.view',                   'user_management', 'User Management', 'View Users', NULL, false, 11),
('user_management.create',                 'user_management', 'User Management', 'Create Users', NULL, false, 12),
('user_management.edit',                   'user_management', 'User Management', 'Edit Users', NULL, false, 13),
('user_management.deactivate',              'user_management', 'User Management', 'Activate / Deactivate Users', NULL, false, 14),
('user_management.delete',                  'user_management', 'User Management', 'Delete Users', NULL, false, 15),
('user_management.reset_password',           'user_management', 'User Management', 'Reset User Passwords', NULL, false, 16),
('user_management.export',                   'user_management', 'User Management', 'Export Users (CSV)', NULL, false, 17),
('user_management.import',                   'user_management', 'User Management', 'Bulk Import Users', NULL, false, 18),
('user_management.view_import_history',       'user_management', 'User Management', 'View Import History', NULL, false, 19),
('user_management.manage_departments',        'user_management', 'User Management', 'Manage Departments', NULL, false, 20),
('user_management.manage_roles',              'user_management', 'User Management', 'Manage Roles & Permissions', 'Administrator-only regardless of grant - see guards on /admin/roles*.', false, 21),
('user_management.manage_user_permissions',    'user_management', 'User Management', 'Manage Per-User Permission Overrides', 'Administrator-only regardless of grant.', false, 22),

-- Ferry Schedule Management (includes Routes, Directions, Holidays)
('schedule_management.access',            'schedule_management', 'Ferry Schedule Management', 'Access Ferry Schedule Management', NULL, true, 30),
('schedule_management.view',              'schedule_management', 'Ferry Schedule Management', 'View Schedules', NULL, false, 31),
('schedule_management.manage_schedules',   'schedule_management', 'Ferry Schedule Management', 'Create / Edit / Delete Schedules', NULL, false, 32),
('schedule_management.manage_routes',       'schedule_management', 'Ferry Schedule Management', 'Manage Ferry Routes', NULL, false, 33),
('schedule_management.manage_directions',    'schedule_management', 'Ferry Schedule Management', 'Manage Directions', NULL, false, 34),
('schedule_management.manage_holidays',       'schedule_management', 'Ferry Schedule Management', 'Manage Holidays', NULL, false, 35),

-- Ferry Booking (includes Transport passenger/manifest operations)
('booking.access',                  'booking', 'Ferry Booking', 'Access Ferry Booking', NULL, true, 40),
('booking.create_own',              'booking', 'Ferry Booking', 'Create Own Booking', NULL, false, 41),
('booking.view_own',                'booking', 'Ferry Booking', 'View Own Bookings', NULL, false, 42),
('booking.cancel_own',              'booking', 'Ferry Booking', 'Cancel Own Booking', NULL, false, 43),
('booking.view_all',                'booking', 'Ferry Booking', 'View All Bookings', NULL, false, 44),
('booking.admin_override',          'booking', 'Ferry Booking', 'Admin Override Booking', NULL, false, 45),
('booking.view_manifest',           'booking', 'Ferry Booking', 'View Today''s Passenger List', NULL, false, 46),
('booking.view_transport_schedules', 'booking', 'Ferry Booking', 'View Ferry Schedules (Transport)', NULL, false, 47),
('booking.print_manifest',           'booking', 'Ferry Booking', 'Print Manifest', NULL, false, 48),

-- Approval Workflow
('approval_workflow.access',                     'approval_workflow', 'Approval Workflow', 'Access Approval Workflow', NULL, true, 50),
('approval_workflow.manage_manager_availability',  'approval_workflow', 'Approval Workflow', 'Manage Manager Availability (Admin)', NULL, false, 51),
('approval_workflow.configure_hierarchy',           'approval_workflow', 'Approval Workflow', 'Configure Department Approval Hierarchy', NULL, false, 52),
('approval_workflow.view_history',                   'approval_workflow', 'Approval Workflow', 'View Approval History', NULL, false, 53),
('approval_workflow.manage_own_availability',         'approval_workflow', 'Approval Workflow', 'Manage Own Availability', NULL, false, 54),
('approval_workflow.view_department_requests',         'approval_workflow', 'Approval Workflow', 'View Department Requests', NULL, false, 55),
('approval_workflow.executive_override',                'approval_workflow', 'Approval Workflow', 'Executive Overview & Override', NULL, false, 56),

-- Security Module
('security.access',              'security', 'Security Module', 'Access Security Module', NULL, true, 60),
('security.manage_manifest',      'security', 'Security Module', 'Manage Passenger Manifest', NULL, false, 61),
('security.manage_waiting_list',   'security', 'Security Module', 'Manage Waiting List', NULL, false, 62),

-- Reports
('reports.access',      'reports', 'Reports', 'Access Reports', NULL, true, 70),
('reports.view_admin',   'reports', 'Reports', 'View Admin Reports', NULL, false, 71),
('reports.view_manager', 'reports', 'Reports', 'View Manager Reports', NULL, false, 72),

-- Website Branding
('branding.access', 'branding', 'Website Branding', 'Access Website Branding', NULL, true, 80),
('branding.manage',  'branding', 'Website Branding', 'Manage Branding', NULL, false, 81),

-- System Settings (includes Notifications config)
('settings.access',               'settings', 'System Settings', 'Access System Settings', NULL, true, 90),
('settings.manage',                'settings', 'System Settings', 'Manage Settings', NULL, false, 91),
('settings.manage_notifications',   'settings', 'System Settings', 'Manage Notification Settings', NULL, false, 92),

-- Audit Logs
('audit_logs.access',                 'audit_logs', 'Audit Logs', 'Access Audit Logs', NULL, true, 100),
('audit_logs.view_activity',           'audit_logs', 'Audit Logs', 'View Activity Logs', NULL, false, 101),
('audit_logs.view_permission_changes',  'audit_logs', 'Audit Logs', 'View Permission Change History', 'Administrator-only regardless of grant.', false, 102);

-- ---------------------------------------------------------------------
-- role_permissions: presence = granted. Seed reproduces today's exact
-- access, derived directly from grepping every requireRole() call site
-- and sidebar gate (not guessed) - see the route/role mapping in the
-- plan doc for the full derivation.
-- ---------------------------------------------------------------------
CREATE TABLE role_permissions (
    role_id       INTEGER NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    -- Administrator
    ('Administrator', 'dashboard.access'), ('Administrator', 'dashboard.view_admin'), ('Administrator', 'dashboard.view_security'),
    ('Administrator', 'user_management.access'), ('Administrator', 'user_management.view'), ('Administrator', 'user_management.create'),
    ('Administrator', 'user_management.edit'), ('Administrator', 'user_management.deactivate'), ('Administrator', 'user_management.delete'),
    ('Administrator', 'user_management.reset_password'), ('Administrator', 'user_management.export'), ('Administrator', 'user_management.import'),
    ('Administrator', 'user_management.view_import_history'), ('Administrator', 'user_management.manage_departments'),
    ('Administrator', 'user_management.manage_roles'), ('Administrator', 'user_management.manage_user_permissions'),
    ('Administrator', 'schedule_management.access'), ('Administrator', 'schedule_management.view'), ('Administrator', 'schedule_management.manage_schedules'),
    ('Administrator', 'schedule_management.manage_routes'), ('Administrator', 'schedule_management.manage_directions'), ('Administrator', 'schedule_management.manage_holidays'),
    ('Administrator', 'booking.access'), ('Administrator', 'booking.view_all'), ('Administrator', 'booking.admin_override'), ('Administrator', 'booking.print_manifest'),
    ('Administrator', 'approval_workflow.access'), ('Administrator', 'approval_workflow.manage_manager_availability'),
    ('Administrator', 'approval_workflow.configure_hierarchy'), ('Administrator', 'approval_workflow.executive_override'),
    ('Administrator', 'security.access'), ('Administrator', 'security.manage_manifest'), ('Administrator', 'security.manage_waiting_list'),
    ('Administrator', 'reports.access'), ('Administrator', 'reports.view_admin'),
    ('Administrator', 'branding.access'), ('Administrator', 'branding.manage'),
    ('Administrator', 'settings.access'), ('Administrator', 'settings.manage'), ('Administrator', 'settings.manage_notifications'),
    ('Administrator', 'audit_logs.access'), ('Administrator', 'audit_logs.view_activity'), ('Administrator', 'audit_logs.view_permission_changes'),

    -- General Manager
    ('General Manager', 'dashboard.access'), ('General Manager', 'dashboard.view_manager'),
    ('General Manager', 'approval_workflow.access'), ('General Manager', 'approval_workflow.view_history'),
    ('General Manager', 'approval_workflow.manage_own_availability'), ('General Manager', 'approval_workflow.executive_override'),
    ('General Manager', 'reports.access'), ('General Manager', 'reports.view_manager'),

    -- Resident Manager
    ('Resident Manager', 'dashboard.access'), ('Resident Manager', 'dashboard.view_manager'),
    ('Resident Manager', 'approval_workflow.access'), ('Resident Manager', 'approval_workflow.view_history'),
    ('Resident Manager', 'approval_workflow.manage_own_availability'), ('Resident Manager', 'approval_workflow.executive_override'),
    ('Resident Manager', 'reports.access'), ('Resident Manager', 'reports.view_manager'),

    -- HR Manager
    ('HR Manager', 'dashboard.access'), ('HR Manager', 'dashboard.view_manager'),
    ('HR Manager', 'approval_workflow.access'), ('HR Manager', 'approval_workflow.view_history'),
    ('HR Manager', 'approval_workflow.manage_own_availability'), ('HR Manager', 'approval_workflow.executive_override'),
    ('HR Manager', 'security.access'), ('HR Manager', 'security.manage_waiting_list'),
    ('HR Manager', 'reports.access'), ('HR Manager', 'reports.view_admin'), ('HR Manager', 'reports.view_manager'),

    -- Transport Coordinator
    ('Transport Coordinator', 'dashboard.access'), ('Transport Coordinator', 'dashboard.view_transport'),
    ('Transport Coordinator', 'booking.access'), ('Transport Coordinator', 'booking.view_manifest'),
    ('Transport Coordinator', 'booking.view_transport_schedules'), ('Transport Coordinator', 'booking.print_manifest'),

    -- Department Manager
    ('Department Manager', 'dashboard.access'), ('Department Manager', 'dashboard.view_manager'),
    ('Department Manager', 'approval_workflow.access'), ('Department Manager', 'approval_workflow.view_department_requests'),

    -- Staff
    ('Staff', 'dashboard.access'), ('Staff', 'dashboard.view_staff'),
    ('Staff', 'booking.access'), ('Staff', 'booking.create_own'), ('Staff', 'booking.view_own'), ('Staff', 'booking.cancel_own'),

    -- Security
    ('Security', 'dashboard.access'), ('Security', 'dashboard.view_security'),
    ('Security', 'security.access'), ('Security', 'security.manage_manifest'), ('Security', 'security.manage_waiting_list')
) AS rp(role_name, permission_key)
JOIN roles r ON r.role_name = rp.role_name
JOIN permissions p ON p.permission_key = rp.permission_key;

-- ---------------------------------------------------------------------
-- user_permission_overrides: a row overrides the role default in
-- either direction for one user/permission pair. Row absence = inherit
-- from role. "Reset to role default" = delete the row(s).
-- ---------------------------------------------------------------------
CREATE TABLE user_permission_overrides (
    override_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
    granted       BOOLEAN NOT NULL,
    created_by    INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, permission_id)
);

CREATE TRIGGER trg_user_permission_overrides_updated_at
    BEFORE UPDATE ON user_permission_overrides
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- permission_audit_log: structured, insert-only audit trail for every
-- role/permission change - mirrors the security_action_log (0009)
-- precedent rather than the generic free-text activity_logs, since
-- this data is sensitive enough to need real before/after fields. No
-- UPDATE/DELETE code path is ever written against this table, same
-- discipline as security_action_log.
-- ---------------------------------------------------------------------
CREATE TABLE permission_audit_log (
    audit_id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id    INTEGER NOT NULL REFERENCES users(user_id),
    target_type       TEXT NOT NULL CHECK (target_type IN ('role', 'user')),
    target_role_id     INTEGER REFERENCES roles(role_id),
    target_user_id      INTEGER REFERENCES users(user_id),
    action                TEXT NOT NULL CHECK (action IN (
                              'role_created', 'role_renamed', 'role_deleted',
                              'permission_granted', 'permission_revoked',
                              'permissions_copied', 'role_reset_to_default',
                              'user_override_granted', 'user_override_revoked', 'user_override_reset'
                          )),
    permission_id          INTEGER REFERENCES permissions(permission_id),
    previous_value          TEXT,
    new_value                TEXT,
    before_snapshot           JSONB,
    after_snapshot             JSONB,
    ip_address                  TEXT,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_permission_audit_log_target ON permission_audit_log(target_type, target_role_id, target_user_id);
CREATE INDEX idx_permission_audit_log_created ON permission_audit_log(created_at DESC);
