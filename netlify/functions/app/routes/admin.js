// Port of admin/dashboard.php, admin/users.php, admin/schedules.php,
// admin/manager_availability.php (Phase 2 scope; routes.js, holidays.js,
// settings.js, activity_logs.js, reports.js, bookings.js land in Phase 3).

import { db, unwrap } from '../db.js';
import { requireRole } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { hashPassword, generateTempPassword } from '../auth.js';
import { getRemainingSeats } from '../seats.js';
import { logActivity, clientIp } from '../activity.js';
import { uploadProfilePicture } from '../uploads.js';
import { redirectTo, notFound, csvResponse } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatTime, timeAgo, greeting } from '../format.js';
import { ROLE_ADMIN } from '../session.js';

const WEEKDAY_OPTIONS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) {
        if (out[key] !== undefined) {
            out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
        } else {
            out[key] = value;
        }
    }
    return out;
}

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------
function statCard({ value, label, icon }) {
    return html`<div class="col-sm-6 col-lg-3">
    <div class="stat-card d-flex align-items-center gap-3">
        <div class="stat-icon-badge"><i class="bi ${icon}"></i></div>
        <div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>
    </div>
</div>`;
}

async function adminDashboardBody(fullName) {
    const today = new Date().toISOString().slice(0, 10);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];

    const totalStaff = (await db().from('users').select('*', { count: 'exact', head: true }).eq('status', 'active')).count || 0;
    const todaysBookings = (await db().from('bookings').select('*', { count: 'exact', head: true }).eq('travel_date', today)).count || 0;

    const statusCounts = {};
    for (const name of ['Approved', 'Rejected', 'Cancelled']) {
        const rows = unwrap(await db().from('booking_status').select('status_id').eq('status_name', name).limit(1));
        statusCounts[name] = rows.length
            ? (await db().from('bookings').select('*', { count: 'exact', head: true }).eq('status_id', rows[0].status_id)).count || 0
            : 0;
    }
    const waitingStatusIds = unwrap(await db().from('booking_status').select('status_id').like('status_name', 'Waiting%')).map((r) => r.status_id);
    const pendingApprovals = waitingStatusIds.length
        ? (await db().from('bookings').select('*', { count: 'exact', head: true }).in('status_id', waitingStatusIds)).count || 0
        : 0;

    const schedules = unwrap(
        await db()
            .from('ferry_schedule')
            .select('schedule_id, departure_time, capacity, weekdays, ferry_routes(direction)')
            .eq('status', 'active')
    );
    const todaysTrips = schedules.filter((s) => s.weekdays.includes(weekday));
    let availableSeatsTotal = 0;
    let fullyBookedCount = 0;
    const tripRows = [];
    for (const t of todaysTrips) {
        const { booked, remaining } = await getRemainingSeats(t.schedule_id, today);
        availableSeatsTotal += remaining;
        if (remaining <= 0) fullyBookedCount++;
        tripRows.push({ ...t, booked, remaining });
    }

    // Requests currently unassigned (no viable department-hierarchy
    // approver at any tier) - these are exactly the ones an executive
    // needs to override, same rule notifyExecutives() in approval.js
    // fires on.
    const unassignedRows = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, travel_date, purpose, users!bookings_user_id_fkey(full_name, departments(department_name)), booking_status!inner(status_name)')
            .is('current_approver_id', null)
            .like('booking_status.status_name', 'Pending%', { foreignTable: 'booking_status' })
            .order('travel_date', { ascending: true })
            .limit(6)
    );

    const recentActivity = unwrap(
        await db()
            .from('activity_logs')
            .select('action, details, created_at, users(full_name)')
            .order('created_at', { ascending: false })
            .limit(8)
    );

    // Bookings submitted per day, last 7 days (inclusive of today) - feeds
    // the Chart.js trend line below.
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    const recentBookings = unwrap(
        await db()
            .from('bookings')
            .select('created_at')
            .gte('created_at', sevenDaysAgo.toISOString())
    );
    const dayLabels = [];
    const dayCounts = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        dayLabels.push(d.toLocaleDateString(undefined, { weekday: 'short' }));
        dayCounts.push(recentBookings.filter((b) => b.created_at.slice(0, 10) === key).length);
    }

    const tripsHtml = tripRows
        .map(
            (t) => html`<tr>
            <td>${formatTime(t.departure_time)}</td><td>${t.ferry_routes.direction}</td><td>${t.capacity}</td><td>${t.booked}</td>
            <td class="${t.remaining <= 0 ? 'seat-full' : 'seat-ok'}">${t.remaining <= 0 ? 'FULL' : t.remaining}</td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    const todoHtml = unassignedRows
        .map(
            (r) => html`<li class="dash-todo-item">
            <span class="dash-todo-dot"></span>
            <div class="dash-todo-body">
                <div class="dash-todo-title">${r.users.full_name}</div>
                <div class="dash-todo-meta">${r.users.departments?.department_name ?? '-'} &middot; ${r.purpose}</div>
            </div>
        </li>`
        )
        .map((r) => r.toString())
        .join('');

    const activityHtml = recentActivity
        .map(
            (log) => html`<li class="dash-activity-item">
            <span class="avatar-circle">${(log.users?.full_name ?? 'S').charAt(0).toUpperCase()}</span>
            <div class="dash-activity-body">
                <div class="dash-activity-title">${log.action}</div>
                <div class="dash-activity-detail">${log.users?.full_name ?? 'System'}${log.details ? ' — ' + log.details : ''}</div>
            </div>
            <span class="dash-activity-time">${timeAgo(log.created_at)}</span>
        </li>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<div class="dash-greeting">${greeting()}, ${fullName.split(' ')[0]}!</div>
<p class="dash-greeting-sub mb-4">Here's what's happening across the portal today.</p>
<div class="row g-3 mb-4">
    ${statCard({ value: totalStaff, label: 'Total Staff', icon: 'bi-people' })}
    ${statCard({ value: todaysBookings, label: "Today's Bookings", icon: 'bi-journal-plus' })}
    ${statCard({ value: pendingApprovals, label: 'Pending Approvals', icon: 'bi-hourglass-split' })}
    ${statCard({ value: statusCounts.Approved, label: 'Approved', icon: 'bi-check-circle' })}
    ${statCard({ value: statusCounts.Rejected, label: 'Rejected', icon: 'bi-x-circle' })}
    ${statCard({ value: statusCounts.Cancelled, label: 'Cancelled', icon: 'bi-slash-circle' })}
    ${statCard({ value: todaysTrips.length, label: "Today's Ferry Trips", icon: 'bi-water' })}
    ${statCard({ value: availableSeatsTotal, label: 'Available Seats Today', icon: 'bi-person-check' })}
</div>
<div class="row g-3 mb-3">
    <div class="col-lg-7">
        <div class="card shadow-sm dash-chart-card h-100">
            <div class="card-header bg-white"><i class="bi bi-graph-up"></i> Bookings &mdash; Last 7 Days</div>
            <div class="card-body"><canvas id="bookingsTrendChart"></canvas></div>
        </div>
    </div>
    <div class="col-lg-5">
        <div class="card shadow-sm h-100">
            <div class="card-header bg-white d-flex justify-content-between">
                <span><i class="bi bi-exclamation-diamond"></i> Awaiting Executive Override</span>
                ${unassignedRows.length ? html`<a href="/hr/overview" class="small">View all</a>` : ''}
            </div>
            <div class="card-body pt-2">
                <ul class="dash-todo-list">${raw(todoHtml || '<li class="text-muted small py-2">Nothing needs an override right now.</li>')}</ul>
            </div>
        </div>
    </div>
</div>
<div class="row g-3">
    <div class="col-lg-7">
        <div class="card shadow-sm">
            <div class="card-header bg-white d-flex justify-content-between">
                <span><i class="bi bi-water"></i> Today's Ferry Trips</span>
                ${fullyBookedCount > 0 ? html`<span class="badge bg-danger">${fullyBookedCount} Fully Booked</span>` : ''}
            </div>
            <div class="table-responsive">
                <table class="table table-hover mb-0">
                    <thead><tr><th>Time</th><th>Direction</th><th>Capacity</th><th>Booked</th><th>Remaining</th></tr></thead>
                    <tbody>${raw(tripsHtml || '<tr><td colspan="5" class="text-center text-muted py-3">No schedules configured for today.</td></tr>')}</tbody>
                </table>
            </div>
        </div>
    </div>
    <div class="col-lg-5">
        <div class="card shadow-sm">
            <div class="card-header bg-white"><i class="bi bi-clock-history"></i> Recent Activity</div>
            <div class="card-body pt-2">
                <ul class="dash-todo-list">${raw(activityHtml || '<li class="text-muted small py-2">No recent activity.</li>')}</ul>
            </div>
        </div>
    </div>
</div>
<script>
(function () {
    var ctx = document.getElementById('bookingsTrendChart');
    if (!ctx || !window.Chart) return;
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: ${raw(JSON.stringify(dayLabels))},
            datasets: [{
                label: 'Bookings submitted',
                data: ${raw(JSON.stringify(dayCounts))},
                borderColor: getComputedStyle(document.documentElement).getPropertyValue('--theme-primary-color').trim() || '#0d6efd',
                backgroundColor: 'transparent',
                tension: 0.35,
                pointRadius: 3,
            }],
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
    });
})();
</script>`;
}

// ---------------------------------------------------------------------
// Users CRUD
// ---------------------------------------------------------------------
function userFormFields({ u, departments, roles, managers, resorts, values, isApprover }) {
    // `values` (optional): the raw submitted form values from a rejected
    // save, redisplayed in place of `u`'s stored DB values so the admin
    // doesn't lose what they typed when validation/duplicate-key fails.
    const v = (key, fallback = '') => (values && values[key] !== undefined ? values[key] : (u?.[key] ?? fallback));
    return html`
