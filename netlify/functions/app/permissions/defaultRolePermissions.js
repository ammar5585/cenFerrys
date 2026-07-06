// Baseline permission-key lists for the 8 built-in system roles - the
// exact same lists used to seed role_permissions in
// supabase/migrations/0012_permission_management.sql. "Reset to
// Default" for a system role deletes its current role_permissions rows
// and re-inserts from here; custom roles have no baseline to reset to
// (only Delete). Keep this in sync by hand if the seed migration's
// values ever change - there is deliberately no single source of truth
// shared with the DB seed, since the seed only runs once at migration
// time and this needs to remain available for repeated resets.

export const DEFAULT_ROLE_PERMISSIONS = {
    Administrator: [
        'dashboard.access', 'dashboard.view_admin', 'dashboard.view_security',
        'user_management.access', 'user_management.view', 'user_management.create',
        'user_management.edit', 'user_management.deactivate', 'user_management.delete',
        'user_management.reset_password', 'user_management.export', 'user_management.import',
        'user_management.view_import_history', 'user_management.manage_departments',
        'user_management.manage_roles', 'user_management.manage_user_permissions',
        'schedule_management.access', 'schedule_management.view', 'schedule_management.manage_schedules',
        'schedule_management.manage_routes', 'schedule_management.manage_directions', 'schedule_management.manage_holidays',
        'booking.access', 'booking.view_all', 'booking.admin_override', 'booking.print_manifest',
        'booking.hr_manual_booking', 'booking.override_capacity', 'booking.override_approval', 'booking.manage_seat_reservations',
        'approval_workflow.access', 'approval_workflow.manage_manager_availability',
        'approval_workflow.configure_hierarchy', 'approval_workflow.executive_override',
        'security.access', 'security.manage_manifest', 'security.manage_waiting_list',
        'reports.access', 'reports.view_admin',
        'branding.access', 'branding.manage',
        'settings.access', 'settings.manage', 'settings.manage_notifications',
        'audit_logs.access', 'audit_logs.view_activity', 'audit_logs.view_permission_changes', 'audit_logs.view_hr_manual_bookings', 'audit_logs.view_seat_reservations',
    ],
    'General Manager': [
        'dashboard.access', 'dashboard.view_manager',
        'approval_workflow.access', 'approval_workflow.view_history',
        'approval_workflow.manage_own_availability', 'approval_workflow.executive_override',
        'reports.access', 'reports.view_manager',
    ],
    'Resident Manager': [
        'dashboard.access', 'dashboard.view_manager',
        'approval_workflow.access', 'approval_workflow.view_history',
        'approval_workflow.manage_own_availability', 'approval_workflow.executive_override',
        'reports.access', 'reports.view_manager',
    ],
    'HR Manager': [
        'dashboard.access', 'dashboard.view_manager',
        'approval_workflow.access', 'approval_workflow.view_history',
        'approval_workflow.manage_own_availability', 'approval_workflow.executive_override',
        'security.access', 'security.manage_waiting_list',
        'reports.access', 'reports.view_admin', 'reports.view_manager',
        'booking.access', 'booking.view_all',
        'booking.hr_manual_booking', 'booking.override_capacity', 'booking.override_approval', 'booking.manage_seat_reservations',
        'audit_logs.access', 'audit_logs.view_hr_manual_bookings', 'audit_logs.view_seat_reservations',
    ],
    'Transport Coordinator': [
        'dashboard.access', 'dashboard.view_transport',
        'booking.access', 'booking.view_manifest', 'booking.view_transport_schedules', 'booking.print_manifest',
    ],
    'Department Manager': [
        'dashboard.access', 'dashboard.view_manager',
        'approval_workflow.access', 'approval_workflow.view_department_requests',
    ],
    Staff: [
        'dashboard.access', 'dashboard.view_staff',
        'booking.access', 'booking.create_own', 'booking.view_own', 'booking.cancel_own',
    ],
    Security: [
        'dashboard.access', 'dashboard.view_security',
        'security.access', 'security.manage_manifest', 'security.manage_waiting_list',
    ],
};
