// Security Operations Module routes: dashboard, per-trip passenger
// manifest (check-in/departed/no-show/arrived), and waiting-list
// promotion. Business logic lives in security.js; this file stays thin,
// following the same route-file convention as transport.js/manager.js.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { hasPermission } from '../permissions.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getRemainingSeatsBatch } from '../seats.js';
import { getWaitingList, promoteWaitingListBooking, recordMovement } from '../security.js';
import {
    getHodReservationsForScheduleDate,
    searchHodSeatCandidates,
    assignEmployeeToHodSeat,
    reassignEmployeeToHodSeat,
    releaseHodSeatAssignment,
    setHodReservationDepartment,
    createHodReservation,
} from '../hodSeatAssignment.js';
import { getActiveResorts, getActiveDepartments } from '../refData.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDate, formatTime, formatDateTime, statusBadgeClass, greeting } from '../format.js';
import { ROLE_ADMIN, ROLE_HR } from '../session.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MANIFEST_STATUSES = ['Approved', 'Checked-In', 'Departed', 'Arrived', 'Completed'];

const HOD_ACTION_SUCCESS = {
    assign_hod_seat: 'Employee assigned to reserved seat.',
    reassign_hod_seat: 'Reserved seat reassigned to the new employee.',
    release_hod_seat: 'Reserved seat released - it is now available for another employee.',
    set_hod_department: 'Department set for this reserved seat.',
    create_hod_reservation: 'Reserved seat block created for this schedule and date.',
};
const HOD_ACTION_ERROR = {
    reservation_not_available: 'This reservation is no longer available for this date.',
    employee_not_in_department: 'That employee is not an active employee in this seat\'s department.',
    seat_unavailable: 'No reserved seats remain available.',
    already_assigned: 'This employee is already assigned to a reserved seat for this schedule.',
    not_hod_assignment: 'This booking is not an HOD reserved-seat assignment.',
    too_late_to_reassign: 'This passenger has already departed - it is too late to reassign.',
    too_late_to_release: 'This passenger has already departed - it is too late to release.',
    department_already_set: 'This reservation already has a department set.',
    invalid_department: 'Please choose a valid department.',
    invalid_seats: 'Please enter a valid number of seats.',
    invalid_schedule: 'That ferry schedule was not found.',
    invalid_resort: 'Please choose a valid resort.',
    seats_already_assigned: 'This reservation already has an employee assigned - release them before changing the department.',
};

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

async function activeSchedulesForDate(travelDate) {
    const weekday = WEEKDAY_ABBR[new Date(`${travelDate}T00:00:00Z`).getUTCDay()];
    const rows = unwrap(
        await db()
            .from('ferry_schedule')
            .select('schedule_id, departure_time, capacity, weekdays, ferry_routes(direction)')
            .eq('status', 'active')
            .order('departure_time', { ascending: true })
    );
    return rows.filter((s) => s.weekdays.includes(weekday));
}

/** Every passenger on a trip that's reached the boarding stage or beyond - the manifest's row set. */
async function manifestFor(scheduleId, travelDate) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select(
                'booking_id, seats, checked_in_at, departed_at, arrived_at, booking_method, source_reservation_id, users!bookings_user_id_fkey(full_name, employee_id, designation, resort_id, departments(department_name), resorts(resort_name)), booking_status!inner(status_name, badge_color)'
            )
            .eq('schedule_id', scheduleId)
            .eq('travel_date', travelDate)
            .in('booking_status.status_name', MANIFEST_STATUSES)
    );
    return rows.sort((a, b) => a.users.full_name.localeCompare(b.users.full_name));
}