<div class="row g-3">
    <div class="col-md-6"><label class="form-label">Employee ID *</label><input type="text" name="employee_id" class="form-control" required value="${v('employee_id')}"></div>
    <div class="col-md-6"><label class="form-label">Full Name *</label><input type="text" name="full_name" class="form-control" required value="${v('full_name')}"></div>
    <div class="col-md-6"><label class="form-label">Username *</label><input type="text" name="username" class="form-control" required value="${v('username')}"></div>
    <div class="col-md-6"><label class="form-label">Password ${u ? '(leave blank to keep unchanged)' : '*'}</label><input type="password" name="password" class="form-control" ${u ? '' : 'required'}></div>
    <div class="col-md-6"><label class="form-label">Resort *</label>
        <select name="resort_id" class="form-select" required><option value="">-- Select Resort --</option>
        ${raw(resorts.map((r) => `<option value="${r.resort_id}" ${v('resort_id') == r.resort_id ? 'selected' : ''}>${h(r.resort_name)}</option>`).join(''))}
        </select>
    </div>
    <div class="col-md-6"><label class="form-label">Department *</label>
        <select name="department_id" class="form-select" required><option value="">-- Select Department --</option>
        ${raw(departments.map((d) => `<option value="${d.department_id}" ${v('department_id') == d.department_id ? 'selected' : ''}>${h(d.department_name)}</option>`).join(''))}
        </select>
    </div>
    <div class="col-md-6"><label class="form-label">Designation</label><input type="text" name="designation" class="form-control" value="${v('designation')}"></div>
    <div class="col-md-6"><label class="form-label">Role *</label>
        <select name="role_id" class="form-select" required><option value="">-- Select Role --</option>
        ${raw(roles.map((r) => `<option value="${r.role_id}" ${v('role_id') == r.role_id ? 'selected' : ''}>${h(r.role_name)}</option>`).join(''))}
        </select>
    </div>
    <div class="col-md-6"><label class="form-label">Reporting Manager</label>
        <select name="reporting_manager_id" class="form-select"><option value="">-- None --</option>
        ${raw(managers.filter((m) => !u || m.user_id !== u.user_id).map((m) => `<option value="${m.user_id}" ${v('reporting_manager_id') == m.user_id ? 'selected' : ''}>${h(m.full_name)} (${h(m.employee_id)})</option>`).join(''))}
        </select>
    </div>
    <div class="col-md-6"><label class="form-label">Email (optional)</label><input type="email" name="email" class="form-control" value="${v('email')}"></div>
    <div class="col-md-6"><label class="form-label">Phone (optional)</label><input type="text" name="phone" class="form-control" value="${v('phone')}"></div>
    <div class="col-md-6"><label class="form-label">Status</label>
        <select name="status" class="form-select">
            <option value="active" ${v('status', 'active') === 'active' ? 'selected' : ''}>Active</option>
            <option value="inactive" ${v('status') === 'inactive' ? 'selected' : ''}>Inactive</option>
        </select>
    </div>
    ${u ? html`<div class="col-md-6">
        <label class="form-label d-block">Approval Role</label>
        <span class="badge ${isApprover ? 'bg-success' : 'bg-secondary'}">${isApprover ? 'Department Approver' : 'Not an approver'}</span>
        <div class="form-text">Assigned via <a href="/admin/department_approval" target="_blank">Department Approval Configuration</a>, not here.</div>
    </div>` : ''}
    <div class="col-md-6">
        <label class="form-label">Profile Photo</label>
        ${u?.profile_picture ? html`<img src="${u.profile_picture}" class="rounded-circle d-block mb-2" width="56" height="56" style="object-fit:cover;">` : ''}
        <input type="file" name="profile_picture" class="form-control" accept=".jpg,.jpeg,.png,.webp">
    </div>
