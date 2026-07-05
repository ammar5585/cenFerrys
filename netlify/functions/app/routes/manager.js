// Port of manager/approvals.php (Phase 2 scope; history.js, availability.js,
// department_requests.js, reports.js land in Phase 3).

import { db, unwrap } from '../db.js';
import { requireRole, requireLogin } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { createNotification } from '../notifications.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDate, formatTime, greeting } from '../format.js';
import { ROLE_GM, ROLE_RM, ROLE_HR, ROLE_DEPT_MGR } from '../session.js';

const APPROVER_ROLES = [ROLE_GM, ROLE_RM, ROLE_HR];

/** Maps a booking's "waiting/pending" status_name to a human hierarchy-level label for the audit trail. */
const LEVEL_BY_STATUS_NAME = {
    'Waiting GM Approval': 'General Manager',
    'Waiting RM Approval': 'Resident Manager',
    'Waiting HR Approval': 'HR Manager',
    'Pending Department Manager Approval': 'Primary Approver (In Charge / Head of Department)',
    'Pending Assistant Manager Approval': 'Secondary Approver (Assistant In Charge / Assistant Manager)',
    'Pending HR Approval': 'HR',
};

// ---------------------------------------------------------------------
// Dashboard - shared by GM/RM/HR (approvers) and Department Manager
// ---------------------------------------------------------------------
async function managerDashboardBody(user) {
    const isApprover = APPROVER_ROLES.includes(user.role_name);
    let pendingCount = 0;
    let approvedCount = 0;
    let rejectedCount = 0;
    let pendingRequestsHtml = '';

    if (isApprover) {
        pendingCount =
            (
                await db()
                    .from('bookings')
                    .select('*, booking_status!inner(status_name)', { count: 'exact', head: true })
                    .eq('current_approver_id', user.user_id)
                    .like('booking_status.status_name', 'Waiting%')
            ).count || 0;
        approvedCount = (await db().from('booking_approvals').select('*', { count: 'exact', head: true }).eq('approver_id', user.user_id).eq('action', 'approved')).count || 0;
        rejectedCount = (await db().from('booking_approvals').select('*', { count: 'exact', head: true }).eq('approver_id', user.user_id).eq('action', 'rejected')).count || 0;

        const rows = unwrap(
            await db()
                .from('bookings')
                .select('booking_id, travel_date, purpose, direction, users!bookings_user_id_fkey(full_name, employee_id), ferry_schedule(departure_time), booking_status!inner(status_name, badge_color)')
                .eq('current_approver_id', user.user_id)
                .like('booking_status.status_name', 'Waiting%')
                .order('travel_date', { ascending: true })
                .limit(8)
        );
        pendingRequestsHtml = rows
            .map(
                (r) => html`<li class="dash-todo-item">
                <span class="dash-todo-dot ${r.booking_status.badge_color === 'warning' ? 'bg-warning' : 'bg-secondary'}"></span>
                <div class="dash-todo-body">
                    <div class="dash-todo-title">${r.users.full_name} <small class="text-muted">${r.users.employee_id}</small></div>
                    <div class="dash-todo-meta">${formatDate(r.travel_date)} at ${formatTime(r.ferry_schedule.departure_time)} &middot; ${r.direction} &middot; ${r.purpose}</div>
                </div>
            </li>`
            )
            .map((r) => r.toString())
            .join('');
    }

    let deptSummaryHtml = '';
    if (user.role_name === ROLE_DEPT_MGR) {
        const selfRows = unwrap(await db().from('users').select('department_id, resort_id').eq('user_id', user.user_id).limit(1));
        const departmentId = selfRows[0]?.department_id;
        const resortId = selfRows[0]?.resort_id;
        if (departmentId && resortId) {
            const deptUserIds = unwrap(
                await db().from('users').select('user_id').eq('department_id', departmentId).eq('resort_id', resortId)
            ).map((u) => u.user_id);
            const bookings = deptUserIds.length
                ? unwrap(await db().from('bookings').select('booking_status(status_name)').in('user_id', deptUserIds))
                : [];
            const counts = new Map();
            for (const b of bookings) counts.set(b.booking_status.status_name, (counts.get(b.booking_status.status_name) || 0) + 1);
            deptSummaryHtml = [...counts.entries()].map(([name, total]) => `<tr><td>${name}</td><td>${total}</td></tr>`).join('');
        }
    }

    return html`
<div class="dash-greeting">${greeting()}, ${user.full_name.split(' ')[0]}!</div>
<p class="dash-greeting-sub mb-4">${user.role_name}</p>
${isApprover
    ? html`
<div class="row g-3 mb-4">
    <div class="col-sm-4"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-hourglass-split"></i></div><div><div class="stat-value">${pendingCount}</div><div class="stat-label">Pending Requests</div></div></div></div>
    <div class="col-sm-4"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-check-circle"></i></div><div><div class="stat-value">${approvedCount}</div><div class="stat-label">Approved by Me</div></div></div></div>
    <div class="col-sm-4"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-x-circle"></i></div><div><div class="stat-value">${rejectedCount}</div><div class="stat-label">Rejected by Me</div></div></div></div>
</div>
<div class="card shadow-sm">
    <div class="card-header bg-white d-flex justify-content-between"><span><i class="bi bi-hourglass-split"></i> Requests Awaiting Your Approval</span><a href="/manager/approvals" class="small">View all</a></div>
    <div class="card-body pt-2">
        <ul class="dash-todo-list">${raw(pendingRequestsHtml || '<li class="text-muted small py-2">No pending requests.</li>')}</ul>
    </div>
</div>`
    : ''}
${user.role_name === ROLE_DEPT_MGR
    ? html`
<div class="card shadow-sm"><div class="card-header bg-white"><i class="bi bi-people"></i> Department Booking Summary</div>
    <div class="table-responsive"><table class="table mb-0"><thead><tr><th>Status</th><th>Total</th></tr></thead>
    <tbody>${raw(deptSummaryHtml || '<tr><td colspan="2" class="text-center text-muted py-3">No bookings in your department yet.</td></tr>')}</tbody></table></div>
</div>
<a href="/manager/department_requests" class="btn btn-primary mt-3">View Department Requests</a>`
    : ''}`;
}