async function securityDashboardBody({ fullName, search }) {
    const today = new Date().toISOString().slice(0, 10);
    const todaysSchedules = await activeSchedulesForDate(today);

    let departedToday = 0;
    let arrivedToday = 0;
    let noShowToday = 0;
    let manifestCount = 0;
    let availableSeatsTotal = 0;
    let completedTrips = 0;

    // This used to run manifestFor/getRemainingSeats/noShow/getWaitingList
    // one schedule at a time, in series, each also awaited one after the
    // other within a single schedule - 4 sequential round-trips PER
    // schedule. Remaining-seats now uses the existing batch RPC (one
    // round-trip for every schedule at once, same as admin.js's
    // dashboard); the other 3 per-schedule lookups are independent of
    // each other and of every other schedule's, so the whole thing now
    // runs concurrently via Promise.all instead of N*3 round-trips in series.
    const seatInfoById = await getRemainingSeatsBatch(todaysSchedules.map((s) => s.schedule_id), today);
    const perScheduleResults = await Promise.all(
        todaysSchedules.map(async (s) => {
            const [manifest, noShowRows, waitingList] = await Promise.all([
                manifestFor(s.schedule_id, today),
                db()
                    .from('bookings')
                    .select('booking_id, booking_status!inner(status_name)')
                    .eq('schedule_id', s.schedule_id)
                    .eq('travel_date', today)
                    .eq('booking_status.status_name', 'No Show')
                    .then(unwrap),
                getWaitingList(s.schedule_id, today),
            ]);
            const isCompleted = manifest.length > 0 && manifest.every((p) => ['Arrived', 'Completed'].includes(p.booking_status.status_name));
            return { schedule: s, manifest, noShowCount: noShowRows.length, waitingCount: waitingList.length, isCompleted };
        })
    );
    for (const r of perScheduleResults) {
        manifestCount += r.manifest.length;
        departedToday += r.manifest.filter((p) => ['Departed', 'Arrived', 'Completed'].includes(p.booking_status.status_name)).length;
        arrivedToday += r.manifest.filter((p) => ['Arrived', 'Completed'].includes(p.booking_status.status_name)).length;
        availableSeatsTotal += seatInfoById.get(r.schedule.schedule_id)?.remaining ?? 0;
        if (r.isCompleted) completedTrips++;
        noShowToday += r.noShowCount;
    }
    const tripRows = perScheduleResults.map((r) => ({ ...r.schedule, manifestCount: r.manifest.length, waitingCount: r.waitingCount, completed: r.isCompleted }));

    // Upcoming departures: the next 7 days' schedules (beyond today) -
    // independent per day, so fetched concurrently rather than one day
    // at a time.
    const upcomingDates = Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() + i + 1);
        return d.toISOString().slice(0, 10);
    });
    const upcomingCounts = await Promise.all(upcomingDates.map((d) => activeSchedulesForDate(d)));
    const upcomingCount = upcomingCounts.reduce((sum, schedules) => sum + schedules.length, 0);

    let waitingListTotal = 0;
    for (const t of tripRows) waitingListTotal += t.waitingCount;

    const tripsHtml = tripRows
        .map(
            (t) => html`<li class="dash-todo-item">
            <span class="dash-todo-dot ${t.completed ? 'bg-success' : 'bg-primary'}"></span>
            <div class="dash-todo-body">
                <div class="dash-todo-title">${formatTime(t.departure_time)} &middot; ${t.ferry_routes.direction}</div>
                <div class="dash-todo-meta">${t.manifestCount} on manifest${t.waitingCount ? ` &middot; ${t.waitingCount} waiting` : ''}${t.completed ? ' &middot; Completed' : ''}</div>
            </div>
            <a href="/security/manifest?date=${today}&schedule_id=${t.schedule_id}" class="btn btn-sm btn-outline-primary">Manifest</a>
            ${t.waitingCount ? html`<a href="/security/waiting_list?date=${today}&schedule_id=${t.schedule_id}" class="btn btn-sm btn-outline-warning">Waiting List</a>` : ''}
        </li>`
        )
        .map((r) => r.toString())
        .join('');

    let searchResultsHtml = '';
    if (search) {
        const needle = search.toLowerCase();
        const allRows = unwrap(
            await db()
                .from('bookings')
                .select(
                    'booking_id, travel_date, seats, users!bookings_user_id_fkey(full_name, employee_id, departments(department_name), resorts(resort_name)), ferry_schedule(departure_time, ferry_routes(direction)), booking_status(status_name, badge_color)'
                )
                .gte('travel_date', today)
                .order('travel_date', { ascending: true })
                .limit(500)
        );
        const matches = allRows
            .filter(
                (b) =>
                    b.users.employee_id.toLowerCase().includes(needle) ||
                    b.users.full_name.toLowerCase().includes(needle) ||
                    (b.users.departments?.department_name ?? '').toLowerCase().includes(needle) ||
                    (b.users.resorts?.resort_name ?? '').toLowerCase().includes(needle) ||
                    b.ferry_schedule.ferry_routes.direction.toLowerCase().includes(needle) ||
                    `bk-${b.booking_id}`.includes(needle)
            )
            .slice(0, 50);
        const rowsHtml = matches
            .map(
                (b) => html`<tr>
                <td>${b.users.employee_id}</td><td>${b.users.full_name}</td><td>${b.users.departments?.department_name ?? '-'}</td>
                <td>${b.users.resorts?.resort_name ?? '-'}</td><td>BK-${b.booking_id}</td>
                <td>${formatDate(b.travel_date)} ${formatTime(b.ferry_schedule.departure_time)}</td>
                <td>${b.ferry_schedule.ferry_routes.direction}</td>
                <td><span class="badge ${statusBadgeClass(b.booking_status.badge_color)}">${b.booking_status.status_name}</span></td>
            </tr>`
            )
            .map((r) => r.toString())
            .join('');
        searchResultsHtml = html`
<div class="card shadow-sm mb-3">
    <div class="card-header bg-white">Search Results</div>
    <div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
        <thead><tr><th>Employee ID</th><th>Name</th><th>Department</th><th>Resort</th><th>Booking Ref</th><th>Date/Time</th><th>Route</th><th>Status</th></tr></thead>
        <tbody>${raw(rowsHtml || '<tr><td colspan="8" class="text-center text-muted py-3">No matches.</td></tr>')}</tbody>
    </table></div>
</div>`.toString();
    }

    return html`
<div class="dash-greeting">${greeting()}, ${fullName.split(' ')[0]}!</div>
<p class="dash-greeting-sub mb-4">Security operations for today.</p>
<div class="card shadow-sm mb-4"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-8"><input type="text" name="search" class="form-control" placeholder="Search Employee ID, Name, Department, Resort, Ferry Schedule, Route, or Booking Reference" value="${search}"></div>
        <div class="col-md-2"><button class="btn btn-outline-primary w-100" type="submit"><i class="bi bi-search"></i> Search</button></div>
        <div class="col-md-2"><a href="/security/dashboard" class="btn btn-outline-secondary w-100">Reset</a></div>
    </form>
</div></div>
${raw(searchResultsHtml)}
<div class="row g-3 mb-4">
    <div class="col-sm-6 col-lg-3"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-calendar-week"></i></div><div><div class="stat-value">${upcomingCount}</div><div class="stat-label">Upcoming Departures (7d)</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-water"></i></div><div><div class="stat-value">${todaysSchedules.length}</div><div class="stat-label">Today's Departures</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-flag"></i></div><div><div class="stat-value">${arrivedToday}</div><div class="stat-label">Today's Arrivals</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-people"></i></div><div><div class="stat-value">${manifestCount}</div><div class="stat-label">Current Manifest</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-hourglass-split"></i></div><div><div class="stat-value">${waitingListTotal}</div><div class="stat-label">Waiting List</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-person-check"></i></div><div><div class="stat-value">${availableSeatsTotal}</div><div class="stat-label">Available Seats</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-box-arrow-right"></i></div><div><div class="stat-value">${departedToday}</div><div class="stat-label">Departed Today</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-x-octagon"></i></div><div><div class="stat-value">${noShowToday}</div><div class="stat-label">No-Show Today</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="stat-card d-flex align-items-center gap-3"><div class="stat-icon-badge"><i class="bi bi-check-circle"></i></div><div><div class="stat-value">${completedTrips}</div><div class="stat-label">Completed Trips Today</div></div></div></div>
</div>
<div class="card shadow-sm">
    <div class="card-header bg-white"><i class="bi bi-list-check"></i> Today's Departures</div>
    <div class="card-body pt-2">
        <ul class="dash-todo-list">${raw(tripsHtml || '<li class="text-muted small py-2">No ferry trips scheduled for today.</li>')}</ul>
    </div>
</div>`;
}