</div>`;
}

// Explicit allowlist mapping a trusted `sort` query value to its safe
// .order() call - never interpolate the raw querystring value directly
// (same discipline as the `search` filter below, which is filtered in JS
// rather than built into a PostgREST .or() string).
const SORT_COLUMNS = {
    name: { column: 'full_name' },
    employee_id: { column: 'employee_id' },
    department: { column: 'department_name', foreignTable: 'departments' },
    resort: { column: 'resort_name', foreignTable: 'resorts' },
    role: { column: 'role_name', foreignTable: 'roles' },
    status: { column: 'status' },
};

async function fetchFilteredUsers({ search, deptFilter, roleFilter, resortFilter, statusFilter, sortKey, sortDir }) {
    let query = db()
        .from('users')
        .select(
            'user_id, employee_id, full_name, username, designation, status, department_id, role_id, resort_id, reporting_manager_id, profile_picture, roles(role_name), departments(department_name), resorts(resort_name), reporting_manager:reporting_manager_id(full_name)'
        );
    if (deptFilter) query = query.eq('department_id', deptFilter);
    if (roleFilter) query = query.eq('role_id', roleFilter);
    if (resortFilter) query = query.eq('resort_id', resortFilter);
    if (['active', 'inactive'].includes(statusFilter)) query = query.eq('status', statusFilter);

    const sort = SORT_COLUMNS[sortKey] ?? null;
    const ascending = sortDir !== 'desc';
    query = sort
        ? query.order(sort.column, { foreignTable: sort.foreignTable, ascending })
        : query.order('created_at', { ascending: false });

    let users = unwrap(await query);

    // Filtered in JS rather than a PostgREST .or() filter string, which
    // untrusted search input must not be interpolated into directly.
    if (search) {
        const needle = search.toLowerCase();
        users = users.filter(
            (u) =>
                u.full_name.toLowerCase().includes(needle) ||
                u.username.toLowerCase().includes(needle) ||
                u.employee_id.toLowerCase().includes(needle)
        );
    }
    return users;
}

async function usersPageBody({ search, deptFilter, roleFilter, resortFilter, statusFilter, sortKey, sortDir, csrfToken, errors, reopen }) {
    const users = await fetchFilteredUsers({ search, deptFilter, roleFilter, resortFilter, statusFilter, sortKey, sortDir });

    const departments = unwrap(await db().from('departments').select('*').order('department_name'));
    const roles = unwrap(await db().from('roles').select('*').order('role_id'));
    const resorts = unwrap(await db().from('resorts').select('*').order('resort_name'));
    const managers = unwrap(await db().from('users').select('user_id, full_name, employee_id').eq('status', 'active').order('full_name'));

    // "Approval Role" isn't a column on users - it's derived from whether
    // this user is assigned as manager/assistant/supervisor in any
    // department currently in 'department_hierarchy' mode (same rule as
    // session.js's checkIsDepartmentApprover, computed in bulk here to
    // avoid one query per row).
    const approverConfigs = unwrap(
        await db()
            .from('department_approval_config')
            .select('manager_user_id, assistant_manager_user_id, supervisor_user_id')
            .eq('approval_mode', 'department_hierarchy')
    );
    const approverIds = new Set();
    for (const c of approverConfigs) {
        for (const id of [c.manager_user_id, c.assistant_manager_user_id, c.supervisor_user_id]) {
            if (id) approverIds.add(id);
        }
    }

    const rowsHtml = users
        .map(
            (u) => html`<tr>
            <td>${u.employee_id}</td><td>${u.full_name}</td><td>${u.username}</td>
            <td>${u.resorts?.resort_name ?? '-'}</td>
            <td>${u.departments?.department_name ?? '-'}</td><td>${u.designation ?? '-'}</td>
            <td><span class="badge bg-primary-subtle text-primary-emphasis">${u.roles.role_name}</span></td>
            <td>${u.reporting_manager?.full_name ?? '-'}</td>
            <td><span class="badge ${u.status === 'active' ? 'bg-success' : 'bg-secondary'}">${u.status === 'active' ? 'Active' : 'Archived'}</span></td>
            <td class="text-nowrap">
                <button class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#editUserModal${u.user_id}"><i class="bi bi-pencil"></i></button>
                <form method="post" class="d-inline" data-confirm="Generate a new temporary password for this user?">
                    ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="reset_password"><input type="hidden" name="user_id" value="${u.user_id}">
                    <button class="btn btn-sm btn-outline-warning"><i class="bi bi-key"></i></button>
                </form>
                <form method="post" class="d-inline" data-confirm="${u.status === 'active' ? 'Archive (deactivate) this user?' : 'Restore (reactivate) this user?'}">
                    ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="toggle_status"><input type="hidden" name="user_id" value="${u.user_id}">
                    <button class="btn btn-sm btn-outline-secondary"><i class="bi bi-toggle2-on"></i></button>
                </form>
                <form method="post" class="d-inline" data-confirm="Permanently delete this user? This cannot be undone.">
                    ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="delete"><input type="hidden" name="user_id" value="${u.user_id}">
                    <button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button>
                </form>
            </td>
        </tr>
        <div class="modal fade" id="editUserModal${u.user_id}" tabindex="-1"><div class="modal-dialog modal-dialog-scrollable"><form method="post" enctype="multipart/form-data" class="modal-content">
            ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="edit"><input type="hidden" name="user_id" value="${u.user_id}">
            <div class="modal-header"><h5 class="modal-title">Edit User</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
            <div class="modal-body">
                ${reopen && reopen.type === 'edit' && reopen.userId === u.user_id && reopen.errors?.length ? html`<div class="alert alert-danger py-2">${raw(reopen.errors.map((e) => `${e}<br>`).join(''))}</div>` : ''}
                ${userFormFields({ u, departments, roles, managers, resorts, values: reopen && reopen.type === 'edit' && reopen.userId === u.user_id ? reopen.values : undefined, isApprover: approverIds.has(u.user_id) })}
            </div>
            <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div>
        </form></div></div>`
        )
        .map((r) => r.toString())
        .join('');

    const reopenScript =
        reopen && reopen.type
            ? raw(`<script>document.addEventListener('DOMContentLoaded', function () {
    var el = document.getElementById(${reopen.type === 'edit' ? `'editUserModal${reopen.userId}'` : `'addUserModal'`});
    if (el && window.bootstrap) bootstrap.Modal.getOrCreateInstance(el).show();
});</script>`)
            : '';

    const queryString = new URLSearchParams({
        search,
        department: String(deptFilter || 0),
        role: String(roleFilter || 0),
        resort: String(resortFilter || 0),
        status: statusFilter,
        sort: sortKey || '',
        dir: sortDir || '',
    }).toString();

    return html`
