// HOD Reserved Seat Request (self-service): lets a Department Manager
// (or any role granted approval_workflow.manage_reserved_seats) reserve
// a seat for THEMSELVES ONLY, against their own resort's admin-
// configured HOD seat pool - never for another employee. This is
// deliberately much simpler than Security's assign-any-department-
// employee workflow in routes/security.js: no candidate search, no
// department scoping, just "does a seat remain in my resort's pool for
// this schedule/date, and do I already have one". All capacity/audit
// logic lives in hodSeatAssignment.js.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getOwnHodSeatStatus, requestOwnHodSeat, cancelOwnHodSeatRequest, listOwnHodSeatRequests } from '../hodSeatAssignment.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDate, formatTime, statusBadgeClass } from '../format.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REASSIGNABLE_STATUSES = ['Approved', 'Checked-In'];

const ACTION_SUCCESS = {
    request_seat: 'Your reserved seat request has been confirmed.',
    cancel_request: 'Your reserved seat request has been cancelled.',
};
const ACTION_ERROR = {
    invalid_resort: 'Your account has no resort assigned, or does not match this resort - contact an Administrator.',
    invalid_schedule: 'That ferry schedule was not found for this date.',
    already_requested: 'You already have a reserved seat for this schedule and date.',
    seat_unavailable: 'No HOD reserved seats remain available for this schedule and date.',
    not_hod_assignment: 'That request could not be found.',
    too_late_to_release: 'This trip has already departed - it is too late to cancel.',
    no_resort: 'Your account has no resort assigned - contact an Administrator before requesting a reserved seat.',
};

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

async function ownResort(userId) {
    const rows = unwrap(await db().from('users').select('resort_id, resorts(resort_name)').eq('user_id', userId).limit(1));
    return rows[0] ?? {};
}

async function activeSchedulesForDate(travelDate) {
    const weekday = WEEKDAY_ABBR[new Date(`${travelDate}T00:00:00Z`).getUTCDay()];
    const rows = unwrap(
        await db().from('ferry_schedule').select('schedule_id, departure_time, weekdays, ferry_routes(direction)').eq('status', 'active').order('departure_time', { ascending: true })
    );
    return rows.filter((s) => s.weekdays.includes(weekday));
}

