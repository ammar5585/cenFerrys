// Port of admin/activity_logs.php - paginated audit log viewer with search.

import { db, unwrap, unwrapPage } from '../db.js';
import { requireLogin } from '../guards.js';
import { hasPermission } from '../permissions.js';
import { accessDeniedResponse } from '../accessDenied.js';
import { renderShellForRequest } from '../shellHelper.js';
import { redirectTo } from '../response.js';
import { html, raw } from '../templates/html.js';
import { formatDateTime, formatDate, formatTime } from '../format.js';

const PER_PAGE = 25;

function tabsHtml(activeTab, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments) {
    if (!canViewPermissionChanges && !canViewHrManualBookings && !canViewSeatReservations && !canViewEmailLog && !canViewHodSeatAssignments) return '';
    const tabs = [`<li class="nav-item"><a class="nav-link ${activeTab === 'activity' ? 'active' : ''}" href="/admin/activity_logs">Activity Logs</a></li>`];
    if (canViewPermissionChanges) {
        tabs.push(`<li class="nav-item"><a class="nav-link ${activeTab === 'permissions' ? 'active' : ''}" href="/admin/activity_logs?tab=permissions">Permission Changes</a></li>`);
    }
    if (canViewHrManualBookings) {
        tabs.push(`<li class="nav-item"><a class="nav-link ${activeTab === 'hr_manual' ? 'active' : ''}" href="/admin/activity_logs?tab=hr_manual">HR Manual Bookings</a></li>`);
    }
    if (canViewSeatReservations) {
        tabs.push(`<li class="nav-item"><a class="nav-link ${activeTab === 'seat_reservations' ? 'active' : ''}" href="/admin/activity_logs?tab=seat_reservations">Seat Reservations</a></li>`);
    }
    if (canViewHodSeatAssignments) {
        tabs.push(`<li class="nav-item"><a class="nav-link ${activeTab === 'hod_seat_assignments' ? 'active' : ''}" href="/admin/activity_logs?tab=hod_seat_assignments">HOD Seat Assignments</a></li>`);
    }
    if (canViewEmailLog) {
        tabs.push(`<li class="nav-item"><a class="nav-link ${activeTab === 'email_log' ? 'active' : ''}" href="/admin/activity_logs?tab=email_log">Email Log</a></li>`);
    }
    return `<ul class="nav nav-tabs mb-3">${tabs.join('')}</ul>`;
}