<div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="mb-0"><i class="bi bi-people"></i> User Management</h5>
    <div class="d-flex gap-2">
        <a class="btn btn-outline-success" href="/admin/users?${queryString}&format=csv"><i class="bi bi-file-earmark-excel"></i> Export CSV</a>
        <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addUserModal"><i class="bi bi-plus-lg"></i> Add User</button>
    </div>
</div>
${errors.length ? html`<div class="alert alert-danger">${raw(errors.map((e) => `${e}<br>`).join(''))}</div>` : ''}
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-3"><input type="text" name="search" class="form-control" placeholder="Search name, username, employee ID" value="${search}"></div>
        <div class="col-md-2"><select name="department" class="form-select"><option value="0">All Departments</option>${raw(departments.map((d) => `<option value="${d.department_id}" ${deptFilter == d.department_id ? 'selected' : ''}>${h(d.department_name)}</option>`).join(''))}</select></div>
        <div class="col-md-2"><select name="resort" class="form-select"><option value="0">All Resorts</option>${raw(resorts.map((r) => `<option value="${r.resort_id}" ${resortFilter == r.resort_id ? 'selected' : ''}>${h(r.resort_name)}</option>`).join(''))}</select></div>
        <div class="col-md-2"><select name="role" class="form-select"><option value="0">All Roles</option>${raw(roles.map((r) => `<option value="${r.role_id}" ${roleFilter == r.role_id ? 'selected' : ''}>${h(r.role_name)}</option>`).join(''))}</select></div>
        <div class="col-md-1"><select name="status" class="form-select"><option value="">All</option><option value="active" ${statusFilter === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${statusFilter === 'inactive' ? 'selected' : ''}>Archived</option></select></div>
        <div class="col-md-2">
            <div class="input-group">
                <select name="sort" class="form-select">
                    <option value="">Default order</option>
                    <option value="name" ${sortKey === 'name' ? 'selected' : ''}>Name</option>
                    <option value="employee_id" ${sortKey === 'employee_id' ? 'selected' : ''}>Employee ID</option>
                    <option value="department" ${sortKey === 'department' ? 'selected' : ''}>Department</option>
                    <option value="resort" ${sortKey === 'resort' ? 'selected' : ''}>Resort</option>
                    <option value="role" ${sortKey === 'role' ? 'selected' : ''}>Role</option>
                    <option value="status" ${sortKey === 'status' ? 'selected' : ''}>Status</option>
                </select>
                <select name="dir" class="form-select" style="max-width:5.5rem;">
                    <option value="asc" ${sortDir !== 'desc' ? 'selected' : ''}>Asc</option>
                    <option value="desc" ${sortDir === 'desc' ? 'selected' : ''}>Desc</option>
                </select>
            </div>
        </div>
        <div class="col-12"><button class="btn btn-outline-primary btn-sm" type="submit"><i class="bi bi-search"></i> Filter</button> <a href="/admin/users" class="btn btn-outline-secondary btn-sm">Reset</a></div>
    </form>
</div></div>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Employee ID</th><th>Name</th><th>Username</th><th>Resort</th><th>Department</th><th>Designation</th><th>Role</th><th>Manager</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="10" class="text-center text-muted py-4">No users found.</td></tr>')}</tbody>
</table></div></div>
<div class="modal fade" id="addUserModal" tabindex="-1"><div class="modal-dialog modal-dialog-scrollable"><form method="post" enctype="multipart/form-data" class="modal-content">
    ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="add">
    <div class="modal-header"><h5 class="modal-title">Add User</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        ${reopen && reopen.type === 'add' && reopen.errors?.length ? html`<div class="alert alert-danger py-2">${raw(reopen.errors.map((e) => `${e}<br>`).join(''))}</div>` : ''}
        ${userFormFields({ u: null, departments, roles, managers, resorts, values: reopen && reopen.type === 'add' ? reopen.values : undefined })}
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Create User</button></div>
</form></div></div>
${reopenScript}`;
}

function usersToCsv(users) {
    const header = 'Employee ID,Full Name,Username,Resort,Department,Designation,Role,Reporting Manager,Status\n';
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = users
        .map((u) =>
            [
                u.employee_id,
                u.full_name,
                u.username,
                u.resorts?.resort_name ?? '',
                u.departments?.department_name ?? '',
                u.designation ?? '',
                u.roles.role_name,
                u.reporting_manager?.full_name ?? '',
                u.status === 'active' ? 'Active' : 'Archived',
            ]
                .map(escape)
                .join(',')
        )
        .join('\n');
    return header + body;
}

// ---------------------------------------------------------------------
// Schedules CRUD
// ---------------------------------------------------------------------
function scheduleFormFields({ sched, routes }) {
    const selectedDays = sched?.weekdays ?? WEEKDAY_OPTIONS;
    const idSuffix = sched?.schedule_id ?? 'new';
    return html`
<div class="row g-3">
    <div class="col-md-6"><label class="form-label">Route *</label>
        <select name="route_id" class="form-select" required>${raw(routes.map((r) => `<option value="${r.route_id}" ${sched?.route_id == r.route_id ? 'selected' : ''}>${h(r.direction)}</option>`).join(''))}</select>
    </div>
    <div class="col-md-6"><label class="form-label">Departure Time *</label><input type="time" name="departure_time" class="form-control" required value="${sched?.departure_time ?? ''}"></div>
    <div class="col-md-6"><label class="form-label">Seat Capacity *</label><input type="number" min="1" name="capacity" class="form-control" required value="${sched?.capacity ?? 20}"></div>
    <div class="col-md-6"><label class="form-label">Status</label>
        <select name="status" class="form-select"><option value="active" ${(sched?.status ?? 'active') === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${sched?.status === 'inactive' ? 'selected' : ''}>Inactive</option></select>
    </div>
    <div class="col-12"><label class="form-label">Operates On</label><div class="d-flex flex-wrap gap-3">
        ${raw(WEEKDAY_OPTIONS.map((day) => `<div class="form-check"><input class="form-check-input" type="checkbox" name="weekdays" value="${day}" id="day${day}${idSuffix}" ${selectedDays.includes(day) ? 'checked' : ''}><label class="form-check-label" for="day${day}${idSuffix}">${day}</label></div>`).join(''))}
    </div></div>
    <div class="col-12 form-check"><input class="form-check-input" type="checkbox" name="is_holiday_schedule" id="holiday${idSuffix}" ${sched?.is_holiday_schedule ? 'checked' : ''}><label class="form-check-label" for="holiday${idSuffix}">This is a holiday-only schedule</label></div>
    <div class="col-12"><label class="form-label">Notes</label><textarea name="notes" class="form-control" rows="2">${sched?.notes ?? ''}</textarea></div>
</div>`;
}

async function schedulesPageBody(csrfToken) {
    const schedules = unwrap(
        await db().from('ferry_schedule').select('*, ferry_routes(direction)').order('departure_time')
    );
    const routes = unwrap(await db().from('ferry_routes').select('*').eq('status', 'active').order('route_name'));

    const rowsHtml = schedules
        .map(
            (s) => html`<tr>
            <td>${s.ferry_routes.direction}</td><td>${formatTime(s.departure_time)}</td><td>${s.capacity}</td>
            <td><small>${s.weekdays.join(',')}</small></td>
            <td>${s.is_holiday_schedule ? html`<span class="badge bg-info text-dark">Holiday</span>` : '-'}</td>
            <td><span class="badge ${s.status === 'active' ? 'bg-success' : 'bg-secondary'}">${s.status.charAt(0).toUpperCase() + s.status.slice(1)}</span></td>
            <td><small class="text-muted">${s.notes ?? ''}</small></td>
            <td class="text-nowrap">
                <button class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#editScheduleModal${s.schedule_id}"><i class="bi bi-pencil"></i></button>
                <form method="post" class="d-inline">${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="duplicate"><input type="hidden" name="schedule_id" value="${s.schedule_id}"><button class="btn btn-sm btn-outline-info"><i class="bi bi-files"></i></button></form>
                <form method="post" class="d-inline">${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="toggle_status"><input type="hidden" name="schedule_id" value="${s.schedule_id}"><button class="btn btn-sm btn-outline-secondary"><i class="bi bi-toggle2-on"></i></button></form>
                <form method="post" class="d-inline" data-confirm="Delete this schedule?">${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="delete"><input type="hidden" name="schedule_id" value="${s.schedule_id}"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>
            </td>
        </tr>
        <div class="modal fade" id="editScheduleModal${s.schedule_id}" tabindex="-1"><div class="modal-dialog modal-dialog-scrollable"><form method="post" class="modal-content">
            ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="edit"><input type="hidden" name="schedule_id" value="${s.schedule_id}">
            <div class="modal-header"><h5 class="modal-title">Edit Schedule</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
            <div class="modal-body">${scheduleFormFields({ sched: s, routes })}</div>
            <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div>
        </form></div></div>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="mb-0"><i class="bi bi-calendar3"></i> Ferry Schedule Management</h5>
    <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addScheduleModal"><i class="bi bi-plus-lg"></i> Create Schedule</button>
</div>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Route</th><th>Departure</th><th>Capacity</th><th>Weekdays</th><th>Holiday</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="8" class="text-center text-muted py-4">No schedules configured yet.</td></tr>')}</tbody>
</table></div></div>
<div class="modal fade" id="addScheduleModal" tabindex="-1"><div class="modal-dialog modal-dialog-scrollable"><form method="post" class="modal-content">
    ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="add">
    <div class="modal-header"><h5 class="modal-title">Create Schedule</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">${scheduleFormFields({ sched: null, routes })}</div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Create</button></div>
</form></div></div>`;
}

// ---------------------------------------------------------------------
// Manager availability
// ---------------------------------------------------------------------
async function managerAvailabilityBody(csrfToken) {
    const managerRoles = unwrap(await db().from('roles').select('role_id, role_name').in('role_name', ['General Manager', 'Resident Manager', 'HR Manager']));
    const roleIds = managerRoles.map((r) => r.role_id);
    const managers = unwrap(
        await db().from('users').select('user_id, full_name, employee_id, role_id, roles(role_name)').in('role_id', roleIds).eq('status', 'active')
    );
    const availabilityRows = unwrap(await db().from('manager_availability').select('user_id, status, remarks').in('user_id', managers.map((m) => m.user_id)));
    const availabilityByUser = new Map(availabilityRows.map((a) => [a.user_id, a]));
    const rolePriority = ['General Manager', 'Resident Manager', 'HR Manager'];
    managers.sort((a, b) => rolePriority.indexOf(a.roles.role_name) - rolePriority.indexOf(b.roles.role_name));

    const cards = managers
        .map((m) => {
            const avail = availabilityByUser.get(m.user_id) ?? { status: 'available', remarks: '' };
            return html`<div class="col-md-6 col-lg-4"><div class="card shadow-sm h-100"><div class="card-body">
                <h6 class="card-title">${m.full_name}</h6>
                <p class="text-muted small mb-2">${m.roles.role_name} &middot; ${m.employee_id}</p>
                <form method="post">
                    ${raw(csrfField(csrfToken))}<input type="hidden" name="user_id" value="${m.user_id}">
                    <select name="status" class="form-select form-select-sm mb-2">
                        <option value="available" ${avail.status === 'available' ? 'selected' : ''}>Available</option>
                        <option value="on_leave" ${avail.status === 'on_leave' ? 'selected' : ''}>On Leave</option>
                        <option value="out_of_office" ${avail.status === 'out_of_office' ? 'selected' : ''}>Out of Office</option>
                    </select>
                    <input type="text" name="remarks" class="form-control form-control-sm mb-2" placeholder="Remarks (optional)" value="${avail.remarks ?? ''}">
                    <button type="submit" class="btn btn-sm btn-primary w-100">Update</button>
                </form>
            </div></div></div>`;
        })
        .map((c) => c.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-person-check"></i> Manager Availability</h5>
<p class="text-muted">Bookings are automatically routed to the first available manager in this order: General Manager &rarr; Resident Manager &rarr; HR Manager.</p>
<div class="row g-3">${raw(cards || '<p class="text-muted">No GM / RM / HR Manager accounts found.</p>')}</div>`;
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
export function registerAdminRoutes(router) {
    router.get('/admin/dashboard', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const body = await adminDashboardBody(auth.user.full_name);
        return renderShellForRequest({ request, auth, pageTitle: 'Administrator Dashboard', path: '/admin/dashboard', bodyHtml: body });
    });

    router.get('/admin/users', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const filters = {
            search: url.searchParams.get('search') || '',
            deptFilter: Number(url.searchParams.get('department') || 0),
            roleFilter: Number(url.searchParams.get('role') || 0),
            resortFilter: Number(url.searchParams.get('resort') || 0),
            statusFilter: url.searchParams.get('status') || '',
            sortKey: url.searchParams.get('sort') || '',
            sortDir: url.searchParams.get('dir') || '',
        };

        if (url.searchParams.get('format') === 'csv') {
            const users = await fetchFilteredUsers(filters);
            const filename = `ferry_portal_users_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
            return csvResponse(usersToCsv(users), filename);
        }

        const body = await usersPageBody({ ...filters, csrfToken: auth.user.csrf, errors: [] });
        return renderShellForRequest({ request, auth, pageTitle: 'User Management', path: '/admin/users', bodyHtml: body });
    });

    router.post('/admin/users', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const action = form.action;

        if (action === 'add' || action === 'edit') {
            const employeeId = (form.employee_id || '').trim();
            const fullName = (form.full_name || '').trim();
            const username = (form.username || '').trim();
            const password = form.password || '';
            const resortId = Number(form.resort_id) || null;
            const departmentId = Number(form.department_id) || null;
            const designation = (form.designation || '').trim() || null;
            const roleId = Number(form.role_id) || 0;
            const managerId = Number(form.reporting_manager_id) || null;
            const email = (form.email || '').trim() || null;
            const phone = (form.phone || '').trim() || null;
            const status = form.status === 'inactive' ? 'inactive' : 'active';
            const userId = Number(form.user_id) || 0;
            const photoFile = form.profile_picture;
            const hasPhoto = photoFile && typeof photoFile.arrayBuffer === 'function' && photoFile.size > 0;

            const errors = [];
            if (!employeeId || !fullName || !username || !roleId) errors.push('Employee ID, Full Name, Username, and Role are required.');
            if (!resortId) errors.push('Resort is required.');
            if (!departmentId) errors.push('Department is required.');
            if (action === 'add' && !password) errors.push('Password is required for a new user.');

            if (!errors.length) {
                try {
                    if (action === 'add') {
                        const hash = await hashPassword(password);
                        const inserted = unwrap(
                            await db()
                                .from('users')
                                .insert({
                                    employee_id: employeeId, full_name: fullName, username, password: hash,
                                    resort_id: resortId, department_id: departmentId, designation, role_id: roleId, reporting_manager_id: managerId,
                                    email, phone, status,
                                })
                                .select('user_id')
                        );
                        const newUserId = inserted[0]?.user_id;
                        if (hasPhoto && newUserId) {
                            const url = await uploadProfilePicture(photoFile, newUserId);
                            unwrap(await db().from('users').update({ profile_picture: url }).eq('user_id', newUserId));
                        }
                        await logActivity(user.user_id, 'Created user', username, clientIp(request));
                        return redirectTo('/admin/users', { cookies: [auth.setCookie, flashSetCookie('success', `User '${fullName}' created successfully.`)].filter(Boolean) });
                    }
                    const update = { employee_id: employeeId, full_name: fullName, username, resort_id: resortId, department_id: departmentId, designation, role_id: roleId, reporting_manager_id: managerId, email, phone, status };
                    if (password) update.password = await hashPassword(password);
                    if (hasPhoto) update.profile_picture = await uploadProfilePicture(photoFile, userId);
                    unwrap(await db().from('users').update(update).eq('user_id', userId));
                    await logActivity(user.user_id, 'Updated user', username, clientIp(request));
                    return redirectTo('/admin/users', { cookies: [auth.setCookie, flashSetCookie('success', `User '${fullName}' updated successfully.`)].filter(Boolean) });
                } catch (err) {
                    errors.push(err.message?.includes('duplicate') ? 'Employee ID or Username already exists.' : `Database error while saving user: ${err.message}`);
                }
            }
            const body = await usersPageBody({
                search: '', deptFilter: 0, roleFilter: 0, resortFilter: 0, statusFilter: '', sortKey: '', sortDir: '',
                csrfToken: user.csrf, errors: [],
                reopen: { type: action, userId, values: form, errors },
            });
            return renderShellForRequest({ request, auth, pageTitle: 'User Management', path: '/admin/users', bodyHtml: body });
        }

        if (action === 'delete') {
            const userId = Number(form.user_id);
            if (userId === user.user_id) {
                return redirectTo('/admin/users', { cookies: [auth.setCookie, flashSetCookie('error', 'You cannot delete your own account.')].filter(Boolean) });
            }
            unwrap(await db().from('users').delete().eq('user_id', userId));
            await logActivity(user.user_id, 'Deleted user', `user_id=${userId}`, clientIp(request));
            return redirectTo('/admin/users', { cookies: [auth.setCookie, flashSetCookie('success', 'User deleted.')].filter(Boolean) });
        }

        if (action === 'toggle_status') {
            const userId = Number(form.user_id);
            if (userId === user.user_id) {
                return redirectTo('/admin/users', { cookies: [auth.setCookie, flashSetCookie('error', 'You cannot disable your own account.')].filter(Boolean) });
            }
            const rows = unwrap(await db().from('users').select('status').eq('user_id', userId).limit(1));
            if (rows.length) {
                const newStatus = rows[0].status === 'active' ? 'inactive' : 'active';
                unwrap(await db().from('users').update({ status: newStatus }).eq('user_id', userId));
                await logActivity(user.user_id, 'Toggled user status', `user_id=${userId}`, clientIp(request));
            }
            return redirectTo('/admin/users', { cookies: [auth.setCookie, flashSetCookie('success', 'User status updated.')].filter(Boolean) });
        }

        if (action === 'reset_password') {
            const userId = Number(form.user_id);
            const temp = generateTempPassword();
            const hash = await hashPassword(temp);
            unwrap(await db().from('users').update({ password: hash, must_change_password: true }).eq('user_id', userId));
            await logActivity(user.user_id, 'Reset user password', `user_id=${userId}`, clientIp(request));
            return redirectTo('/admin/users', { cookies: [auth.setCookie, flashSetCookie('success', `Temporary password generated: ${temp} (user must change it at next login).`)].filter(Boolean) });
        }

        return redirectTo('/admin/users', { cookies: [auth.setCookie] });
    });

    router.get('/admin/schedules', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const body = await schedulesPageBody(auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'Ferry Schedules', path: '/admin/schedules', bodyHtml: body });
    });

    router.post('/admin/schedules', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const action = form.action;

        if (action === 'add' || action === 'edit') {
            const routeId = Number(form.route_id);
            const departureTime = form.departure_time;
            const capacity = Math.max(1, Number(form.capacity));
            const weekdaysRaw = form.weekdays;
            const weekdays = (Array.isArray(weekdaysRaw) ? weekdaysRaw : weekdaysRaw ? [weekdaysRaw] : []).filter((d) => WEEKDAY_OPTIONS.includes(d));
            const isHoliday = !!form.is_holiday_schedule;
            const status = form.status === 'inactive' ? 'inactive' : 'active';
            const notes = (form.notes || '').trim() || null;

            if (action === 'add') {
                unwrap(await db().from('ferry_schedule').insert({ route_id: routeId, departure_time: departureTime, capacity, weekdays, is_holiday_schedule: isHoliday, status, notes }));
            } else {
                unwrap(
                    await db()
                        .from('ferry_schedule')
                        .update({ route_id: routeId, departure_time: departureTime, capacity, weekdays, is_holiday_schedule: isHoliday, status, notes })
                        .eq('schedule_id', Number(form.schedule_id))
                );
            }
            await logActivity(user.user_id, 'Saved ferry schedule', departureTime, clientIp(request));
            return redirectTo('/admin/schedules', { cookies: [auth.setCookie, flashSetCookie('success', action === 'add' ? 'Schedule created.' : 'Schedule updated.')].filter(Boolean) });
        }

        if (action === 'delete') {
            unwrap(await db().from('ferry_schedule').delete().eq('schedule_id', Number(form.schedule_id)));
            return redirectTo('/admin/schedules', { cookies: [auth.setCookie, flashSetCookie('success', 'Schedule deleted.')].filter(Boolean) });
        }

        if (action === 'toggle_status') {
            const rows = unwrap(await db().from('ferry_schedule').select('status').eq('schedule_id', Number(form.schedule_id)).limit(1));
            if (rows.length) {
                unwrap(await db().from('ferry_schedule').update({ status: rows[0].status === 'active' ? 'inactive' : 'active' }).eq('schedule_id', Number(form.schedule_id)));
            }
            return redirectTo('/admin/schedules', { cookies: [auth.setCookie, flashSetCookie('success', 'Schedule status updated.')].filter(Boolean) });
        }

        if (action === 'duplicate') {
            const rows = unwrap(await db().from('ferry_schedule').select('*').eq('schedule_id', Number(form.schedule_id)).limit(1));
            if (rows.length) {
                const s = rows[0];
                unwrap(
                    await db().from('ferry_schedule').insert({
                        route_id: s.route_id, departure_time: s.departure_time, capacity: s.capacity, weekdays: s.weekdays,
                        is_holiday_schedule: s.is_holiday_schedule, status: 'inactive', notes: `${s.notes ?? ''} (copy)`,
                    })
                );
            }
            return redirectTo('/admin/schedules', { cookies: [auth.setCookie, flashSetCookie('success', 'Schedule duplicated (created as inactive - review and activate).')].filter(Boolean) });
        }

        return redirectTo('/admin/schedules', { cookies: [auth.setCookie] });
    });

    router.get('/admin/manager_availability', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const body = await managerAvailabilityBody(auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'Manager Availability', path: '/admin/manager_availability', bodyHtml: body });
    });

    router.post('/admin/manager_availability', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const targetUserId = Number(form.user_id);
        const status = form.status;
        const remarks = (form.remarks || '').trim() || null;
        if (['available', 'on_leave', 'out_of_office'].includes(status)) {
            unwrap(await db().from('manager_availability').upsert({ user_id: targetUserId, status, remarks }, { onConflict: 'user_id' }));
            await logActivity(user.user_id, 'Updated manager availability', `user_id=${targetUserId}, status=${status}`, clientIp(request));
        }
        return redirectTo('/admin/manager_availability', { cookies: [auth.setCookie, flashSetCookie('success', 'Availability updated.')].filter(Boolean) });
    });
}
