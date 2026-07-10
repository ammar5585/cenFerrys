// HOD Self-Service Reserved Seats: lets a Department Manager (or any
// role granted approval_workflow.manage_reserved_seats) request,
// assign, and cancel their OWN department's HOD reserved seat blocks -
// the self-service counterpart to Security's assign-only workflow in
// routes/security.js. All business logic is reused as-is from
// hodSeatAssignment.js; this file only adds an extra
// department/resort-ownership check in front of every mutation, since
// those functions don't themselves know who is allowed to act on a
// given reservation_id/booking_id.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getHodReservationsForScheduleDate, searchHodSeatCandidates, assignEmployeeToHodSeat, releaseHodSeatAssignment, createHodReservation, deleteHodReservation } from '../hodSeatAssignment.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatTime } from '../format.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CANCEL_REASON = 'Cancelled by Department Manager from the Reserved Seats page';

const ACTION_SUCCESS = {
    create_reservation: 'Reserved seat request submitted.',
    assign_seat: 'Employee assigned to your reserved seat.',
    release_seat: 'Reserved seat released - it is now available to assign again.',
    cancel_reservation: 'Reserved seat request cancelled.',
};
const ACTION_ERROR = {
    reservation_not_available: 'This reservation is no longer available for this date.',
    employee_not_in_department: 'That employee is not an active employee in your department.',
    seat_unavailable: 'No reserved seats remain available.',
    already_assigned: 'This employee is already assigned to a reserved seat for this schedule.',
    not_hod_assignment: 'This booking is not a reserved-seat assignment.',
    too_late_to_release: 'This passenger has already departed - it is too late to release.',
    invalid_seats: 'Please enter a valid number of seats.',
    invalid_schedule: 'That ferry schedule was not found.',
    invalid_department: 'Your account has no department set - contact an Administrator.',
    invalid_resort: 'Your account has no resort set - contact an Administrator.',
    seats_already_assigned: 'This reservation already has an employee assigned - release them before cancelling it.',
    no_department: 'Your account has no department and/or resort assigned - contact an Administrator before requesting reserved seats.',
    cross_resort: 'That employee is based at a different resort - cross-resort assignments need an HR Manager or Administrator override via the Security manifest page.',
};

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

async function ownDepartmentAndResort(userId) {
    const rows = unwrap(
        await db().from('users').select('department_id, resort_id, departments(department_name), resorts(resort_name)').eq('user_id', userId).limit(1)
    );
    return rows[0] ?? {};
}

async function activeSchedulesForDate(travelDate) {
    const weekday = WEEKDAY_ABBR[new Date(`${travelDate}T00:00:00Z`).getUTCDay()];
    const rows = unwrap(
        await db().from('ferry_schedule').select('schedule_id, departure_time, weekdays, ferry_routes(direction)').eq('status', 'active').order('departure_time', { ascending: true })
    );
    return rows.filter((s) => s.weekdays.includes(weekday));
}

/** Every mutation below re-checks this before calling into hodSeatAssignment.js - those functions validate the employee's own department, but not who is allowed to act on a given reservation/booking in the first place. */
async function reservationBelongsToDepartment(reservationId, departmentId) {
    const rows = unwrap(await db().from('seat_reservations').select('reservation_id, department_id').eq('reservation_id', reservationId).limit(1));
    return rows[0]?.department_id === departmentId;
}

async function bookingBelongsToDepartment(bookingId, departmentId) {
    const bookingRows = unwrap(await db().from('bookings').select('booking_id, source_reservation_id').eq('booking_id', bookingId).limit(1));
    const sourceReservationId = bookingRows[0]?.source_reservation_id;
    if (!sourceReservationId) return false;
    return reservationBelongsToDepartment(sourceReservationId, departmentId);
}

async function employeeInResort(employeeUserId, resortId) {
    const rows = unwrap(await db().from('users').select('user_id, resort_id').eq('user_id', employeeUserId).limit(1));
    return rows[0]?.resort_id === resortId;
}

