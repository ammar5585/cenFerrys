// Port of admin/bookings.php: all-bookings view, direct status override,
// and the admin-override booking (bypasses capacity + approval chain
// entirely, matching the PHP version exactly).

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getStatusId } from '../approval.js';
import { createNotification } from '../notifications.js';
import { notifySecurityIfWaitingList } from '../security.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDate, formatTime, statusBadgeClass } from '../format.js';

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

async function bookingsPageBody({ dateFrom, dateTo, statusFilter, deptFilter, csrfToken }) {
    let query = db()
        .from('bookings')
        .select(
            'booking_id, travel_date, direction, purpose, seats, admin_override, status_id, users!bookings_user_id_fkey(full_name, employee_id, department_id, departments(department_name)), booking_status(status_name, badge_color), ferry_schedule(departure_time)'
        )
        .order('travel_date', { ascending: false })
        .limit(300);
    if (dateFrom) query = query.gte('travel_date', dateFrom);
    if (dateTo) query = query.lte('travel_date', dateTo);
    if (statusFilter) query = query.eq('status_id', statusFilter);
    let bookings = unwrap(await query);
    if (deptFilter) bookings = bookings.filter((b) => b.users.department_id === deptFilter);

    const statuses = unwrap(await db().from('booking_status').select('*').order('status_id'));
    const departments = unwrap(await db().from('departments').select('*').order('department_name'));
    const activeUsers = unwrap(await db().from('users').select('user_id, full_name, employee_id').eq('status', 'active').order('full_name'));
    const schedules = unwrap(await db().from('ferry_schedule').select('schedule_id, departure_time, ferry_routes(direction)').eq('status', 'active').order('departure_time'));

    const rowsHtml = bookings
        .map(
            (b) => html`<tr>
            <td>${b.users.full_name} <small class="text-muted">${b.users.employee_id}</small></td>
            <td>${b.users.departments?.department_name ?? '-'}</td>
            <td>${formatDate(b.travel_date)}</td>
            <td>${formatTime(b.ferry_schedule.departure_time)}</td>
            <td>${b.direction}</td>
            <td>${b.seats}${b.admin_override ? html` <span class="badge bg-warning text-dark">Override</span>` : ''}</td>
            <td>${b.purpose}</td>
            <td><span class="badge ${statusBadgeClass(b.booking_status.badge_color)}">${b.booking_status.status_name}</span></td>
            <td>
                <form method="post" class="d-flex gap-1">
                    ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="set_status"><input type="hidden" name="booking_id" value="${b.booking_id}">
                    <select name="status_id" class="form-select form-select-sm">
                        ${raw(statuses.map((s) => `<option value="${s.status_id}" ${s.status_id === b.status_id ? 'selected' : ''}>${h(s.status_name)}</option>`).join(''))}
                    </select>
                    <button class="btn btn-sm btn-outline-primary">Set</button>
                </form>
            </td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="mb-0"><i class="bi bi-journal-check"></i> All Bookings</h5>
    <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#overrideModal"><i class="bi bi-shield-plus"></i> Admin Override Booking</button>
</div>
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-3"><input type="date" name="date_from" class="form-control" value="${dateFrom}"></div>
        <div class="col-md-3"><input type="date" name="date_to" class="form-control" value="${dateTo}"></div>
        <div class="col-md-3"><select name="status" class="form-select"><option value="0">All Status</option>${raw(statuses.map((s) => `<option value="${s.status_id}" ${statusFilter == s.status_id ? 'selected' : ''}>${h(s.status_name)}</option>`).join(''))}</select></div>
        <div class="col-md-3"><select name="department" class="form-select"><option value="0">All Departments</option>${raw(departments.map((d) => `<option value="${d.department_id}" ${deptFilter == d.department_id ? 'selected' : ''}>${h(d.department_name)}</option>`).join(''))}</select></div>
        <div class="col-12"><button class="btn btn-sm btn-outline-primary" type="submit"><i class="bi bi-search"></i> Filter</button> <a href="/admin/bookings" class="btn btn-sm btn-outline-secondary">Reset</a></div>
    </form>
</div></div>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Employee</th><th>Department</th><th>Date</th><th>Time</th><th>Direction</th><th>Seats</th><th>Purpose</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="9" class="text-center text-muted py-4">No bookings found.</td></tr>')}</tbody>
</table></div></div>
<div class="modal fade" id="overrideModal" tabindex="-1"><div class="modal-dialog"><form method="post" class="modal-content">
    ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="override_booking">
    <div class="modal-header"><h5 class="modal-title"><i class="bi bi-shield-plus"></i> Admin Override Booking</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <p class="text-muted small">This creates a booking that bypasses seat capacity limits and is instantly approved.</p>
        <div class="mb-3"><label class="form-label">Staff Member</label><select name="user_id" class="form-select" required>${raw(activeUsers.map((u) => `<option value="${u.user_id}">${h(u.full_name)} (${h(u.employee_id)})</option>`).join(''))}</select></div>
        <div class="mb-3"><label class="form-label">Ferry Schedule</label><select name="schedule_id" class="form-select" required>${raw(schedules.map((s) => `<option value="${s.schedule_id}">${h(s.ferry_routes.direction)} - ${h(formatTime(s.departure_time))}</option>`).join(''))}</select></div>
        <div class="mb-3"><label class="form-label">Travel Date</label><input type="date" name="travel_date" class="form-control" required value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="mb-3"><label class="form-label">Seats</label><input type="number" name="seats" class="form-control" min="1" value="1" required></div>
        <div class="mb-3"><label class="form-label">Purpose</label><input type="text" name="purpose" class="form-control" required></div>
        <div class="mb-3"><label class="form-label">Remarks</label><textarea name="remarks" class="form-control" rows="2"></textarea></div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Create & Approve</button></div>
</form></div></div>`;
}

export function registerAdminBookingsRoutes(router) {
    router.get('/admin/bookings', async (request) => {
        const auth = await requirePermission(request, 'booking.view_all', { pageTitle: 'All Bookings' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const body = await bookingsPageBody({
            dateFrom: url.searchParams.get('date_from') || '',
            dateTo: url.searchParams.get('date_to') || '',
            statusFilter: Number(url.searchParams.get('status') || 0),
            deptFilter: Number(url.searchParams.get('department') || 0),
            csrfToken: auth.user.csrf,
        });
        return renderShellForRequest({ request, auth, pageTitle: 'All Bookings', path: '/admin/bookings', bodyHtml: body });
    });

    router.post('/admin/bookings', async (request) => {
        const auth = await requirePermission(request, 'booking.admin_override', { pageTitle: 'All Bookings' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        if (form.action === 'override_booking') {
            const userId = Number(form.user_id);
            const scheduleId = Number(form.schedule_id);
            const travelDate = form.travel_date;
            const seats = Math.max(1, Number(form.seats));
            const purpose = (form.purpose || '').trim() || 'Admin booking';
            const remarks = (form.remarks || '').trim() || null;

            const scheduleRows = unwrap(await db().from('ferry_schedule').select('ferry_routes(direction)').eq('schedule_id', scheduleId).limit(1));
            const direction = scheduleRows[0]?.ferry_routes?.direction;
            const approvedId = await getStatusId('Approved');

            const inserted = unwrap(
                await db()
                    .from('bookings')
                    .insert({ user_id: userId, schedule_id: scheduleId, travel_date: travelDate, direction, purpose, remarks, seats, status_id: approvedId, admin_override: true })
                    .select('booking_id')
            );
            const bookingId = inserted[0].booking_id;

            await createNotification(userId, 'Administrator created and approved a ferry booking for you.', 'booking', bookingId);
            await logActivity(user.user_id, 'Admin override booking', `booking_id=${bookingId}`, clientIp(request));
            return redirectTo('/admin/bookings', { cookies: [auth.setCookie, flashSetCookie('success', 'Booking created and approved via administrator override.')].filter(Boolean) });
        }

        if (form.action === 'set_status') {
            const bookingId = Number(form.booking_id);
            const statusId = Number(form.status_id);
            const statusRows = unwrap(await db().from('booking_status').select('status_name').eq('status_id', statusId).limit(1));
            const statusName = statusRows[0]?.status_name;

            unwrap(await db().from('bookings').update({ status_id: statusId }).eq('booking_id', bookingId));

            const bookingRows = unwrap(await db().from('bookings').select('user_id, schedule_id, travel_date').eq('booking_id', bookingId).limit(1));
            if (bookingRows.length) {
                await createNotification(bookingRows[0].user_id, `Administrator updated your booking status to: ${statusName}.`, 'booking', bookingId);
                // An admin change to a released status (Cancelled/Rejected/No
                // Show) frees a seat - prompt Security if a waiting list exists.
                if (['Cancelled', 'Rejected', 'No Show'].includes(statusName)) {
                    await notifySecurityIfWaitingList(bookingRows[0].schedule_id, bookingRows[0].travel_date);
                }
            }
            await logActivity(user.user_id, 'Admin changed booking status', `booking_id=${bookingId} -> ${statusName}`, clientIp(request));
            return redirectTo('/admin/bookings', { cookies: [auth.setCookie, flashSetCookie('success', 'Booking status updated.')].filter(Boolean) });
        }

        return redirectTo('/admin/bookings', { cookies: [auth.setCookie] });
    });
}