function manifestActionButtons({ booking, csrfToken, date, scheduleId, canAssignHodSeats }) {
    const status = booking.booking_status.status_name;
    const form = (action, label, btnClass, confirmMsg) => `
        <form method="post" class="d-inline"${confirmMsg ? ` data-confirm="${h(confirmMsg)}"` : ''}>
            ${csrfField(csrfToken)}<input type="hidden" name="action" value="${action}"><input type="hidden" name="booking_id" value="${booking.booking_id}">
            <input type="hidden" name="date" value="${date}"><input type="hidden" name="schedule_id" value="${scheduleId}">
            <button class="btn btn-sm ${btnClass}">${label}</button>
        </form>`;

    let base = '';
    if (status === 'Approved') {
        base = form('check_in', 'Check-In', 'btn-outline-primary') + form('no_show', 'No Show', 'btn-outline-danger', 'Mark this passenger as a no-show? Their seat will be released.');
    } else if (status === 'Checked-In') {
        base = form('departed', 'Mark Departed', 'btn-outline-success') + form('no_show', 'No Show', 'btn-outline-danger', 'Mark this passenger as a no-show? Their seat will be released.');
    } else if (status === 'Departed') {
        base = form('arrived', 'Mark Arrived', 'btn-outline-info');
    }

    // Reassign/Release are only for HOD-assigned bookings, only before
    // departure, and only for users who hold the narrower assignment
    // permission (layered on top of the page's own manifest permission).
    let hodExtra = '';
    if (canAssignHodSeats && booking.booking_method === 'hod_seat_assignment' && ['Approved', 'Checked-In'].includes(status)) {
        hodExtra =
            `<button type="button" class="btn btn-sm btn-outline-warning" data-bs-toggle="modal" data-bs-target="#hodModal${booking.source_reservation_id}" data-reassign-booking-id="${booking.booking_id}">Reassign</button>` +
            form('release_hod_seat', 'Release', 'btn-outline-secondary', 'Release this reserved seat? The employee will be removed from this booking and the seat will become available for another employee.');
    }

    const combined = base + hodExtra;
    return combined ? raw(combined) : raw('<span class="text-muted small">-</span>');
}