/** Assign-only modal (no Reassign mode, unlike Security's shared hodSeatModalHtml in routes/security.js - HODs release then re-assign instead). */
function reservedSeatModalHtml({ reservation, candidates, csrfToken, date, scheduleId }) {
    const optionsHtml = candidates
        .map((c) => {
            const suffix = c.alreadyAssignedElsewhere
                ? ' - already assigned to a reserved seat for this schedule'
                : c.hasExistingBooking
                  ? ' - already has a booking for this schedule'
                  : '';
            return `<option value="${c.user_id}" data-search="${h(`${c.full_name} ${c.employee_id}`.toLowerCase())}" ${c.alreadyAssignedElsewhere ? 'disabled' : ''}>${h(c.full_name)} (${h(c.employee_id)})${c.designation ? ` - ${h(c.designation)}` : ''}${h(suffix)}</option>`;
        })
        .join('');

    return `<div class="modal fade" id="reservedSeatModal${reservation.reservationId}" tabindex="-1"><div class="modal-dialog"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}
    <input type="hidden" name="action" value="assign_seat">
    <input type="hidden" name="reservation_id" value="${reservation.reservationId}">
    <input type="hidden" name="schedule_id" value="${scheduleId}">
    <input type="hidden" name="date" value="${date}">
    <div class="modal-header"><h5 class="modal-title"><i class="bi bi-person-plus"></i> Assign Employee</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="mb-2"><input type="text" class="form-control reserved-seat-search-input" placeholder="Search Employee ID or Name"></div>
        <select name="employee_user_id" size="8" class="form-select reserved-seat-candidate-select" required>${optionsHtml}</select>
        <div class="mb-0 mt-2"><label class="form-label">Remarks (optional)</label><textarea name="remarks" class="form-control" rows="2"></textarea></div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Confirm</button></div>
</form></div></div>`;
}

const RESERVED_SEAT_MODAL_SCRIPT = `
(function () {
    document.querySelectorAll('.modal[id^="reservedSeatModal"]').forEach(function (modal) {
        var searchInput = modal.querySelector('.reserved-seat-search-input');
        var select = modal.querySelector('.reserved-seat-candidate-select');
        if (!searchInput || !select) return;
        searchInput.addEventListener('input', function () {
            var needle = searchInput.value.toLowerCase();
            Array.prototype.forEach.call(select.options, function (opt) {
                opt.hidden = needle && opt.dataset.search.indexOf(needle) === -1;
            });
        });
    });
})();`;

