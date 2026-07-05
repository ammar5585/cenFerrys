// Port of includes/sidebar.php - role-based navigation. Active-link
// detection compares the current request path directly (cleaner than
// the PHP version's basename($_SERVER['SCRIPT_NAME']) trick, which
// existed only because every PHP page was its own file).

import { html, raw } from '../html.js';
import { ROLE_ADMIN, ROLE_STAFF, ROLE_GM, ROLE_RM, ROLE_HR, ROLE_DEPT_MGR, ROLE_TRANSPORT, ROLE_SECURITY } from '../../session.js';

function navLink(path, icon, label, currentPath) {
    const active = currentPath === path ? 'active' : '';
    return html`<a class="nav-link ${active}" href="${path}">
            <i class="bi ${icon}" aria-hidden="true"></i> <span>${label}</span>
          </a>`;
}

export function renderSidebar(roleName, currentPath, isDeptApprover = false, companyName = 'Ferry Portal', siteLogo = '') {
    const links = [navLink('/dashboard', 'bi-speedometer2', 'Dashboard', currentPath)];

    if (roleName === ROLE_ADMIN) {
        links.push(
            html`<div class="nav-heading">Administration</div>`,
            navLink('/admin/users', 'bi-people', 'User Management', currentPath),
            navLink('/admin/users/import', 'bi-file-earmark-arrow-up', 'Bulk Import Users', currentPath),
            navLink('/admin/departments', 'bi-diagram-2', 'Departments', currentPath),
            navLink('/admin/schedules', 'bi-calendar3', 'Ferry Schedules', currentPath),
            navLink('/admin/routes', 'bi-signpost-split', 'Routes', currentPath),
            navLink('/admin/holidays', 'bi-calendar-x', 'Holidays', currentPath),
            navLink('/admin/manager_availability', 'bi-person-check', 'Manager Availability', currentPath),
            navLink('/admin/department_approval', 'bi-diagram-3', 'Department Approval Config', currentPath),
            navLink('/hr/overview', 'bi-globe', 'Executive Overview', currentPath),
            navLink('/admin/bookings', 'bi-journal-check', 'All Bookings', currentPath),
            navLink('/admin/reports', 'bi-graph-up', 'Reports', currentPath),
            navLink('/admin/activity_logs', 'bi-clock-history', 'Activity Logs', currentPath),
            navLink('/admin/branding', 'bi-palette', 'Website Branding', currentPath),
            navLink('/admin/settings', 'bi-gear', 'Settings', currentPath)
        );
    }

    if (roleName === ROLE_STAFF) {
        links.push(
            html`<div class="nav-heading">My Bookings</div>`,
            navLink('/staff/book', 'bi-plus-circle', 'New Booking', currentPath),
            navLink('/staff/my_bookings', 'bi-journal-text', 'Booking History', currentPath),
            navLink('/staff/profile', 'bi-person-circle', 'My Profile', currentPath)
        );
    }

    const isLegacyApproverRole = [ROLE_GM, ROLE_RM, ROLE_HR].includes(roleName);
    if (isLegacyApproverRole) {
        links.push(
            html`<div class="nav-heading">Approvals</div>`,
            navLink('/manager/approvals', 'bi-check2-square', 'Pending Approvals', currentPath),
            navLink('/manager/history', 'bi-clock-history', 'Approval History', currentPath),
            navLink('/manager/availability', 'bi-person-check', 'My Availability', currentPath),
            navLink('/manager/reports', 'bi-graph-up', 'Reports', currentPath)
        );
        // Executive Overview / override authority extends to GM and RM too,
        // not just HR - see routes/hr_overview.js's widened role guard.
        links.push(navLink('/hr/overview', 'bi-globe', 'Executive Overview', currentPath));
    } else if (isDeptApprover) {
        // A user assigned as a department's Manager/Assistant
        // Manager/Supervisor tier, but holding some other RBAC role
        // (e.g. Staff) - only /manager/approvals is role-open to them
        // today, so only link that (History/Availability/Reports stay
        // GM/RM/HR-gated and would 403 otherwise).
        links.push(
            html`<div class="nav-heading">Approvals</div>`,
            navLink('/manager/approvals', 'bi-check2-square', 'Pending Approvals', currentPath)
        );
    }

    if (roleName === ROLE_DEPT_MGR) {
        links.push(
            html`<div class="nav-heading">Department</div>`,
            navLink('/manager/department_requests', 'bi-people', 'Department Requests', currentPath)
        );
    }

    if (roleName === ROLE_TRANSPORT) {
        links.push(
            html`<div class="nav-heading">Transport</div>`,
            navLink('/transport/passenger_list', 'bi-list-check', "Today's Passengers", currentPath),
            navLink('/transport/schedules_view', 'bi-calendar3', 'Ferry Schedules', currentPath),
            navLink('/transport/manifest_print', 'bi-printer', 'Print Manifest', currentPath)
        );
    }

    if (roleName === ROLE_SECURITY) {
        links.push(
            html`<div class="nav-heading">Security</div>`,
            navLink('/security/manifest', 'bi-clipboard-check', 'Passenger Manifest', currentPath),
            navLink('/security/waiting_list', 'bi-hourglass-split', 'Waiting List', currentPath)
        );
    }

    links.push(html`<div class="nav-heading">Account</div>`);
    if (roleName !== ROLE_STAFF) {
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