/** Assign/Reassign modal for one HOD reservation - shared between the "Assign" button (HOD Reserved Seats card) and each manifest row's "Reassign" button. */
function hodSeatModalHtml({ reservation, candidates, csrfToken, date, scheduleId }) {
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

    return `<div class="modal fade" id="hodModal${reservation.reservationId}" tabindex="-1"><div class="modal-dialog"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}
    <input type="hidden" name="action" value="assign_hod_seat" class="hod-action-field">
    <input type="hidden" name="booking_id" value="" class="hod-booking-id-field">
    <input type="hidden" name="reservation_id" value="${reservation.reservationId}">
    <input type="hidden" name="schedule_id" value="${scheduleId}">
    <input type="hidden" name="date" value="${date}">
    <div class="modal-header"><h5 class="modal-title hod-modal-title"><i class="bi bi-person-plus"></i> Assign Employee - ${h(reservation.departmentName)}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="mb-2"><input type="text" class="form-control hod-search-input" placeholder="Search Employee ID or Name"></div>
        <select name="employee_user_id" size="8" class="form-select hod-candidate-select" required>${optionsHtml}</select>
        <div class="mb-0 mt-2"><label class="form-label">Remarks (optional)</label><textarea name="remarks" class="form-control" rows="2"></textarea></div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Confirm</button></div>
</form></div></div>`;
}

/** Filters options by search text and, on Reassign, swaps the form to reassign mode - no AJAX, matches this codebase's existing no-typeahead search pattern. */
const HOD_MODAL_SCRIPT = `
(function () {
    document.querySelectorAll('.modal[id^="hodModal"]').forEach(function (modal) {
        var searchInput = modal.querySelector('.hod-search-input');
        var select = modal.querySelector('.hod-candidate-select');
        var actionField = modal.querySelector('.hod-action-field');
        var bookingIdField = modal.querySelector('.hod-booking-id-field');
        var titleEl = modal.querySelector('.hod-modal-title');
        if (searchInput && select) {
            searchInput.addEventListener('input', function () {
                var needle = searchInput.value.toLowerCase();
                Array.prototype.forEach.call(select.options, function (opt) {
                    opt.hidden = needle && opt.dataset.search.indexOf(needle) === -1;
                });
            });
        }
        modal.addEventListener('show.bs.modal', function (e) {
            var trigger = e.relatedTarget;
            var reassignBookingId = trigger ? trigger.getAttribute('data-reassign-booking-id') : null;
            if (reassignBookingId) {
                actionField.value = 'reassign_hod_seat';
                bookingIdField.value = reassignBookingId;
                if (titleEl) titleEl.innerHTML = '<i class="bi bi-arrow-repeat"></i> Reassign Reserved Seat';
            } else {
                actionField.value = 'assign_hod_seat';
                bookingIdField.value = '';
                if (titleEl) titleEl.innerHTML = '<i class="bi bi-person-plus"></i> Assign Employee';
            }
        });
    });
})();`;