async function pendingApprovalsBody(userId, csrfToken) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select(
                'booking_id, travel_date, direction, purpose, remarks, seats, users!bookings_user_id_fkey(full_name, employee_id, departments(department_name)), ferry_schedule(departure_time), booking_status!inner(status_name)'
            )
            .eq('current_approver_id', userId)
            // Matches both the legacy 'Waiting %' statuses and the new
            // department-hierarchy 'Pending %' statuses - a hardcoded
            // literal filter, not user input, so .or() is safe here.
            .or('status_name.like.Waiting%,status_name.like.Pending%', { foreignTable: 'booking_status' })
            .order('travel_date', { ascending: true })
    );

    const cards = rows
        .map(
            (r) => html`
<div class="col-md-6">
    <div class="card shadow-sm h-100">
        <div class="card-body">
            <div class="d-flex justify-content-between">
                <h6>${r.users.full_name} <small class="text-muted">${r.users.employee_id}</small></h6>
                <span class="badge bg-warning text-dark">Pending</span>
            </div>
            <p class="small text-muted mb-1">${r.users.departments?.department_name ?? '-'}</p>
            <p class="mb-1"><i class="bi bi-calendar3"></i> ${formatDate(r.travel_date)} at ${formatTime(r.ferry_schedule.departure_time)}</p>
            <p class="mb-1"><i class="bi bi-signpost-split"></i> ${r.direction} &middot; ${r.seats} seat(s)</p>
            <p class="mb-1"><strong>Purpose:</strong> ${r.purpose}</p>
            ${r.remarks ? html`<p class="mb-2 text-muted small">"${r.remarks}"</p>` : ''}
            <form method="post" class="mt-2">
                ${raw(csrfField(csrfToken))}
                <input type="hidden" name="booking_id" value="${r.booking_id}">
                <textarea name="comments" class="form-control form-control-sm mb-2" rows="2" placeholder="Comments (optional)"></textarea>
                <div class="d-flex gap-2">
                    <button type="submit" name="decision" value="approved" class="btn btn-sm btn-success flex-fill"><i class="bi bi-check-lg"></i> Approve</button>
                    <button type="submit" name="decision" value="rejected" class="btn btn-sm btn-danger flex-fill"><i class="bi bi-x-lg"></i> Reject</button>
                </div>
            </form>
        </div>
    </div>
</div>`
        )
        .map((c) => c.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-check2-square"></i> Pending Approvals</h5>
<div class="row g-3">
    ${raw(cards || '<p class="text-muted text-center py-4">No requests are currently awaiting your approval.</p>')}
</div>`;
}

export function registerManagerRoutes(router) {
    router.get('/manager/dashboard', async (request) => {
        const auth = await requireRole(request, [ROLE_GM, ROLE_RM, ROLE_HR, ROLE_DEPT_MGR]);
        if (auth.response) return auth.response;
        const body = await managerDashboardBody(auth.user);
        return renderShellForRequest({ request, auth, pageTitle: 'Manager Dashboard', path: '/manager/dashboard', bodyHtml: body });
    });

    router.get('/manager/approvals', async (request) => {
        // Any authenticated user, not just GM/RM/HR - department approvers
        // can hold any RBAC role. The current_approver_id = session.user.id
        // filter in pendingApprovalsBody already scopes results correctly;
        // a user with nothing assigned to them just sees the empty state.
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;
        const body = await pendingApprovalsBody(auth.user.user_id, auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'Pending Approvals', path: '/manager/approvals', bodyHtml: body });
    });

    router.post('/manager/approvals', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;
        const { user } = auth;

        const form = await request.formData();
        if (!verifyCsrf(user.csrf, form.get('csrf_token'))) return notFound();

        const bookingId = Number(form.get('booking_id'));
        const decision = form.get('decision');
        const comments = (form.get('comments') || '').toString().trim();

        if (!['approved', 'rejected'].includes(decision)) {
            return redirectTo('/manager/approvals', { cookies: [auth.setCookie, flashSetCookie('error', 'Invalid decision.')].filter(Boolean) });
        }

        const bookingRows = unwrap(
            await db()
                .from('bookings')
                .select('user_id, current_approver_id, status_id, booking_status(status_name), users!bookings_user_id_fkey(department_id, resort_id)')
                .eq('booking_id', bookingId)
                .limit(1)
        );
        const booking = bookingRows[0];
        if (!booking || booking.current_approver_id !== user.user_id) {
            return redirectTo('/manager/approvals', { cookies: [auth.setCookie, flashSetCookie('error', 'This request is not assigned to you.')].filter(Boolean) });
        }

        const newStatusRows = unwrap(
            await db().from('booking_status').select('status_id, status_name').eq('status_name', decision === 'approved' ? 'Approved' : 'Rejected').limit(1)
        );
        const newStatus = newStatusRows[0];

        // Conditional compare-and-swap: only updates if this booking is still
        // in the exact state we read it in, guarding against a double-click
        // producing two booking_approvals audit rows for the same decision.
        const { data: updatedRows, error: updateError } = await db()
            .from('bookings')
            .update({ status_id: newStatus.status_id })
            .eq('booking_id', bookingId)
            .eq('current_approver_id', user.user_id)
            .eq('status_id', booking.status_id)
            .select('booking_id');
        if (updateError) throw new Error(updateError.message);

        if (updatedRows.length) {
            const approvalLevel = LEVEL_BY_STATUS_NAME[booking.booking_status?.status_name] ?? null;
            unwrap(
                await db().from('booking_approvals').insert({
                    booking_id: bookingId,
                    approver_id: user.user_id,
                    role_at_approval: user.role_name,
                    action: decision,
                    comments: comments || null,
                    approval_level: approvalLevel,
                    department_id: booking.users?.department_id ?? null,
                    resort_id: booking.users?.resort_id ?? null,
                })
            );

            const message =
                decision === 'approved'
                    ? `Your ferry booking has been approved by ${user.full_name}.`
                    : `Your ferry booking has been rejected by ${user.full_name}${comments ? ' - ' + comments : ''}.`;
            await createNotification(booking.user_id, message, 'booking', bookingId);

            if (decision === 'approved') {
                const coordinators = unwrap(
                    await db()
                        .from('users')
                        .select('user_id, roles!inner(role_name)')
                        .eq('status', 'active')
                        .eq('roles.role_name', 'Transport Coordinator')
                );
                for (const tc of coordinators) {
                    await createNotification(tc.user_id, 'A new ferry booking has been approved and is ready for the passenger manifest.', 'booking', bookingId);
                }
            }

            await logActivity(user.user_id, `${decision.charAt(0).toUpperCase()}${decision.slice(1)} booking`, `booking_id=${bookingId}`, clientIp(request));
        }

        return redirectTo('/manager/approvals', { cookies: [auth.setCookie, flashSetCookie('success', 'Decision recorded.')].filter(Boolean) });
    });
}
