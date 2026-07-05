// Port of manager/history.php, manager/availability.php, manager/department_requests.php.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDate, formatDateTime, formatTime, statusBadgeClass } from '../format.js';

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

// ---------------------------------------------------------------------
// Approval history
// ---------------------------------------------------------------------
async function historyBody(userId) {
    const rows = unwrap(
        await db()
            .from('booking_approvals')
            .select('action, comments, action_at, bookings(travel_date, purpose, direction, users!bookings_user_id_fkey(full_name, employee_id))')
            .eq('approver_id', userId)
            .order('action_at', { ascending: false })
    );

    const rowsHtml = rows
        .map(
            (h) => html`<tr>
            <td>${h.bookings.users.full_name} <small class="text-muted">${h.bookings.users.employee_id}</small></td>
            <td>${formatDate(h.bookings.travel_date)}</td><td>${h.bookings.direction}</td><td>${h.bookings.purpose}</td>
            <td><span class="badge ${h.action === 'approved' ? 'bg-success' : 'bg-danger'}">${h.action.charAt(0).toUpperCase() + h.action.slice(1)}</span></td>
            <td>${h.comments ?? ''}</td><td>${formatDateTime(h.action_at)}</td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-clock-history"></i> Approval History</h5>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Employee</th><th>Travel Date</th><th>Direction</th><th>Purpose</th><th>Decision</th><th>Comments</th><th>Date</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="7" class="text-center text-muted py-4">No approval decisions recorded yet.</td></tr>')}</tbody>
</table></div></div>`;
}

// ---------------------------------------------------------------------
// Self-service availability
// ---------------------------------------------------------------------
async function availabilityBody(userId, csrfToken) {
    const rows = unwrap(await db().from('manager_availability').select('status, remarks').eq('user_id', userId).limit(1));
    const current = rows[0] ?? { status: 'available', remarks: '' };

    return html`
<h5 class="mb-3"><i class="bi bi-person-check"></i> My Availability</h5>
<p class="text-muted">Set your status so the system knows whether to route approval requests to you.</p>
<div class="card shadow-sm" style="max-width:420px;"><div class="card-body">
    <form method="post">
        ${raw(csrfField(csrfToken))}
        <div class="mb-3"><label class="form-label">Status</label>
            <select name="status" class="form-select">
                <option value="available" ${current.status === 'available' ? 'selected' : ''}>Available</option>
                <option value="on_leave" ${current.status === 'on_leave' ? 'selected' : ''}>On Leave</option>
                <option value="out_of_office" ${current.status === 'out_of_office' ? 'selected' : ''}>Out of Office</option>
            </select>
        </div>
        <div class="mb-3"><label class="form-label">Remarks (optional)</label><input type="text" name="remarks" class="form-control" value="${current.remarks ?? ''}"></div>
        <button type="submit" class="btn btn-primary w-100">Update Availability</button>
    </form>
</div></div>`;
}

// ---------------------------------------------------------------------
// Department requests (Department Manager, read-only)
// ---------------------------------------------------------------------
async function departmentRequestsBody(userId) {
    const selfRows = unwrap(await db().from('users').select('department_id, resort_id').eq('user_id', userId).limit(1));
    const departmentId = selfRows[0]?.department_id;
    const resortId = selfRows[0]?.resort_id;

    let rows = [];
    if (departmentId && resortId) {
        rows = unwrap(
            await db()
                .from('bookings')
                .select('booking_id, travel_date, direction, purpose, users!bookings_user_id_fkey(full_name, employee_id, department_id, resort_id), ferry_schedule(departure_time), booking_status(status_name, badge_color)')
                .order('travel_date', { ascending: false })
        );
        rows = rows.filter((r) => r.users.department_id === departmentId && r.users.resort_id === resortId);
    }

    const rowsHtml = rows
        .map(
            (r) => html`<tr>
            <td>${r.users.full_name} <small class="text-muted">${r.users.employee_id}</small></td>
            <td>${formatDate(r.travel_date)}</td><td>${formatTime(r.ferry_schedule.departure_time)}</td><td>${r.direction}</td><td>${r.purpose}</td>
            <td><span class="badge ${statusBadgeClass(r.booking_status.badge_color)}">${r.booking_status.status_name}</span></td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-people"></i> Department Booking Requests</h5>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Employee</th><th>Date</th><th>Time</th><th>Direction</th><th>Purpose</th><th>Status</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="6" class="text-center text-muted py-4">No bookings found for your department.</td></tr>')}</tbody>
</table></div></div>`;
}

export function registerManagerExtraRoutes(router) {
    router.get('/manager/history', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.view_history', { pageTitle: 'Approval History' });
        if (auth.response) return auth.response;
        const body = await historyBody(auth.user.user_id);
        return renderShellForRequest({ request, auth, pageTitle: 'Approval History', path: '/manager/history', bodyHtml: body });
    });

    router.get('/manager/availability', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.manage_own_availability', { pageTitle: 'My Availability' });
        if (auth.response) return auth.response;
        const body = await availabilityBody(auth.user.user_id, auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'My Availability', path: '/manager/availability', bodyHtml: body });
    });

    router.post('/manager/availability', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.manage_own_availability', { pageTitle: 'My Availability' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        if (['available', 'on_leave', 'out_of_office'].includes(form.status)) {
            unwrap(
                await db()
                    .from('manager_availability')
                    .upsert({ user_id: user.user_id, status: form.status, remarks: (form.remarks || '').trim() || null }, { onConflict: 'user_id' })
            );
            await logActivity(user.user_id, 'Updated own availability', form.status, clientIp(request));
        }
        return redirectTo('/manager/availability', { cookies: [auth.setCookie, flashSetCookie('success', 'Your availability has been updated.')].filter(Boolean) });
    });

    router.get('/manager/department_requests', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.view_department_requests', { pageTitle: 'Department Requests' });
        if (auth.response) return auth.response;
        const body = await departmentRequestsBody(auth.user.user_id);
        return renderShellForRequest({ request, auth, pageTitle: 'Department Requests', path: '/manager/department_requests', bodyHtml: body });
    });
}