async function manifestPageBody({ date, scheduleId, schedules, resortFilter, csrfToken, canAssignHodSeats }) {
    let manifest = scheduleId ? await manifestFor(scheduleId, date) : [];
    if (resortFilter) manifest = manifest.filter((p) => p.users.resort_id === resortFilter);
    const resorts = await getActiveResorts();
    const scheduleOptions = schedules
        .map((s) => `<option value="${s.schedule_id}" ${scheduleId === s.schedule_id ? 'selected' : ''}>${h(s.ferry_routes.direction)} - ${h(formatTime(s.departure_time))}</option>`)
        .join('');
    const resortOptions = resorts.map((r) => `<option value="${r.resort_id}" ${resortFilter === r.resort_id ? 'selected' : ''}>${h(r.resort_name)}</option>`).join('');

    const hodReservations = scheduleId && canAssignHodSeats ? await getHodReservationsForScheduleDate(scheduleId, date) : [];
    const hodCandidatesByReservation = new Map();
    if (hodReservations.length) {
        await Promise.all(
            hodReservations.map(async (r) => {
                hodCandidatesByReservation.set(r.reservationId, await searchHodSeatCandidates({ reservationId: r.reservationId, travelDate: date, needle: '' }));
            })
        );
    }
    // Needed for the Set/Change-department forms and the Add
    // Reservation form below - fetched once per page render whenever
    // Security can act on HOD seats at all, not just when a reservation
    // happens to need it, since Add Reservation is always offered.
    const allDepartmentOptions =
        scheduleId && canAssignHodSeats
            ? (await getActiveDepartments()).map((d) => `<option value="${d.department_id}">${h(d.department_name)}</option>`).join('')
            : '';
    const allResortOptions = resorts.map((r) => `<option value="${r.resort_id}">${h(r.resort_name)}</option>`).join('');

    // Security creating a new HOD reservation directly (resort +
    // department + seat count, scoped to this exact schedule/date) is a
    // deliberate exception to "Security cannot create reserved seat
    // allocations", confirmed explicitly with the user - offered
    // whether or not any reservations already exist for this
    // schedule/date. Resort is tracked per-reservation (metadata, same
    // as the admin Seat Reservations form) since HOD seats are held per
    // resort even though a single ferry schedule can carry passengers
    // from either.
    const addReservationFormHtml =
        scheduleId && canAssignHodSeats
            ? `<form method="post" class="d-flex flex-wrap gap-2 align-items-end p-3 border-top">
                ${csrfField(csrfToken)}<input type="hidden" name="action" value="create_hod_reservation"><input type="hidden" name="date" value="${date}"><input type="hidden" name="schedule_id" value="${scheduleId}">
                <div><label class="form-label small mb-0">Resort</label><select name="resort_id" class="form-select form-select-sm" required><option value="">-- Choose --</option>${allResortOptions}</select></div>
                <div><label class="form-label small mb-0">Department</label><select name="department_id" class="form-select form-select-sm" required><option value="">-- Choose --</option>${allDepartmentOptions}</select></div>
                <div><label class="form-label small mb-0">Seats</label><input type="number" name="seats" class="form-control form-control-sm" min="1" value="1" style="width:80px" required></div>
                <button class="btn btn-sm btn-primary"><i class="bi bi-plus-lg"></i> Add Reservation</button>
            </form>`
            : '';

    const hodCardHtml =
        scheduleId && canAssignHodSeats
            ? html`<div class="card shadow-sm mb-3">
            <div class="card-header bg-white"><i class="bi bi-bookmark-star"></i> HOD Reserved Seats</div>
            ${hodReservations.length
                ? html`<div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
                <thead><tr><th>Resort</th><th>Department</th><th>Reserved</th><th>Assigned</th><th>Available</th><th>Currently Assigned</th><th>Actions</th></tr></thead>
                <tbody>${raw(
                    hodReservations
                        .map((r) => {
                            // Each assigned employee gets its own Reassign/Release
                            // inline, reusing the exact same shared modal/actions as
                            // the manifest table below - reachable from either place.
                            const assignedHtml = r.assignments.length
                                ? r.assignments
                                      .map((a) => {
                                          const canManage = ['Approved', 'Checked-In'].includes(a.statusName);
                                          const actions = canManage
                                              ? ` <button type="button" class="btn btn-sm btn-outline-warning py-0" data-bs-toggle="modal" data-bs-target="#hodModal${r.reservationId}" data-reassign-booking-id="${a.bookingId}">Reassign</button>` +
                                                `<form method="post" class="d-inline" data-confirm="Release this reserved seat? ${h(a.fullName)} will be removed from this booking.">${csrfField(csrfToken)}<input type="hidden" name="action" value="release_hod_seat"><input type="hidden" name="booking_id" value="${a.bookingId}"><input type="hidden" name="date" value="${date}"><input type="hidden" name="schedule_id" value="${scheduleId}"><button class="btn btn-sm btn-outline-secondary py-0">Release</button></form>`
                                              : '';
                                          return `<div class="mb-1">${h(a.fullName)} (${h(a.employeeId)}) - ${h(a.statusName)}${actions}</div>`;
                                      })
                                      .join('')
                                : '<span class="text-muted">None</span>';
                            // A reservation created without a department set (the
                            // create form's Department field allows "-- None --"
                            // for department/hod types) has no candidate pool to
                            // assign from - let Security fix it inline rather than
                            // needing an Admin/HR round-trip through Seat Reservations.
                            // Once a department IS set, it can still be corrected
                            // (e.g. the wrong one was picked) as long as no one is
                            // assigned yet - it locks again once someone is.
                            const deptForm = (label) =>
                                `<form method="post" class="d-flex gap-1">${csrfField(csrfToken)}<input type="hidden" name="action" value="set_hod_department"><input type="hidden" name="reservation_id" value="${r.reservationId}"><input type="hidden" name="date" value="${date}"><input type="hidden" name="schedule_id" value="${scheduleId}">
                                        <select name="department_id" class="form-select form-select-sm" required><option value="">-- ${h(label)} --</option>${allDepartmentOptions}</select>
                                        <button class="btn btn-sm btn-outline-primary">Save</button>
                                    </form>`;
                            const departmentCell =
                                r.departmentId == null
                                    ? deptForm('Set department')
                                    : r.seatsAssigned === 0
                                      ? `<div>${h(r.departmentName)}
                                        <a href="#" class="small ms-1" onclick="document.getElementById('changeDept${r.reservationId}').classList.toggle('d-none'); return false;">Change</a>
                                        <div id="changeDept${r.reservationId}" class="d-none mt-1">${deptForm('Change department')}</div>
                                    </div>`
                                      : h(r.departmentName);
                            const assignBtn =
                                r.departmentId == null
                                    ? '<span class="text-muted small">Set department first</span>'
                                    : r.seatsAvailable > 0
                                      ? `<button type="button" class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#hodModal${r.reservationId}">Assign</button>`
                                      : '<span class="text-muted small">Full</span>';
                            return `<tr>
                            <td>${h(r.resortName)}</td>
                            <td>${departmentCell}${r.contactName ? `<br><small class="text-muted">${h(r.contactName)}</small>` : ''}</td>
                            <td>${r.seatsTotal}</td><td>${r.seatsAssigned}</td><td>${r.seatsAvailable}</td>
                            <td>${assignedHtml}</td>
                            <td>${assignBtn}</td>
                        </tr>`;
                        })
                        .join('')
                )}</tbody>
            </table></div>`
                : html`<div class="p-3 text-muted small">No reserved seats for this schedule/date yet.</div>`}
            ${raw(addReservationFormHtml)}
        </div>`
            : '';

    const hodModalsHtml = hodReservations
        .filter((r) => r.departmentId != null)
        .map((r) => hodSeatModalHtml({ reservation: r, candidates: hodCandidatesByReservation.get(r.reservationId) ?? [], csrfToken, date, scheduleId }))
        .join('');

    const rowsHtml = manifest
        .map(
            (p) => html`<tr>
            <td>${p.users.employee_id}</td>
            <td>${p.users.full_name}</td>
            <td>${p.users.departments?.department_name ?? '-'}</td>
            <td>${p.users.designation ?? '-'}</td>
            <td>${p.users.resorts?.resort_name ?? '-'}</td>
            <td>BK-${p.booking_id}</td>
            <td>${p.seats}</td>
            <td>${p.departed_at ? formatDateTime(p.departed_at) : '-'}</td>
            <td>${p.arrived_at ? formatDateTime(p.arrived_at) : '-'}</td>
            <td><span class="badge ${statusBadgeClass(p.booking_status.badge_color)}">${p.booking_status.status_name}</span></td>
            <td class="text-nowrap">${manifestActionButtons({ booking: p, csrfToken, date, scheduleId, canAssignHodSeats })}</td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-clipboard-check"></i> Passenger Manifest</h5>
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-3"><label class="form-label">Date</label><input type="date" name="date" class="form-control" value="${date}"></div>
        <div class="col-md-4"><label class="form-label">Ferry Schedule</label><select name="schedule_id" class="form-select"><option value="0">-- Select Departure --</option>${raw(scheduleOptions)}</select></div>
        <div class="col-md-3"><label class="form-label">Resort</label><select name="resort" class="form-select"><option value="0">All Resorts</option>${raw(resortOptions)}</select></div>
        <div class="col-md-2 d-flex align-items-end"><button class="btn btn-outline-primary btn-sm w-100" type="submit">View</button></div>
    </form>
</div></div>
${raw(hodCardHtml)}
${scheduleId
    ? html`<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
        <thead><tr><th>Employee ID</th><th>Name</th><th>Department</th><th>Designation</th><th>Resort</th><th>Booking Ref</th><th>Seats</th><th>Departed</th><th>Arrived</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${raw(rowsHtml || '<tr><td colspan="11" class="text-center text-muted py-4">No passengers on this manifest.</td></tr>')}</tbody>
    </table></div></div>`
    : ''}
${raw(hodModalsHtml)}
${hodReservations.length ? html`<script>${raw(HOD_MODAL_SCRIPT)}</script>` : ''}`;
}

async function waitingListPageBody({ date, scheduleId, schedules, resortFilter, csrfToken, canOverrideFifo }) {
    let waitingList = scheduleId ? await getWaitingList(scheduleId, date) : [];
    if (resortFilter) waitingList = waitingList.filter((b) => b.users.resort_id === resortFilter);
    const resorts = await getActiveResorts();
    const scheduleOptions = schedules
        .map((s) => `<option value="${s.schedule_id}" ${scheduleId === s.schedule_id ? 'selected' : ''}>${h(s.ferry_routes.direction)} - ${h(formatTime(s.departure_time))}</option>`)
        .join('');
    const resortOptions = resorts.map((r) => `<option value="${r.resort_id}" ${resortFilter === r.resort_id ? 'selected' : ''}>${h(r.resort_name)}</option>`).join('');

    const rowsHtml = waitingList
        .map(
            (b, i) => html`<tr>
            <td>${i + 1}</td>
            <td>${b.users.employee_id}</td>
            <td>${b.users.full_name}</td>
            <td>${b.users.departments?.department_name ?? '-'}</td>
            <td>${b.users.resorts?.resort_name ?? '-'}</td>
            <td>${b.seats}</td>
            <td>${formatDateTime(b.created_at)}</td>
            <td class="text-nowrap">
                ${canOverrideFifo
                    ? html`<form method="post" class="d-inline"><input type="hidden" name="csrf_token" value="${csrfToken}"><input type="hidden" name="action" value="promote_specific"><input type="hidden" name="booking_id" value="${b.booking_id}"><input type="hidden" name="schedule_id" value="${scheduleId}"><input type="hidden" name="date" value="${date}"><button class="btn btn-sm btn-outline-primary">Promote This Passenger</button></form>`
                    : ''}
            </td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-hourglass-split"></i> Waiting List</h5>
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-3"><label class="form-label">Date</label><input type="date" name="date" class="form-control" value="${date}"></div>
        <div class="col-md-4"><label class="form-label">Ferry Schedule</label><select name="schedule_id" class="form-select"><option value="0">-- Select Departure --</option>${raw(scheduleOptions)}</select></div>
        <div class="col-md-3"><label class="form-label">Resort</label><select name="resort" class="form-select"><option value="0">All Resorts</option>${raw(resortOptions)}</select></div>
        <div class="col-md-2 d-flex align-items-end"><button class="btn btn-outline-primary btn-sm w-100" type="submit">View</button></div>
    </form>
</div></div>
${scheduleId
    ? html`<div class="card shadow-sm">
        <div class="card-header bg-white d-flex justify-content-between">
            <span>${waitingList.length} passenger(s) waiting (First In, First Out order)</span>
            ${waitingList.length
                ? html`<form method="post" class="d-inline">${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="promote_next"><input type="hidden" name="schedule_id" value="${scheduleId}"><input type="hidden" name="date" value="${date}">
                    <button class="btn btn-sm btn-success">Promote Next Passenger</button></form>`
                : ''}
        </div>
        <div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
            <thead><tr><th>#</th><th>Employee ID</th><th>Name</th><th>Department</th><th>Resort</th><th>Seats</th><th>Waiting Since</th><th>Actions</th></tr></thead>
            <tbody>${raw(rowsHtml || '<tr><td colspan="8" class="text-center text-muted py-4">No one is currently waiting for this departure.</td></tr>')}</tbody>
        </table></div>
    </div>`
    : ''}`;
}

export function registerSecurityRoutes(router) {
    router.get('/security/dashboard', async (request) => {
        const auth = await requirePermission(request, 'dashboard.view_security', { pageTitle: 'Security Dashboard' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const search = url.searchParams.get('search') || '';
        const body = await securityDashboardBody({ fullName: auth.user.full_name, search });
        return renderShellForRequest({ request, auth, pageTitle: 'Security Dashboard', path: '/security/dashboard', bodyHtml: body });
    });

    router.get('/security/manifest', async (request) => {
        const auth = await requirePermission(request, 'security.manage_manifest', { pageTitle: 'Passenger Manifest' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const scheduleId = Number(url.searchParams.get('schedule_id') || 0);
        const resortFilter = Number(url.searchParams.get('resort') || 0);
        const schedules = await activeSchedulesForDate(date);
        const canAssignHodSeats = hasPermission(auth.user.perms, 'security.assign_hod_seats');
        const body = await manifestPageBody({ date, scheduleId, schedules, resortFilter, csrfToken: auth.user.csrf, canAssignHodSeats });
        return renderShellForRequest({ request, auth, pageTitle: 'Passenger Manifest', path: '/security/manifest', bodyHtml: body });
    });

    router.post('/security/manifest', async (request) => {
        const auth = await requirePermission(request, 'security.manage_manifest', { pageTitle: 'Passenger Manifest' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const action = form.action;
        const backTo = `/security/manifest?date=${form.date || ''}&schedule_id=${form.schedule_id || ''}`;

        if (action === 'set_hod_department') {
            if (!hasPermission(user.perms, 'security.assign_hod_seats')) return notFound();
            const result = await setHodReservationDepartment({
                reservationId: Number(form.reservation_id),
                departmentId: Number(form.department_id) || 0,
                setByUserId: user.user_id,
            });
            await logActivity(user.user_id, 'Security: set_hod_department', `reservation_id=${form.reservation_id || ''} department_id=${form.department_id || ''}`, clientIp(request));
            return redirectTo(backTo, {
                cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? HOD_ACTION_SUCCESS[action] : HOD_ACTION_ERROR[result.reason] || 'Could not complete this action.')].filter(Boolean),
            });
        }

        if (action === 'create_hod_reservation') {
            if (!hasPermission(user.perms, 'security.assign_hod_seats')) return notFound();
            const result = await createHodReservation({
                scheduleId: Number(form.schedule_id),
                travelDate: form.date,
                departmentId: Number(form.department_id) || 0,
                resortId: Number(form.resort_id) || 0,
                seats: Number(form.seats),
                createdByUserId: user.user_id,
            });
            await logActivity(user.user_id, 'Security: create_hod_reservation', `schedule_id=${form.schedule_id || ''} department_id=${form.department_id || ''} seats=${form.seats || ''}`, clientIp(request));
            return redirectTo(backTo, {
                cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? HOD_ACTION_SUCCESS[action] : HOD_ACTION_ERROR[result.reason] || 'Could not complete this action.')].filter(Boolean),
            });
        }

        if (['assign_hod_seat', 'reassign_hod_seat', 'release_hod_seat'].includes(action)) {
            if (!hasPermission(user.perms, 'security.assign_hod_seats')) return notFound();
            const remarks = (form.remarks || '').trim() || null;
            let result;
            if (action === 'assign_hod_seat') {
                result = await assignEmployeeToHodSeat({
                    reservationId: Number(form.reservation_id),
                    travelDate: form.date,
                    employeeUserId: Number(form.employee_user_id),
                    assignedByUserId: user.user_id,
                    remarks,
                });
            } else if (action === 'reassign_hod_seat') {
                result = await reassignEmployeeToHodSeat({
                    bookingId: Number(form.booking_id),
                    newEmployeeUserId: Number(form.employee_user_id),
                    assignedByUserId: user.user_id,
                    remarks,
                });
            } else {
                result = await releaseHodSeatAssignment({ bookingId: Number(form.booking_id), releasedByUserId: user.user_id, remarks });
            }
            await logActivity(user.user_id, `Security: ${action}`, `reservation_id=${form.reservation_id || ''} booking_id=${form.booking_id || ''}`, clientIp(request));
            return redirectTo(backTo, {
                cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? HOD_ACTION_SUCCESS[action] : HOD_ACTION_ERROR[result.reason] || 'Could not complete this action.')].filter(Boolean),
            });
        }

        const bookingId = Number(form.booking_id);
        if (!['check_in', 'departed', 'no_show', 'arrived'].includes(action)) {
            return redirectTo('/security/dashboard', { cookies: [auth.setCookie] });
        }

        await recordMovement(bookingId, action, { officerId: user.user_id, remarks: (form.remarks || '').trim() || null });
        await logActivity(user.user_id, `Security: ${action}`, `booking_id=${bookingId}`, clientIp(request));

        return redirectTo(backTo, {
            cookies: [auth.setCookie, flashSetCookie('success', 'Passenger status updated.')].filter(Boolean),
        });
    });

    router.get('/security/waiting_list', async (request) => {
        const auth = await requirePermission(request, 'security.manage_waiting_list', { pageTitle: 'Waiting List' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const scheduleId = Number(url.searchParams.get('schedule_id') || 0);
        const resortFilter = Number(url.searchParams.get('resort') || 0);
        const schedules = await activeSchedulesForDate(date);
        const canOverrideFifo = [ROLE_ADMIN, ROLE_HR].includes(auth.user.role_name);
        const body = await waitingListPageBody({ date, scheduleId, schedules, resortFilter, csrfToken: auth.user.csrf, canOverrideFifo });
        return renderShellForRequest({ request, auth, pageTitle: 'Waiting List', path: '/security/waiting_list', bodyHtml: body });
    });

    router.post('/security/waiting_list', async (request) => {
        const auth = await requirePermission(request, 'security.manage_waiting_list', { pageTitle: 'Waiting List' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const scheduleId = Number(form.schedule_id);
        const date = form.date;

        if (form.action === 'promote_next') {
            const waitingList = await getWaitingList(scheduleId, date);
            if (!waitingList.length) {
                return redirectTo(`/security/waiting_list?date=${date}&schedule_id=${scheduleId}`, {
                    cookies: [auth.setCookie, flashSetCookie('error', 'No one is waiting for this departure.')].filter(Boolean),
                });
            }
            const result = await promoteWaitingListBooking(waitingList[0].booking_id, { promotedByUserId: user.user_id, method: 'automatic' });
            await logActivity(user.user_id, 'Security: promoted next waiting-list passenger', `booking_id=${waitingList[0].booking_id}`, clientIp(request));
            return redirectTo(`/security/waiting_list?date=${date}&schedule_id=${scheduleId}`, {
                cookies: [auth.setCookie, flashSetCookie(result.promoted ? 'success' : 'error', result.promoted ? 'Passenger promoted to Approved.' : 'Could not promote - no seat currently available.')].filter(Boolean),
            });
        }

        if (form.action === 'promote_specific') {
            if (![ROLE_ADMIN, ROLE_HR].includes(user.role_name)) return notFound();
            const bookingId = Number(form.booking_id);
            const result = await promoteWaitingListBooking(bookingId, {
                promotedByUserId: user.user_id,
                method: 'manual',
                reason: 'Administrator/HR override of FIFO order',
            });
            await logActivity(user.user_id, 'Security: manually promoted waiting-list passenger (FIFO override)', `booking_id=${bookingId}`, clientIp(request));
            return redirectTo(`/security/waiting_list?date=${date}&schedule_id=${scheduleId}`, {
                cookies: [auth.setCookie, flashSetCookie(result.promoted ? 'success' : 'error', result.promoted ? 'Passenger promoted to Approved.' : 'Could not promote - no seat currently available.')].filter(Boolean),
            });
        }

        return redirectTo(`/security/waiting_list?date=${date}&schedule_id=${scheduleId}`, { cookies: [auth.setCookie] });
    });
}