async function emailLogBody(page, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments) {
    const { rows: pageRows, total } = unwrapPage(
        await db()
            .from('email_audit_log')
            .select(
                'log_id, event_type, setting_key, previous_value, new_value, recipient_email, template_key, error_message, created_at, ' +
                    'actor:users!email_audit_log_actor_user_id_fkey(full_name)',
                { count: 'exact' }
            )
            .order('created_at', { ascending: false })
            .range((page - 1) * PER_PAGE, page * PER_PAGE - 1)
    );

    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

    const rowsHtml = pageRows
        .map((r) => {
            const detail =
                r.event_type === 'settings_updated' || r.event_type === 'template_updated'
                    ? `${r.setting_key ?? ''}`
                    : r.template_key ?? '';
            return html`<tr>
                <td>${formatDateTime(r.created_at)}</td>
                <td>${r.event_type.replace(/_/g, ' ')}</td>
                <td>${r.actor?.full_name ?? 'System'}</td>
                <td>${detail}</td>
                <td>${r.recipient_email ?? ''}</td>
                <td>${r.error_message ?? ''}</td>
            </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    const pagination =
        totalPages > 1
            ? `<nav class="mt-3"><ul class="pagination pagination-sm">${Array.from({ length: totalPages }, (_, i) => i + 1)
                  .map((p) => `<li class="page-item ${p === page ? 'active' : ''}"><a class="page-link" href="?tab=email_log&page=${p}">${p}</a></li>`)
                  .join('')}</ul></nav>`
            : '';

    return html`
<h5 class="mb-3"><i class="bi bi-envelope-at"></i> Email Log</h5>
${raw(tabsHtml('email_log', canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments))}
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Date/Time</th><th>Event</th><th>By</th><th>Setting / Template</th><th>Recipient</th><th>Error</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="6" class="text-center text-muted py-4">No email events recorded.</td></tr>')}</tbody>
</table></div></div>
${raw(pagination)}`;
}

async function seatReservationsLogBody(page, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments) {
    const { rows: pageRows, total } = unwrapPage(
        await db()
            .from('seat_reservation_log')
            .select(
                'log_id, reservation_type, employee_name_snapshot, department_name_snapshot, contact_name_snapshot, seats, start_date, end_date, direction, action, reason, created_at, ' +
                    'resorts(resort_name), actor:users!seat_reservation_log_actor_user_id_fkey(full_name)',
                { count: 'exact' }
            )
            .order('created_at', { ascending: false })
            .range((page - 1) * PER_PAGE, page * PER_PAGE - 1)
    );

    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

    const rowsHtml = pageRows
        .map((r) => {
            const who = r.employee_name_snapshot || r.department_name_snapshot || '-';
            return html`<tr>
                <td>${formatDateTime(r.created_at)}</td>
                <td>${r.action}</td>
                <td>${(r.reservation_type ?? '').replace(/_/g, ' ')}</td>
                <td>${who}</td>
                <td>${r.contact_name_snapshot ?? ''}</td>
                <td>${r.direction ?? '-'}</td>
                <td>${r.resorts?.resort_name ?? '-'}</td>
                <td>${r.seats ?? ''}</td>
                <td>${r.start_date ?? ''} &rarr; ${r.end_date ?? ''}</td>
                <td>${r.actor?.full_name ?? 'System'}</td>
                <td>${r.reason ?? ''}</td>
            </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    const pagination =
        totalPages > 1
            ? `<nav class="mt-3"><ul class="pagination pagination-sm">${Array.from({ length: totalPages }, (_, i) => i + 1)
                  .map((p) => `<li class="page-item ${p === page ? 'active' : ''}"><a class="page-link" href="?tab=seat_reservations&page=${p}">${p}</a></li>`)
                  .join('')}</ul></nav>`
            : '';

    return html`
<h5 class="mb-3"><i class="bi bi-bookmark-star"></i> Seat Reservation Log</h5>
${raw(tabsHtml('seat_reservations', canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments))}
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Date/Time</th><th>Action</th><th>Type</th><th>Employee / Department</th><th>Name</th><th>Direction</th><th>Resort</th><th>Seats</th><th>Period</th><th>By</th><th>Reason</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="11" class="text-center text-muted py-4">No seat reservation actions recorded.</td></tr>')}</tbody>
</table></div></div>
${raw(pagination)}`;
}

async function hrManualBookingsBody(page, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments) {
    const { rows: pageRows, total } = unwrapPage(
        await db()
            .from('hr_manual_booking_log')
            .select(
                'log_id, employee_id_snapshot, employee_name_snapshot, direction, travel_date, cutoff_overridden, capacity_overridden, approval_overridden, remarks, created_at, ' +
                    'resorts(resort_name), created_by:users!hr_manual_booking_log_created_by_user_id_fkey(full_name), ferry_schedule(departure_time)',
                { count: 'exact' }
            )
            .order('created_at', { ascending: false })
            .range((page - 1) * PER_PAGE, page * PER_PAGE - 1)
    );

    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

    const rowsHtml = pageRows
        .map((r) => {
            const overrides = [
                r.cutoff_overridden ? 'Cut-off' : null,
                r.capacity_overridden ? 'Capacity' : null,
                r.approval_overridden ? 'Approval' : null,
            ].filter(Boolean);
            return html`<tr>
                <td>${formatDateTime(r.created_at)}</td>
                <td>${r.employee_name_snapshot} <small class="text-muted">${r.employee_id_snapshot}</small></td>
                <td>${r.direction ?? '-'}${r.ferry_schedule ? html` - ${formatDate(r.travel_date)}, ${formatTime(r.ferry_schedule.departure_time)}` : ''}</td>
                <td>${r.resorts?.resort_name ?? '-'}</td>
                <td>${r.created_by?.full_name ?? 'Unknown'}</td>
                <td>${overrides.length ? overrides.join(', ') : 'None'}</td>
                <td>${r.remarks ?? ''}</td>
            </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    const pagination =
        totalPages > 1
            ? `<nav class="mt-3"><ul class="pagination pagination-sm">${Array.from({ length: totalPages }, (_, i) => i + 1)
                  .map((p) => `<li class="page-item ${p === page ? 'active' : ''}"><a class="page-link" href="?tab=hr_manual&page=${p}">${p}</a></li>`)
                  .join('')}</ul></nav>`
            : '';

    return html`
<h5 class="mb-3"><i class="bi bi-person-lock"></i> HR Manual Booking Log</h5>
${raw(tabsHtml('hr_manual', canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments))}
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Date/Time</th><th>Employee</th><th>Schedule</th><th>Resort</th><th>Created By</th><th>Overrides Used</th><th>Remarks</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="7" class="text-center text-muted py-4">No HR manual bookings recorded.</td></tr>')}</tbody>
</table></div></div>
${raw(pagination)}`;
}

async function permissionChangesBody(page, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments) {
    const { rows: pageRows, total } = unwrapPage(
        await db()
            .from('permission_audit_log')
            .select(
                'audit_id, target_type, action, previous_value, new_value, before_snapshot, after_snapshot, created_at, ' +
                    'actor:users!permission_audit_log_actor_user_id_fkey(full_name), ' +
                    'target_role:roles(role_name), target_user:users!permission_audit_log_target_user_id_fkey(full_name)',
                { count: 'exact' }
            )
            .order('created_at', { ascending: false })
            .range((page - 1) * PER_PAGE, page * PER_PAGE - 1)
    );

    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

    const rowsHtml = pageRows
        .map((r) => {
            const target = r.target_type === 'role' ? (r.target_role?.role_name ?? `role #${r.audit_id}`) : (r.target_user?.full_name ?? 'unknown user');
            const changeSummary = r.before_snapshot || r.after_snapshot
                ? `${(r.before_snapshot ?? []).length} -> ${(r.after_snapshot ?? []).length} permissions`
                : `${r.previous_value ?? ''} -> ${r.new_value ?? ''}`;
            return html`<tr>
                <td>${formatDateTime(r.created_at)}</td><td>${r.actor?.full_name ?? 'Unknown'}</td>
                <td>${r.action.replace(/_/g, ' ')}</td><td>${r.target_type}: ${target}</td><td>${changeSummary}</td>
            </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    const pagination =
        totalPages > 1
            ? `<nav class="mt-3"><ul class="pagination pagination-sm">${Array.from({ length: totalPages }, (_, i) => i + 1)
                  .map((p) => `<li class="page-item ${p === page ? 'active' : ''}"><a class="page-link" href="?tab=permissions&page=${p}">${p}</a></li>`)
                  .join('')}</ul></nav>`
            : '';

    return html`
<h5 class="mb-3"><i class="bi bi-shield-lock"></i> Permission Change History</h5>
${raw(tabsHtml('permissions', canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments))}
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Date/Time</th><th>Administrator</th><th>Action</th><th>Target</th><th>Change</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="5" class="text-center text-muted py-4">No permission changes recorded.</td></tr>')}</tbody>
</table></div></div>
${raw(pagination)}`;
}

async function hodSeatAssignmentsBody(page, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments) {
    const { rows: pageRows, total } = unwrapPage(
        await db()
            .from('hod_seat_assignment_log')
            .select(
                'log_id, direction, travel_date, department_name_snapshot, action, ' +
                    'employee_assigned_name_snapshot, employee_assigned_id_snapshot, employee_removed_name_snapshot, employee_removed_id_snapshot, remarks, created_at, ' +
                    'resorts(resort_name), assigned_by:users!hod_seat_assignment_log_assigned_by_user_id_fkey(full_name)',
                { count: 'exact' }
            )
            .order('created_at', { ascending: false })
            .range((page - 1) * PER_PAGE, page * PER_PAGE - 1)
    );

    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

    const rowsHtml = pageRows
        .map((r) => {
            const assigned = r.employee_assigned_name_snapshot ? `${r.employee_assigned_name_snapshot} (${r.employee_assigned_id_snapshot ?? ''})` : '-';
            const removed = r.employee_removed_name_snapshot ? `${r.employee_removed_name_snapshot} (${r.employee_removed_id_snapshot ?? ''})` : '-';
            return html`<tr>
                <td>${formatDateTime(r.created_at)}</td>
                <td>${r.action.replace(/_/g, ' ')}</td>
                <td>${r.department_name_snapshot ?? '-'}</td>
                <td>${r.direction ?? '-'}${r.travel_date ? html` - ${formatDate(r.travel_date)}` : ''}</td>
                <td>${r.resorts?.resort_name ?? '-'}</td>
                <td>${assigned}</td>
                <td>${removed}</td>
                <td>${r.assigned_by?.full_name ?? 'System'}</td>
                <td>${r.remarks ?? ''}</td>
            </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    const pagination =
        totalPages > 1
            ? `<nav class="mt-3"><ul class="pagination pagination-sm">${Array.from({ length: totalPages }, (_, i) => i + 1)
                  .map((p) => `<li class="page-item ${p === page ? 'active' : ''}"><a class="page-link" href="?tab=hod_seat_assignments&page=${p}">${p}</a></li>`)
                  .join('')}</ul></nav>`
            : '';

    return html`
<h5 class="mb-3"><i class="bi bi-bookmark-check"></i> HOD Seat Assignment Log</h5>
${raw(tabsHtml('hod_seat_assignments', canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments))}
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Date/Time</th><th>Action</th><th>Department</th><th>Route</th><th>Resort</th><th>Employee Assigned</th><th>Employee Removed</th><th>By</th><th>Remarks</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="9" class="text-center text-muted py-4">No HOD seat assignment actions recorded.</td></tr>')}</tbody>
</table></div></div>
${raw(pagination)}`;
}

export function registerAdminActivityLogRoutes(router) {
    router.get('/admin/activity_logs', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;

        const url = new URL(request.url);
        const canViewActivity = hasPermission(auth.user.perms, 'audit_logs.view_activity');
        const canViewPermissionChanges = hasPermission(auth.user.perms, 'audit_logs.view_permission_changes');
        const canViewHrManualBookings = hasPermission(auth.user.perms, 'audit_logs.view_hr_manual_bookings');
        const canViewSeatReservations = hasPermission(auth.user.perms, 'audit_logs.view_seat_reservations');
        const canViewEmailLog = hasPermission(auth.user.perms, 'audit_logs.view_email_log');
        const canViewHodSeatAssignments = hasPermission(auth.user.perms, 'audit_logs.view_hod_seat_assignments');
        if (!canViewActivity && !canViewPermissionChanges && !canViewHrManualBookings && !canViewSeatReservations && !canViewEmailLog && !canViewHodSeatAssignments) {
            return accessDeniedResponse({ request, auth, pageTitle: 'Activity Logs' });
        }

        const tab = url.searchParams.get('tab');
        if (tab === 'permissions') {
            if (!canViewPermissionChanges) return accessDeniedResponse({ request, auth, pageTitle: 'Permission Changes' });
            const page = Math.max(1, Number(url.searchParams.get('page') || 1));
            const body = await permissionChangesBody(page, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments);
            return renderShellForRequest({ request, auth, pageTitle: 'Permission Changes', path: '/admin/activity_logs', bodyHtml: body });
        }
        if (tab === 'hr_manual') {
            if (!canViewHrManualBookings) return accessDeniedResponse({ request, auth, pageTitle: 'HR Manual Bookings' });
            const page = Math.max(1, Number(url.searchParams.get('page') || 1));
            const body = await hrManualBookingsBody(page, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments);
            return renderShellForRequest({ request, auth, pageTitle: 'HR Manual Bookings', path: '/admin/activity_logs', bodyHtml: body });
        }
        if (tab === 'seat_reservations') {
            if (!canViewSeatReservations) return accessDeniedResponse({ request, auth, pageTitle: 'Seat Reservations' });
            const page = Math.max(1, Number(url.searchParams.get('page') || 1));
            const body = await seatReservationsLogBody(page, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments);
            return renderShellForRequest({ request, auth, pageTitle: 'Seat Reservations', path: '/admin/activity_logs', bodyHtml: body });
        }
        if (tab === 'hod_seat_assignments') {
            if (!canViewHodSeatAssignments) return accessDeniedResponse({ request, auth, pageTitle: 'HOD Seat Assignments' });
            const page = Math.max(1, Number(url.searchParams.get('page') || 1));
            const body = await hodSeatAssignmentsBody(page, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments);
            return renderShellForRequest({ request, auth, pageTitle: 'HOD Seat Assignments', path: '/admin/activity_logs', bodyHtml: body });
        }
        if (tab === 'email_log') {
            if (!canViewEmailLog) return accessDeniedResponse({ request, auth, pageTitle: 'Email Log' });
            const page = Math.max(1, Number(url.searchParams.get('page') || 1));
            const body = await emailLogBody(page, canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments);
            return renderShellForRequest({ request, auth, pageTitle: 'Email Log', path: '/admin/activity_logs', bodyHtml: body });
        }

        if (!canViewActivity) {
            // No tab param (or an unrecognized one) and this user can't see
            // the default Activity Logs tab - send them to whichever tab
            // they do have, rather than a bare Access Denied on a page they
            // partially have rights to.
            const fallbackTab = canViewPermissionChanges ? 'permissions' : canViewHrManualBookings ? 'hr_manual' : canViewSeatReservations ? 'seat_reservations' : canViewHodSeatAssignments ? 'hod_seat_assignments' : 'email_log';
            return redirectTo(`/admin/activity_logs?tab=${fallbackTab}`, { cookies: [auth.setCookie].filter(Boolean) });
        }

        const search = url.searchParams.get('search') || '';
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));

        let pageLogs, total;
        if (search) {
            // Multi-column search stays fetch-all + JS-filter, unchanged -
            // a true DB-side OR-across-columns search would need PostgREST's
            // .or() with an escaped ilike filter string, which this codebase
            // deliberately avoids elsewhere (see auth.js's forgot-password
            // lookup) since it's a raw filter-string-injection risk with
            // untrusted input. Search is not the unbounded-growth case in
            // normal use - most visits to this page have no search term.
            let logs = unwrap(
                await db()
                    .from('activity_logs')
                    .select('log_id, action, details, ip_address, created_at, users(full_name)')
                    .order('created_at', { ascending: false })
            );
            const needle = search.toLowerCase();
            logs = logs.filter(
                (l) =>
                    l.action.toLowerCase().includes(needle) ||
                    (l.details ?? '').toLowerCase().includes(needle) ||
                    (l.users?.full_name ?? '').toLowerCase().includes(needle)
            );
            total = logs.length;
            pageLogs = logs.slice((page - 1) * PER_PAGE, page * PER_PAGE);
        } else {
            // The common case (no search term) gets real DB-side
            // pagination - activity_logs is insert-only and never purged,
            // so fetching the whole table on every visit was the one
            // genuinely unbounded-growth query in this app.
            const result = unwrapPage(
                await db()
                    .from('activity_logs')
                    .select('log_id, action, details, ip_address, created_at, users(full_name)', { count: 'exact' })
                    .order('created_at', { ascending: false })
                    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1)
            );
            pageLogs = result.rows;
            total = result.total;
        }

        const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

        const rowsHtml = pageLogs
            .map(
                (log) => html`<tr>
                <td>${formatDateTime(log.created_at)}</td><td>${log.users?.full_name ?? 'System'}</td>
                <td>${log.action}</td><td>${log.details ?? ''}</td><td>${log.ip_address ?? ''}</td>
            </tr>`
            )
            .map((r) => r.toString())
            .join('');

        const pagination =
            totalPages > 1
                ? `<nav class="mt-3"><ul class="pagination pagination-sm">${Array.from({ length: totalPages }, (_, i) => i + 1)
                      .map((p) => `<li class="page-item ${p === page ? 'active' : ''}"><a class="page-link" href="?search=${encodeURIComponent(search)}&page=${p}">${p}</a></li>`)
                      .join('')}</ul></nav>`
                : '';

        const body = html`
<h5 class="mb-3"><i class="bi bi-clock-history"></i> Activity Logs</h5>
${raw(tabsHtml('activity', canViewPermissionChanges, canViewHrManualBookings, canViewSeatReservations, canViewEmailLog, canViewHodSeatAssignments))}
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-4"><input type="text" name="search" class="form-control" placeholder="Search action, user, or details" value="${search}"></div>
        <div class="col-md-2"><button class="btn btn-outline-primary btn-sm w-100" type="submit">Search</button></div>
    </form>
</div></div>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Date/Time</th><th>User</th><th>Action</th><th>Details</th><th>IP Address</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="5" class="text-center text-muted py-4">No activity recorded.</td></tr>')}</tbody>
</table></div></div>
${raw(pagination)}`;

        return renderShellForRequest({ request, auth, pageTitle: 'Activity Logs', path: '/admin/activity_logs', bodyHtml: body });
    });
}