async function reservedSeatsPageBody({ date, scheduleId, schedules, departmentId, departmentName, resortId, resortName, csrfToken }) {
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

    if (!departmentId || !resortId) {
        return html`
<h5 class="mb-3"><i class="bi bi-bookmark-star"></i> Department Reserved Seats</h5>
<div class="alert alert-warning">Your account has no department and/or resort assigned, so reserved seats cannot be managed here. Please contact an Administrator.</div>`;
    }

    const allReservations = scheduleId ? await getHodReservationsForScheduleDate(scheduleId, date) : [];
    const reservations = allReservations.filter((r) => r.departmentId === departmentId && (r.resortId === resortId || r.resortId == null));

    const candidatesByReservation = new Map();
    if (reservations.length) {
        await Promise.all(
            reservations.map(async (r) => {
                const candidates = await searchHodSeatCandidates({ reservationId: r.reservationId, travelDate: date, needle: '' });
                candidatesByReservation.set(r.reservationId, candidates.filter((c) => c.resort_id === resortId));
            })
        );
    }

    const createFormHtml = scheduleId
        ? `<form method="post" class="d-flex flex-wrap gap-2 align-items-end p-3 border-top">
            ${csrfField(csrfToken)}<input type="hidden" name="action" value="create_reservation"><input type="hidden" name="date" value="${date}"><input type="hidden" name="schedule_id" value="${scheduleId}">
            <div><label class="form-label small mb-0">Seats requested</label><input type="number" name="seats" class="form-control form-control-sm" min="1" value="1" style="width:100px" required></div>
            <button class="btn btn-sm btn-primary"><i class="bi bi-plus-lg"></i> Request Reserved Seat(s)</button>
        </form>`
        : '';

    const tableHtml = reservations.length
        ? html`<div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
        <thead><tr><th>Reserved</th><th>Assigned</th><th>Available</th><th>Currently Assigned</th><th>Actions</th></tr></thead>
        <tbody>${raw(
            reservations
                .map((r) => {
                    const assignedHtml = r.assignments.length
                        ? r.assignments
                              .map((a) => {
                                  const canRelease = ['Approved', 'Checked-In'].includes(a.statusName);
                                  const releaseForm = canRelease
                                      ? `<form method="post" class="d-inline" data-confirm="Release this reserved seat? ${h(a.fullName)} will be removed.">${csrfField(csrfToken)}<input type="hidden" name="action" value="release_seat"><input type="hidden" name="booking_id" value="${a.bookingId}"><input type="hidden" name="date" value="${date}"><input type="hidden" name="schedule_id" value="${scheduleId}"><button class="btn btn-sm btn-outline-secondary py-0">Release</button></form>`
                                      : '';
                                  return `<div class="mb-1">${h(a.fullName)} (${h(a.employeeId)}) - ${h(a.statusName)} ${releaseForm}</div>`;
                              })
                              .join('')
                        : '<span class="text-muted">None</span>';
                    const assignBtn =
                        r.seatsAvailable > 0
                            ? `<button type="button" class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#reservedSeatModal${r.reservationId}">Assign</button>`
                            : '<span class="text-muted small">Full</span>';
                    const cancelBtn =
                        r.seatsAssigned === 0
                            ? `<form method="post" class="d-inline ms-1" data-confirm="Cancel this reserved seat request? This cannot be undone.">${csrfField(csrfToken)}<input type="hidden" name="action" value="cancel_reservation"><input type="hidden" name="reservation_id" value="${r.reservationId}"><input type="hidden" name="date" value="${date}"><input type="hidden" name="schedule_id" value="${scheduleId}"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>`
                            : '';
                    return `<tr>
                    <td>${r.seatsTotal}</td><td>${r.seatsAssigned}</td><td>${r.seatsAvailable}</td>
                    <td>${assignedHtml}</td>
                    <td>${assignBtn}${cancelBtn}</td>
                </tr>`;
                })
                .join('')
        )}</tbody>
    </table></div>`
        : html`<div class="p-3 text-muted small">No reserved seats requested for this schedule/date yet.</div>`;

    const modalsHtml = reservations
        .map((r) => reservedSeatModalHtml({ reservation: r, candidates: candidatesByReservation.get(r.reservationId) ?? [], csrfToken, date, scheduleId }))
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-bookmark-star"></i> Department Reserved Seats</h5>
<p class="text-muted mb-3">${h(departmentName)} &middot; ${h(resortName)}</p>
${pickerHtml}
<div class="card shadow-sm mb-3">
    <div class="card-header bg-white">Reserved Seats for This Departure</div>
    ${scheduleId ? tableHtml : html`<div class="p-3 text-muted small">Choose a date and ferry schedule above to view or request reserved seats.</div>`}
    ${raw(createFormHtml)}
</div>
${raw(modalsHtml)}
${reservations.length ? html`<script>${raw(RESERVED_SEAT_MODAL_SCRIPT)}</script>` : ''}`;
}