async function hodSeatRequestPageBody({ date, scheduleId, schedules, resortId, resortName, userId, csrfToken }) {
    const scheduleOptions = schedules
        .map((s) => `<option value="${s.schedule_id}" ${scheduleId === s.schedule_id ? 'selected' : ''}>${h(s.ferry_routes.direction)} - ${h(formatTime(s.departure_time))}</option>`)
        .join('');
    const pickerHtml = html`
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-4"><label class="form-label">Date</label><input type="date" name="date" class="form-control" value="${date}"></div>
        <div class="col-md-5"><label class="form-label">Ferry Schedule</label><select name="schedule_id" class="form-select"><option value="0">-- Select Departure --</option>${raw(scheduleOptions)}</select></div>
        <div class="col-md-3 d-flex align-items-end"><button class="btn btn-outline-primary btn-sm w-100" type="submit">View</button></div>
    </form>
</div></div>`;

    const history = await listOwnHodSeatRequests(userId);
    const historyHtml = history.length
        ? html`<div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
        <thead><tr><th>Date</th><th>Route</th><th>Resort</th><th>Booking Ref</th><th>Status</th></tr></thead>
        <tbody>${raw(
            history
                .map(
                    (r) => `<tr>
                <td>${formatDate(r.travel_date)} ${formatTime(r.ferry_schedule.departure_time)}</td>
                <td>${h(r.ferry_schedule.ferry_routes.direction)}</td>
                <td>${h(r.resortName)}</td>
                <td>BK-${r.booking_id}</td>
                <td><span class="badge ${statusBadgeClass(r.booking_status.badge_color)}">${h(r.booking_status.status_name)}</span></td>
            </tr>`
                )
                .join('')
        )}</tbody>
    </table></div>`
        : html`<div class="p-3 text-muted small">You haven't made any reserved seat requests yet.</div>`;

    if (!resortId) {
        return html`
<h5 class="mb-3"><i class="bi bi-bookmark-star"></i> HOD Reserved Seat Request</h5>
<div class="alert alert-warning">Your account has no resort assigned, so a reserved seat cannot be requested. Please contact an Administrator.</div>
<div class="card shadow-sm"><div class="card-header bg-white">My Requests</div>${historyHtml}</div>`;
    }

    let statusHtml = '';
    if (scheduleId) {
        const status = await getOwnHodSeatStatus({ resortId, scheduleId, travelDate: date, userId });
        const canRequest = !status.myBookingId && status.seatsAvailable > 0;
        const canCancel = status.myBookingId && REASSIGNABLE_STATUSES.includes(status.myStatus);

        statusHtml = html`<div class="card shadow-sm mb-3">
    <div class="card-header bg-white">Reserved Seat Availability - ${h(resortName)}</div>
    <div class="card-body">
        <div class="row g-3 mb-3">
            <div class="col-4"><div class="text-muted small">Total</div><div class="fs-4">${status.seatsTotal}</div></div>
            <div class="col-4"><div class="text-muted small">Assigned</div><div class="fs-4">${status.seatsAssigned}</div></div>
            <div class="col-4"><div class="text-muted small">Available</div><div class="fs-4">${status.seatsAvailable}</div></div>
        </div>
        ${status.myBookingId
            ? html`<p class="mb-2">You currently have a reserved seat for this trip - status: <span class="badge bg-primary">${h(status.myStatus)}</span></p>
                ${canCancel
                    ? html`<form method="post" data-confirm="Cancel your reserved seat request?">${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="cancel_request"><input type="hidden" name="booking_id" value="${status.myBookingId}"><input type="hidden" name="date" value="${date}"><input type="hidden" name="schedule_id" value="${scheduleId}"><button class="btn btn-outline-danger btn-sm"><i class="bi bi-x-circle"></i> Cancel My Request</button></form>`
                    : ''}`
            : canRequest
              ? html`<form method="post">${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="request_seat"><input type="hidden" name="date" value="${date}"><input type="hidden" name="schedule_id" value="${scheduleId}">
                    <button class="btn btn-primary btn-sm"><i class="bi bi-bookmark-plus"></i> Request My Reserved Seat</button>
                </form>`
              : html`<p class="text-muted small mb-0">No reserved seats remain available for this schedule and date.</p>`}
    </div>
</div>`;
    }

    return html`
<h5 class="mb-3"><i class="bi bi-bookmark-star"></i> HOD Reserved Seat Request</h5>
<p class="text-muted mb-3">Reserve a seat for yourself only - resort: ${h(resortName)}</p>
${pickerHtml}
${scheduleId ? statusHtml : html`<div class="card shadow-sm mb-3"><div class="p-3 text-muted small">Choose a date and ferry schedule above to check availability.</div></div>`}
<div class="card shadow-sm"><div class="card-header bg-white">My Requests</div>${historyHtml}</div>`;
}

export function registerHodReservationRoutes(router) {
    router.get('/manager/hod_seat_request', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.manage_reserved_seats', { pageTitle: 'HOD Reserved Seat Request' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const scheduleId = Number(url.searchParams.get('schedule_id') || 0);
        const schedules = await activeSchedulesForDate(date);
        const own = await ownResort(auth.user.user_id);
        const body = await hodSeatRequestPageBody({
            date,
            scheduleId,
            schedules,
            resortId: own.resort_id ?? null,
            resortName: own.resorts?.resort_name ?? '-',
            userId: auth.user.user_id,
            csrfToken: auth.user.csrf,
        });
        return renderShellForRequest({ request, auth, pageTitle: 'HOD Reserved Seat Request', path: '/manager/hod_seat_request', bodyHtml: body });
    });

    router.post('/manager/hod_seat_request', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.manage_reserved_seats', { pageTitle: 'HOD Reserved Seat Request' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const backTo = `/manager/hod_seat_request?date=${form.date || ''}&schedule_id=${form.schedule_id || ''}`;
        const action = form.action;
        const own = await ownResort(user.user_id);
        if (!own.resort_id) {
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('error', ACTION_ERROR.no_resort)].filter(Boolean) });
        }

        if (action === 'request_seat') {
            const result = await requestOwnHodSeat({
                resortId: own.resort_id,
                scheduleId: Number(form.schedule_id),
                travelDate: form.date,
                userId: user.user_id,
                remarks: null,
            });
            await logActivity(user.user_id, 'HOD: request_seat', `schedule_id=${form.schedule_id || ''} date=${form.date || ''}`, clientIp(request));
            return redirectTo(backTo, {
                cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? ACTION_SUCCESS[action] : ACTION_ERROR[result.reason] || 'Could not complete this action.')].filter(Boolean),
            });
        }

        if (action === 'cancel_request') {
            const bookingId = Number(form.booking_id);
            const result = await cancelOwnHodSeatRequest({ bookingId, userId: user.user_id, remarks: null });
            await logActivity(user.user_id, 'HOD: cancel_request', `booking_id=${form.booking_id || ''}`, clientIp(request));
            return redirectTo(backTo, {
                cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? ACTION_SUCCESS[action] : ACTION_ERROR[result.reason] || 'Could not complete this action.')].filter(Boolean),
            });
        }

        return redirectTo(backTo, { cookies: [auth.setCookie] });
    });
}
