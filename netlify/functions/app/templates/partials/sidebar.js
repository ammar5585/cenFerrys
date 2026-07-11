// Port of includes/sidebar.php - role-based navigation. Active-link
// detection compares the current request path directly (cleaner than
// the PHP version's basename($_SERVER['SCRIPT_NAME']) trick, which
// existed only because every PHP page was its own file).

import { html, raw } from '../html.js';
import { hasPermission } from '../../permissions.js';
import { ROLE_ADMIN } from '../../session.js';

function navLink(path, icon, label, currentPath) {
    const active = currentPath === path ? 'active' : '';
    return html`<a class="nav-link ${active}" href="${path}">
            <i class="bi ${icon}" aria-hidden="true"></i> <span>${label}</span>
          </a>`;
}

/**
 * `permsHex` is the user's effective permission bitmask (session.js's
 * `user.perms`, a hex string) - each link is gated by its own
 * permission, not by a coarse per-role block, so a custom role or
 * per-user override that grants only some of what a built-in role has
 * today actually hides the rest.
 */
export function renderSidebar(permsHex, currentPath, isDeptApprover = false, companyName = 'Ferry Portal', siteLogo = '', roleName = null) {
    const can = (key) => hasPermission(permsHex, key);
    const isAdmin = roleName === ROLE_ADMIN;
    const links = [navLink('/dashboard', 'bi-speedometer2', 'Dashboard', currentPath)];

    if (can('user_management.access') || can('schedule_management.access') || can('approval_workflow.configure_hierarchy')
        || can('booking.view_all') || can('reports.view_admin') || can('audit_logs.access') || can('branding.access') || can('settings.access') || can('settings.manage_email') || can('booking.bulk_transfer_passengers') || isAdmin) {
        links.push(html`<div class="nav-heading">Administration</div>`);
        if (can('user_management.view')) links.push(navLink('/admin/users', 'bi-people', 'User Management', currentPath));
        if (can('user_management.import')) links.push(navLink('/admin/users/import', 'bi-file-earmark-arrow-up', 'Bulk Import Users', currentPath));
        if (can('user_management.manage_departments')) links.push(navLink('/admin/departments', 'bi-diagram-2', 'Departments', currentPath));
        if (can('user_management.manage_roles')) links.push(navLink('/admin/roles', 'bi-shield-lock', 'Roles & Permissions', currentPath));
        // Ferry Services (route-based, multi-stop) replaces the old Ferry
        // Schedules/Routes admin pages as the primary entry point -
        // Administrator-only per spec, gated by role rather than a
        // permission bitmask key (no such permission exists for this
        // System-Administrator-only feature). The old admin.js schedule
        // CRUD and admin_config.js route CRUD routes still exist (nothing
        // else has been migrated off them yet - see the Phase 1 plan) but
        // are deliberately unlinked here.
        if (isAdmin) links.push(navLink('/admin/ferry_services', 'bi-signpost-2', 'Ferry Services', currentPath));
        if (can('schedule_management.manage_directions')) links.push(navLink('/admin/directions', 'bi-arrow-left-right', 'Direction Management', currentPath));
        if (can('booking.manage_seat_reservations')) links.push(navLink('/admin/seat_reservations', 'bi-bookmark-star', 'Seat Reservations', currentPath));
        if (can('booking.bulk_transfer_passengers')) links.push(navLink('/admin/ferry_transfer', 'bi-arrow-left-right', 'Bulk Passenger Transfer', currentPath));
        if (can('schedule_management.manage_holidays')) links.push(navLink('/admin/holidays', 'bi-calendar-x', 'Holidays', currentPath));
        if (can('approval_workflow.manage_manager_availability')) links.push(navLink('/admin/manager_availability', 'bi-person-check', 'Manager Availability', currentPath));
        if (can('approval_workflow.configure_hierarchy')) links.push(navLink('/admin/department_approval', 'bi-diagram-3', 'Department Approval Config', currentPath));
        if (can('approval_workflow.executive_override')) links.push(navLink('/hr/overview', 'bi-globe', 'Executive Overview', currentPath));
        if (can('booking.view_all')) links.push(navLink('/admin/bookings', 'bi-journal-check', 'All Bookings', currentPath));
        if (can('reports.view_admin')) links.push(navLink('/admin/reports', 'bi-graph-up', 'Reports', currentPath));
        if (can('audit_logs.view_activity') || can('audit_logs.view_permission_changes') || can('audit_logs.view_hr_manual_bookings') || can('audit_logs.view_seat_reservations') || can('audit_logs.view_email_log')) {
            links.push(navLink('/admin/activity_logs', 'bi-clock-history', 'Activity Logs', currentPath));
        }
        if (can('branding.manage')) links.push(navLink('/admin/branding', 'bi-palette', 'Website Branding', currentPath));
        if (can('settings.manage')) links.push(navLink('/admin/settings', 'bi-gear', 'Settings', currentPath));
        if (can('settings.manage_email')) links.push(navLink('/admin/email_settings', 'bi-envelope-at', 'Email Settings', currentPath));
    }

    if (can('booking.create_own') || can('approval_workflow.manage_reserved_seats')) {
        links.push(html`<div class="nav-heading">Ferry Booking</div>`);
        if (can('booking.create_own')) {
            links.push(
                navLink('/staff/book', 'bi-plus-circle', 'New Booking', currentPath),
                navLink('/staff/my_bookings', 'bi-journal-text', 'Booking History', currentPath),
                navLink('/staff/profile', 'bi-person-circle', 'My Profile', currentPath)
            );
        }
        if (can('approval_workflow.manage_reserved_seats')) links.push(navLink('/manager/hod_seat_request', 'bi-bookmark-star', 'HOD Reserved Seat Request', currentPath));
    }

    const isLegacyApproverRole = can('approval_workflow.view_history') || can('approval_workflow.manage_own_availability');
    if (isLegacyApproverRole) {
        links.push(html`<div class="nav-heading">Approvals</div>`, navLink('/manager/approvals', 'bi-check2-square', 'Pending Approvals', currentPath));
        if (can('approval_workflow.view_history')) links.push(navLink('/manager/history', 'bi-clock-history', 'Approval History', currentPath));
        if (can('approval_workflow.manage_own_availability')) links.push(navLink('/manager/availability', 'bi-person-check', 'My Availability', currentPath));
        if (can('reports.view_manager')) links.push(navLink('/manager/reports', 'bi-graph-up', 'Reports', currentPath));
        // Executive Overview / override authority extends to GM and RM too,
        // not just HR - see routes/hr_overview.js's widened permission guard.
        if (can('approval_workflow.executive_override')) links.push(navLink('/hr/overview', 'bi-globe', 'Executive Overview', currentPath));
    } else if (isDeptApprover) {
        // A user assigned as a department's Primary/Secondary Approver
        // tier, but holding some other RBAC role
        // (e.g. Staff) - only /manager/approvals is login-open to them
        // today, so only link that (History/Availability/Reports stay
        // permission-gated and would 403 otherwise).
        links.push(
            html`<div class="nav-heading">Approvals</div>`,
            navLink('/manager/approvals', 'bi-check2-square', 'Pending Approvals', currentPath)
        );
    }

    if (can('approval_workflow.view_department_requests')) {
        links.push(
            html`<div class="nav-heading">Department</div>`,
            navLink('/manager/department_requests', 'bi-people', 'Department Requests', currentPath)
        );
    }

    if (can('dashboard.view_transport')) {
        links.push(html`<div class="nav-heading">Transport</div>`);
        if (can('booking.view_manifest')) links.push(navLink('/transport/passenger_list', 'bi-list-check', "Today's Passengers", currentPath));
        if (can('booking.view_transport_schedules')) links.push(navLink('/transport/schedules_view', 'bi-calendar3', 'Ferry Schedules', currentPath));
        if (can('booking.print_manifest')) links.push(navLink('/transport/manifest_print', 'bi-printer', 'Print Manifest', currentPath));
    }

    if (can('security.access')) {
        links.push(html`<div class="nav-heading">Security</div>`);
        if (can('security.manage_manifest')) links.push(navLink('/security/manifest', 'bi-clipboard-check', 'Passenger Manifest', currentPath));
        if (can('security.manage_waiting_list')) links.push(navLink('/security/waiting_list', 'bi-hourglass-split', 'Waiting List', currentPath));
        // Read-only visibility into the emergency transfer tool - Security
        // can see source/destination capacity but has no permission to
        // actually perform a transfer (booking.bulk_transfer_passengers).
        if (can('security.manage_manifest') && !can('booking.bulk_transfer_passengers')) links.push(navLink('/admin/ferry_transfer', 'bi-arrow-left-right', 'Bulk Passenger Transfer', currentPath));
    }

    links.push(html`<div class="nav-heading">Account</div>`);
    if (!can('booking.create_own')) {
        links.push(navLink('/staff/profile', 'bi-person-circle', 'My Profile', currentPath));
    }
    links.push(
        navLink('/auth/change_password', 'bi-key', 'Change Password', currentPath),
        navLink('/help', 'bi-question-circle', 'Help', currentPath),
        navLink('/about', 'bi-info-circle', 'About', currentPath),
        navLink('/auth/logout', 'bi-box-arrow-right', 'Logout', currentPath)
    );

    return html`
<aside class="sidebar" id="sidebar">
    <div class="sidebar-brand">
        ${siteLogo ? html`<img src="${siteLogo}" alt="${companyName} logo" class="sidebar-brand-logo">` : html`<i class="bi bi-water" aria-hidden="true"></i>`}
        <span>${companyName}</span>
    </div>
    <nav class="sidebar-nav">
        ${raw(links.map((l) => l.toString()).join(''))}
    </nav>
</aside>`;
}