export function registerHodReservationRoutes(router) {
    router.get('/manager/reserved_seats', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.manage_reserved_seats', { pageTitle: 'Department Reserved Seats' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const scheduleId = Number(url.searchParams.get('schedule_id') || 0);
        const schedules = await activeSchedulesForDate(date);
        const own = await ownDepartmentAndResort(auth.user.user_id);
        const body = await reservedSeatsPageBody({
            date,
            scheduleId,
            schedules,
            departmentId: own.department_id ?? null,
            departmentName: own.departments?.department_name ?? '-',
            resortId: own.resort_id ?? null,
            resortName: own.resorts?.resort_name ?? '-',
            csrfToken: auth.user.csrf,
        });
        return renderShellForRequest({ request, auth, pageTitle: 'Department Reserved Seats', path: '/manager/reserved_seats', bodyHtml: body });
    });

    router.post('/manager/reserved_seats', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.manage_reserved_seats', { pageTitle: 'Department Reserved Seats' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const backTo = `/manager/reserved_seats?date=${form.date || ''}&schedule_id=${form.schedule_id || ''}`;
        const action = form.action;
        const own = await ownDepartmentAndResort(user.user_id);
        if (!own.department_id || !own.resort_id) {
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('error', ACTION_ERROR.no_department)].filter(Boolean) });
        }

        if (action === 'create_reservation') {
            const result = await createHodReservation({
                scheduleId: Number(form.schedule_id),
                travelDate: form.date,
                departmentId: own.department_id,
                resortId: own.resort_id,
                seats: Number(form.seats),
                createdByUserId: user.user_id,
            });
            await logActivity(user.user_id, 'HOD: create_reservation', `schedule_id=${form.schedule_id || ''} seats=${form.seats || ''}`, clientIp(request));
            return redirectTo(backTo, {
                cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? ACTION_SUCCESS[action] : ACTION_ERROR[result.reason] || 'Could not complete this action.')].filter(Boolean),
            });
        }

        if (action === 'assign_seat') {
            const reservationId = Number(form.reservation_id);
            if (!(await reservationBelongsToDepartment(reservationId, own.department_id))) return notFound();
            const employeeUserId = Number(form.employee_user_id);
            if (!(await employeeInResort(employeeUserId, own.resort_id))) {
                return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('error', ACTION_ERROR.cross_resort)].filter(Boolean) });
            }
            const result = await assignEmployeeToHodSeat({
                reservationId,
                travelDate: form.date,
                employeeUserId,
                assignedByUserId: user.user_id,
                remarks: (form.remarks || '').trim() || null,
            });
            await logActivity(user.user_id, 'HOD: assign_seat', `reservation_id=${form.reservation_id || ''}`, clientIp(request));
            return redirectTo(backTo, {
                cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? ACTION_SUCCESS[action] : ACTION_ERROR[result.reason] || 'Could not complete this action.')].filter(Boolean),
            });
        }

        if (action === 'release_seat') {
            const bookingId = Number(form.booking_id);
            if (!(await bookingBelongsToDepartment(bookingId, own.department_id))) return notFound();
            const result = await releaseHodSeatAssignment({ bookingId, releasedByUserId: user.user_id, remarks: null });
            await logActivity(user.user_id, 'HOD: release_seat', `booking_id=${form.booking_id || ''}`, clientIp(request));
            return redirectTo(backTo, {
                cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? ACTION_SUCCESS[action] : ACTION_ERROR[result.reason] || 'Could not complete this action.')].filter(Boolean),
            });
        }

        if (action === 'cancel_reservation') {
            const reservationId = Number(form.reservation_id);
            if (!(await reservationBelongsToDepartment(reservationId, own.department_id))) return notFound();
            const result = await deleteHodReservation({ reservationId, deletedByUserId: user.user_id, reason: CANCEL_REASON });
            await logActivity(user.user_id, 'HOD: cancel_reservation', `reservation_id=${form.reservation_id || ''}`, clientIp(request));
            return redirectTo(backTo, {
                cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? ACTION_SUCCESS[action] : ACTION_ERROR[result.reason] || 'Could not complete this action.')].filter(Boolean),
            });
        }

        return redirectTo(backTo, { cookies: [auth.setCookie] });
    });
}
