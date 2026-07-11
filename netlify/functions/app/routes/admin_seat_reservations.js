// HR Seat Reservation Management: hold ferry seats out of general
// circulation for a specific employee, a department, VIP/Executive
// use, general operational buffer, or an emergency hold, over a date
// range - applies every day within that range (no per-weekday picker
// in the UI, per user request), though the underlying weekdays column
// still exists and is always stored as all 7 days, since
// reserved_seats_for_schedule_date() (0016_seat_reservations.sql)
// checks it. Capacity enforcement itself lives entirely in the
// redefined get_remaining_seats()/book_ferry_seat() Postgres functions -
// this file is purely CRUD + audit, mirroring admin_directions.js's/
// admin_bookings.js's established shape.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { formatTime } from '../format.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { getActiveResorts, getAllDepartments } from '../refData.js';
import { ROLE_ADMIN } from '../session.js';
import { logActivity, clientIp } from '../activity.js';
import { getRemainingSeats } from '../seats.js';

const WEEKDAY_OPTIONS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const RESERVATION_TYPES = [
    { value: 'employee_specific', label: 'Employee-Specific Reservation' },
    { value: 'department', label: 'Department Reservation' },
    { value: 'hod', label: 'HOD Reservation (Head of Department)' },
    { value: 'vip_executive', label: 'VIP / Executive Reservation' },
    { value: 'operational', label: 'Operational Reserve' },
    { value: 'emergency', label: 'Emergency Reserve' },
];
// Department and HOD reservations aren't tied to a specific users(user_id)
// row - both show the Department picker plus a free-text Name field for
// who within that department the reservation is actually held by/for.
const DEPARTMENT_SCOPED_TYPES = ['department', 'hod'];
// Unlike Department Reservations, an HOD Reservation is allowed to have
// no department at all - it's the resort-wide allocation the HOD
// Reserved Seat Request self-service feature (hodSeatAssignment.js)
// consumes from, which has no department dimension. Department stays
// required only for the plain 'department' type.
const DEPARTMENT_REQUIRED_TYPES = ['department'];

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

async function recordReservationAudit({ reservation, action, actorUserId, reason, seatsAvailableBefore = null, seatsAvailableAfter = null }) {
    unwrap(
        await db().from('seat_reservation_log').insert({
            reservation_id: reservation.reservation_id,
            schedule_id: reservation.schedule_id,
            direction: reservation.direction ?? null,
            resort_id: reservation.resort_id,
            reservation_type: reservation.reservation_type,
            employee_name_snapshot: reservation.employee_name_snapshot ?? null,
            department_name_snapshot: reservation.department_name_snapshot ?? null,
            contact_name_snapshot: reservation.contact_name ?? null,
            seats: reservation.seats,
            start_date: reservation.start_date,
            end_date: reservation.end_date,
            action,
            actor_user_id: actorUserId,
            reason,
            seats_available_before: seatsAvailableBefore,
            seats_available_after: seatsAvailableAfter,
        })
    );
}

async function reservationsPageBody({ statusFilter, resortFilter, csrfToken, isAdmin }) {
    let query = db()
        .from('seat_reservations')
        .select(
            'reservation_id, schedule_id, reservation_type, seats, start_date, end_date, weekdays, reason, status, resort_id, contact_name, ' +
                'employee:users!seat_reservations_employee_user_id_fkey(full_name, employee_id), department:departments(department_name), ' +
                'resorts(resort_name), ferry_schedule(departure_time, ferry_routes(route_name, direction))'
        )
        .order('start_date', { ascending: false })
        .limit(300);
    if (statusFilter) query = query.eq('status', statusFilter);
    if (resortFilter) query = query.eq('resort_id', resortFilter);

    // Independent of each other - fetched concurrently rather than
    // 5 round-trips in series.
    const [reservations, resorts, departments, activeUsers, schedules] = await Promise.all([
        query.then(unwrap),
        getActiveResorts(),
        getAllDepartments(),
        db().from('users').select('user_id, full_name, employee_id').eq('status', 'active').order('full_name').then(unwrap),
        db().from('ferry_schedule').select('schedule_id, departure_time, capacity, service_name, ferry_routes(route_name, direction)').eq('status', 'active').order('departure_time').then(unwrap),
    ]);

    const typeLabel = (v) => RESERVATION_TYPES.find((t) => t.value === v)?.label ?? v;

    const rowsHtml = reservations
        .map((r) => {
            const who = r.employee ? `${r.employee.full_name} (${r.employee.employee_id})` : r.department ? r.department.department_name : '-';
            const statusBadge = { active: 'bg-success', released: 'bg-secondary', expired: 'bg-dark', cancelled: 'bg-danger' }[r.status] || 'bg-secondary';
            return html`<tr>
            <td>${r.ferry_schedule?.ferry_routes?.route_name ?? '-'} <small class="text-muted">${r.ferry_schedule?.ferry_routes?.direction ?? ''} ${r.ferry_schedule ? formatTime(r.ferry_schedule.departure_time) : ''}</small></td>
            <td>${r.resorts?.resort_name ?? '-'}</td>
            <td>${typeLabel(r.reservation_type)}</td>
            <td>${who}</td>
            <td>${r.contact_name ?? ''}</td>
            <td>${r.seats}</td>
            <td>${r.start_date} &rarr; ${r.end_date}</td>
            <td><span class="badge ${statusBadge}">${r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span></td>
            <td class="text-nowrap">
                ${r.status === 'active'
                    ? html`<button type="button" class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#editReservationModal${r.reservation_id}"><i class="bi bi-pencil"></i></button>
                    <form method="post" class="d-inline" data-confirm="Release these reserved seats back to general availability?">
                        ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="release"><input type="hidden" name="reservation_id" value="${r.reservation_id}">
                        <button class="btn btn-sm btn-outline-secondary"><i class="bi bi-unlock"></i> Release</button>
                    </form>
                    <form method="post" class="d-inline" data-confirm="Cancel this reservation?">
                        ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="cancel"><input type="hidden" name="reservation_id" value="${r.reservation_id}">
                        <button class="btn btn-sm btn-outline-danger"><i class="bi bi-x-circle"></i></button>
                    </form>`
                    : isAdmin
                      ? html`<form method="post" class="d-inline" data-confirm="Permanently delete this reservation? This cannot be undone (its audit log entry is kept).">
                        ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="delete"><input type="hidden" name="reservation_id" value="${r.reservation_id}">
                        <button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i> Delete</button>
                    </form>`
                      : ''}
            </td>
        </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    // Edit modals are generated as a SEPARATE string from the <tr> rows
    // above and concatenated only after </table> closes - a modal <div>
    // can never be a direct child of <tbody> (the browser "foster-parents"
    // it out, scrambling the DOM - the same bug class fixed earlier this
    // session in admin.js).
    const editModalsHtml = reservations
        .filter((r) => r.status === 'active')
        .map((r) => {
            return `<div class="modal fade" id="editReservationModal${r.reservation_id}" tabindex="-1"><div class="modal-dialog"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="edit"><input type="hidden" name="reservation_id" value="${r.reservation_id}">
    <div class="modal-header"><h5 class="modal-title">Edit Reservation</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="mb-3"><label class="form-label">Seats</label><input type="number" name="seats" class="form-control" min="1" value="${r.seats}" required></div>
        ${DEPARTMENT_SCOPED_TYPES.includes(r.reservation_type)
            ? `<div class="mb-3"><label class="form-label">Name</label><input type="text" name="contact_name" class="form-control" value="${h(r.contact_name || '')}"></div>`
            : ''}
        <div class="row g-2 mb-3">
            <div class="col-6"><label class="form-label">Start Date</label><input type="date" name="start_date" class="form-control" value="${r.start_date}" required></div>
            <div class="col-6"><label class="form-label">End Date</label><input type="date" name="end_date" class="form-control" value="${r.end_date}" required></div>
        </div>
        <div class="mb-3"><label class="form-label">Reason</label><textarea name="reason" class="form-control" rows="2" required>${h(r.reason)}</textarea></div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div>
</form></div></div>`;
        })
        .join('');

    const employeeOptionsHtml = activeUsers.map((u) => `<option value="${u.user_id}">${h(u.full_name)} (${h(u.employee_id)})</option>`).join('');
    const departmentOptionsHtml = departments.map((d) => `<option value="${d.department_id}">${h(d.department_name)}</option>`).join('');
    const resortOptionsHtml = resorts.map((r) => `<option value="${r.resort_id}">${h(r.resort_name)}</option>`).join('');
    const scheduleOptionsHtml = schedules
        .map((s) => `<option value="${s.schedule_id}">${h(s.ferry_routes?.route_name ?? s.service_name ?? '-')} - ${h(s.ferry_routes?.direction ?? '')} - ${h(formatTime(s.departure_time))}</option>`)
        .join('');

    const createModalHtml = `<div class="modal fade" id="createReservationModal" tabindex="-1"><div class="modal-dialog modal-lg"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="create">
    <div class="modal-header"><h5 class="modal-title"><i class="bi bi-bookmark-plus"></i> New Seat Reservation</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="row g-3">
            <div class="col-md-6"><label class="form-label">Reservation Type</label><select name="reservation_type" id="resTypeSelect" class="form-select" required>
                ${RESERVATION_TYPES.map((t) => `<option value="${t.value}">${h(t.label)}</option>`).join('')}
            </select></div>
            <div class="col-md-6"><label class="form-label">Resort</label><select name="resort_id" class="form-select" required>${resortOptionsHtml}</select></div>
            <div class="col-md-12" id="resEmployeeField"><label class="form-label">Employee</label><select name="employee_user_id" class="form-select">
                <option value="">-- None --</option>${employeeOptionsHtml}
            </select></div>
            <div class="col-md-12" id="resDepartmentField" style="display:none"><label class="form-label">Department</label><select name="department_id" class="form-select">
                <option value="">-- None --</option>${departmentOptionsHtml}
            </select></div>
            <div class="col-md-12" id="resNameField" style="display:none"><label class="form-label">Name</label><input type="text" name="contact_name" class="form-control" placeholder="Who within the department this reservation is held for"></div>
            <div class="col-md-8"><label class="form-label">Ferry Schedule</label><select name="schedule_id" class="form-select" required>${scheduleOptionsHtml}</select></div>
            <div class="col-md-4"><label class="form-label">Seats</label><input type="number" name="seats" class="form-control" min="1" value="1" required></div>
            <div class="col-md-6"><label class="form-label">Start Date</label><input type="date" name="start_date" class="form-control" required value="${new Date().toISOString().slice(0, 10)}"></div>
            <div class="col-md-6"><label class="form-label">End Date</label><input type="date" name="end_date" class="form-control" required value="${new Date().toISOString().slice(0, 10)}"></div>
            <div class="col-12"><label class="form-label">Reason for Reservation</label><textarea name="reason" class="form-control" rows="2" required></textarea></div>
        </div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Create Reservation</button></div>
</form></div></div>
<script>
(function () {
    var typeSelect = document.getElementById('resTypeSelect');
    var employeeField = document.getElementById('resEmployeeField');
    var departmentField = document.getElementById('resDepartmentField');
    var nameField = document.getElementById('resNameField');
    if (!typeSelect) return;
    var departmentScopedTypes = ['department', 'hod'];
    var departmentRequiredTypes = ['department'];
    var departmentSelect = departmentField.querySelector('select');
    function sync() {
        employeeField.style.display = typeSelect.value === 'employee_specific' ? '' : 'none';
        var isDepartmentScoped = departmentScopedTypes.indexOf(typeSelect.value) !== -1;
        departmentField.style.display = isDepartmentScoped ? '' : 'none';
        nameField.style.display = isDepartmentScoped ? '' : 'none';
        // Required only while shown AND actually mandatory for this type -
        // an HOD reservation may legitimately have no department (the
        // resort-wide allocation self-service draws from).
        departmentSelect.required = departmentRequiredTypes.indexOf(typeSelect.value) !== -1;
    }
    typeSelect.addEventListener('change', sync);
    sync();
})();
</script>`;

    // Administrator-only multi-ferry bulk reservation - a separate modal
    // from createModalHtml above (which HR Manager also uses for a
    // single schedule) rather than reworking that one, since this
    // feature's access is explicitly narrower (System Administrator
    // only) than booking.manage_seat_reservations. Applies the same
    // reservation (type/resort/seats/date range/weekdays/reason) as one
    // seat_reservations row per selected schedule.
    const bulkScheduleCheckboxesHtml = schedules
        .map(
            (s) =>
                `<div class="form-check"><input class="form-check-input bulk-schedule-checkbox" type="checkbox" name="schedule_ids" value="${s.schedule_id}" id="bulkSched${s.schedule_id}"><label class="form-check-label" for="bulkSched${s.schedule_id}">${h(s.ferry_routes?.route_name ?? s.service_name ?? '-')} - ${h(s.ferry_routes?.direction ?? '')} - ${h(formatTime(s.departure_time))} <span class="text-muted small">(capacity ${s.capacity})</span></label></div>`
        )
        .join('');
    const bulkWeekdayCheckboxesHtml = WEEKDAY_OPTIONS.map(
        (day) => `<div class="form-check form-check-inline"><input class="form-check-input" type="checkbox" name="weekdays" value="${day}" id="bulkWd${day}" checked><label class="form-check-label" for="bulkWd${day}">${day}</label></div>`
    ).join('');
    const bulkResortOptionsHtml =
        resorts.map((r) => `<option value="${r.resort_id}">${h(r.resort_name)}</option>`).join('') + `<option value="both">Both Resorts</option>`;

    const bulkReservationModalHtml = `<div class="modal fade" id="bulkReservationModal" tabindex="-1"><div class="modal-dialog modal-lg"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="bulk_create">
    <div class="modal-header"><h5 class="modal-title"><i class="bi bi-collection"></i> Multi-Ferry Seat Reservation</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="row g-3">
            <div class="col-md-6"><label class="form-label">Reservation Type</label><select name="reservation_type" id="bulkResTypeSelect" class="form-select" required>
                ${RESERVATION_TYPES.map((t) => `<option value="${t.value}">${h(t.label)}</option>`).join('')}
            </select></div>
            <div class="col-md-6"><label class="form-label">Resort</label><select name="resort_option" class="form-select" required>${bulkResortOptionsHtml}</select></div>
            <div class="col-md-12" id="bulkEmployeeField"><label class="form-label">Employee</label><select name="employee_user_id" class="form-select">
                <option value="">-- None --</option>${employeeOptionsHtml}
            </select></div>
            <div class="col-md-12" id="bulkDepartmentField" style="display:none"><label class="form-label">Department</label><select name="department_id" class="form-select">
                <option value="">-- None --</option>${departmentOptionsHtml}
            </select></div>
            <div class="col-md-12" id="bulkNameField" style="display:none"><label class="form-label">Name</label><input type="text" name="contact_name" class="form-control" placeholder="Who within the department this reservation is held for"></div>
            <div class="col-12">
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <label class="form-label mb-0">Ferry Schedules</label>
                    <div><button type="button" class="btn btn-sm btn-link p-0 me-2" id="bulkSelectAllBtn">Select All</button><button type="button" class="btn btn-sm btn-link p-0" id="bulkSelectNoneBtn">Select None</button></div>
                </div>
                <div class="border rounded p-2" style="max-height:180px; overflow-y:auto;">${bulkScheduleCheckboxesHtml || '<span class="text-muted small">No active ferry schedules.</span>'}</div>
            </div>
            <div class="col-md-4"><label class="form-label">Seats (per schedule)</label><input type="number" name="seats" class="form-control" min="1" value="1" required></div>
            <div class="col-md-4"><label class="form-label">Start Date</label><input type="date" name="start_date" class="form-control" required value="${new Date().toISOString().slice(0, 10)}"></div>
            <div class="col-md-4"><label class="form-label">End Date</label><input type="date" name="end_date" class="form-control" required value="${new Date().toISOString().slice(0, 10)}"></div>
            <div class="col-12">
                <label class="form-label mb-1">Applies on these days of the week</label>
                <div class="d-flex flex-wrap gap-2">${bulkWeekdayCheckboxesHtml}</div>
                <div class="form-text">Check all 7 for a daily reservation, or only specific days for a weekly/custom recurring one over the date range above. True calendar-month recurrence (e.g. "the 1st of every month") isn't supported.</div>
            </div>
            <div class="col-12"><label class="form-label">Reason (optional)</label><textarea name="reason" class="form-control" rows="2"></textarea></div>
            <div class="col-12"><div class="alert alert-info small mb-0" id="bulkSummary">Select ferry schedules above to see a summary.</div></div>
        </div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Apply Reservation</button></div>
</form></div></div>
<script>
(function () {
    var modal = document.getElementById('bulkReservationModal');
    if (!modal) return;
    var typeSelect = modal.querySelector('#bulkResTypeSelect');
    var employeeField = modal.querySelector('#bulkEmployeeField');
    var departmentField = modal.querySelector('#bulkDepartmentField');
    var nameField = modal.querySelector('#bulkNameField');
    var departmentSelect = departmentField.querySelector('select');
    var departmentScopedTypes = ['department', 'hod'];
    var departmentRequiredTypes = ['department'];
    function syncType() {
        employeeField.style.display = typeSelect.value === 'employee_specific' ? '' : 'none';
        var isDepartmentScoped = departmentScopedTypes.indexOf(typeSelect.value) !== -1;
        departmentField.style.display = isDepartmentScoped ? '' : 'none';
        nameField.style.display = isDepartmentScoped ? '' : 'none';
        departmentSelect.required = departmentRequiredTypes.indexOf(typeSelect.value) !== -1;
    }
    typeSelect.addEventListener('change', syncType);
    syncType();

    var checkboxes = Array.prototype.slice.call(modal.querySelectorAll('.bulk-schedule-checkbox'));
    var resortSelect = modal.querySelector('select[name="resort_option"]');
    var seatsInput = modal.querySelector('input[name="seats"]');
    var startInput = modal.querySelector('input[name="start_date"]');
    var endInput = modal.querySelector('input[name="end_date"]');
    var summary = modal.querySelector('#bulkSummary');
    function summaryText() {
        var checkedCount = checkboxes.filter(function (c) { return c.checked; }).length;
        var seats = Number(seatsInput.value) || 0;
        var resortLabel = resortSelect.options[resortSelect.selectedIndex] ? resortSelect.options[resortSelect.selectedIndex].text : '';
        return checkedCount + ' ferry schedule(s) selected · ' + seats + ' seat(s) each · ' + resortLabel + ' · ' + startInput.value + ' to ' + endInput.value;
    }
    function updateSummary() { summary.textContent = summaryText(); }
    checkboxes.forEach(function (c) { c.addEventListener('change', updateSummary); });
    [resortSelect, seatsInput, startInput, endInput].forEach(function (el) {
        el.addEventListener('input', updateSummary);
        el.addEventListener('change', updateSummary);
    });
    updateSummary();

    var selectAllBtn = modal.querySelector('#bulkSelectAllBtn');
    var selectNoneBtn = modal.querySelector('#bulkSelectNoneBtn');
    if (selectAllBtn) selectAllBtn.addEventListener('click', function () { checkboxes.forEach(function (c) { c.checked = true; }); updateSummary(); });
    if (selectNoneBtn) selectNoneBtn.addEventListener('click', function () { checkboxes.forEach(function (c) { c.checked = false; }); updateSummary(); });

    modal.querySelector('form').addEventListener('submit', function (e) {
        var checkedCount = checkboxes.filter(function (c) { return c.checked; }).length;
        if (!checkedCount) {
            e.preventDefault();
            alert('Please select at least one ferry schedule.');
            return;
        }
        if (!confirm('Apply this reservation to ' + summaryText() + '?')) e.preventDefault();
    });
})();
</script>`;

    return html`
<div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="mb-0"><i class="bi bi-bookmark-star"></i> Seat Reservations</h5>
    <div>
        ${isAdmin ? raw(`<button class="btn btn-outline-primary me-2" data-bs-toggle="modal" data-bs-target="#bulkReservationModal"><i class="bi bi-collection"></i> Bulk Reservation</button>`) : ''}
        <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#createReservationModal"><i class="bi bi-plus-lg"></i> New Reservation</button>
    </div>
</div>
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-3"><select name="status" class="form-select">
            <option value="">All Status</option>
            <option value="active" ${statusFilter === 'active' ? 'selected' : ''}>Active</option>
            <option value="released" ${statusFilter === 'released' ? 'selected' : ''}>Released</option>
            <option value="expired" ${statusFilter === 'expired' ? 'selected' : ''}>Expired</option>
            <option value="cancelled" ${statusFilter === 'cancelled' ? 'selected' : ''}>Cancelled</option>
        </select></div>
        <div class="col-md-3"><select name="resort" class="form-select">
            <option value="0">All Resorts</option>
            ${raw(resorts.map((r) => `<option value="${r.resort_id}" ${resortFilter == r.resort_id ? 'selected' : ''}>${h(r.resort_name)}</option>`).join(''))}
        </select></div>
        <div class="col-12"><button class="btn btn-sm btn-outline-primary" type="submit"><i class="bi bi-search"></i> Filter</button> <a href="/admin/seat_reservations" class="btn btn-sm btn-outline-secondary">Reset</a></div>
    </form>
</div></div>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Schedule</th><th>Resort</th><th>Type</th><th>Employee / Department</th><th>Name</th><th>Seats</th><th>Period</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="9" class="text-center text-muted py-4">No seat reservations found.</td></tr>')}</tbody>
</table></div></div>
${raw(createModalHtml)}
${raw(editModalsHtml)}
${isAdmin ? raw(bulkReservationModalHtml) : ''}`;
}

export function registerAdminSeatReservationsRoutes(router) {
    router.get('/admin/seat_reservations', async (request) => {
        const auth = await requirePermission(request, 'booking.manage_seat_reservations', { pageTitle: 'Seat Reservations' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const body = await reservationsPageBody({
            statusFilter: url.searchParams.get('status') || '',
            resortFilter: Number(url.searchParams.get('resort') || 0),
            csrfToken: auth.user.csrf,
            isAdmin: auth.user.role_name === ROLE_ADMIN,
        });
        return renderShellForRequest({ request, auth, pageTitle: 'Seat Reservations', path: '/admin/seat_reservations', bodyHtml: body });
    });

    router.post('/admin/seat_reservations', async (request) => {
        const auth = await requirePermission(request, 'booking.manage_seat_reservations', { pageTitle: 'Seat Reservations' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        if (form.action === 'create') {
            const reservationType = form.reservation_type;
            if (!RESERVATION_TYPES.some((t) => t.value === reservationType)) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Invalid reservation type.')].filter(Boolean) });
            }
            const scheduleId = Number(form.schedule_id);
            const resortId = Number(form.resort_id) || null;
            const seats = Math.max(1, Number(form.seats));
            const startDate = form.start_date;
            const endDate = form.end_date;
            const reason = (form.reason || '').trim();
            // Every reservation applies to all 7 days of its date range -
            // no per-weekday restriction (removed per user request); still
            // stored as the full weekdays array since
            // reserved_seats_for_schedule_date() (0016_seat_reservations.sql)
            // checks it, so this keeps that function unchanged.
            const weekdays = WEEKDAY_OPTIONS;
            const employeeUserId = reservationType === 'employee_specific' && form.employee_user_id ? Number(form.employee_user_id) : null;
            const departmentId = DEPARTMENT_SCOPED_TYPES.includes(reservationType) && form.department_id ? Number(form.department_id) : null;
            const contactName = DEPARTMENT_SCOPED_TYPES.includes(reservationType) ? (form.contact_name || '').trim() || null : null;

            if (!scheduleId || !startDate || !endDate || !reason) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'All fields are required.')].filter(Boolean) });
            }
            if (endDate < startDate) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'End date must be on or after the start date.')].filter(Boolean) });
            }
            // A Department reservation with no department set can never be
            // assigned to anyone (Security's HOD seat assignment feature
            // scopes candidate search to this exact department) - the form
            // allows leaving it blank, so this must be enforced server-side.
            // An HOD reservation is exempt: leaving it blank is how you
            // create the resort-wide allocation the HOD Reserved Seat
            // Request self-service feature draws from.
            if (DEPARTMENT_REQUIRED_TYPES.includes(reservationType) && !departmentId) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Department is required for a Department reservation.')].filter(Boolean) });
            }

            // Prevent an exact duplicate HOD allocation for the same
            // resort+schedule+department, overlapping this date range -
            // distinct departments (or one department-less resort-wide
            // row plus several department-specific ones) are still fine
            // to coexist, only a literal re-creation of the same one is
            // blocked.
            if (reservationType === 'hod') {
                let dupQuery = db()
                    .from('seat_reservations')
                    .select('reservation_id')
                    .eq('reservation_type', 'hod')
                    .eq('status', 'active')
                    .eq('schedule_id', scheduleId)
                    .eq('resort_id', resortId)
                    .lte('start_date', endDate)
                    .gte('end_date', startDate);
                dupQuery = departmentId ? dupQuery.eq('department_id', departmentId) : dupQuery.is('department_id', null);
                const dup = unwrap(await dupQuery);
                if (dup.length) {
                    return redirectTo('/admin/seat_reservations', {
                        cookies: [auth.setCookie, flashSetCookie('error', 'An HOD Reserved Seat allocation already exists for this resort, schedule, department, and date range - edit the existing one instead.')].filter(Boolean),
                    });
                }
            }

            const scheduleRows = unwrap(await db().from('ferry_schedule').select('ferry_routes(direction)').eq('schedule_id', scheduleId).limit(1));
            const direction = scheduleRows[0]?.ferry_routes?.direction ?? null;

            let employeeName = null;
            if (employeeUserId) {
                const rows = unwrap(await db().from('users').select('full_name').eq('user_id', employeeUserId).limit(1));
                employeeName = rows[0]?.full_name ?? null;
            }
            let departmentName = null;
            if (departmentId) {
                const rows = unwrap(await db().from('departments').select('department_name').eq('department_id', departmentId).limit(1));
                departmentName = rows[0]?.department_name ?? null;
            }

            const inserted = unwrap(
                await db()
                    .from('seat_reservations')
                    .insert({
                        schedule_id: scheduleId, resort_id: resortId, reservation_type: reservationType,
                        employee_user_id: employeeUserId, department_id: departmentId, contact_name: contactName, seats,
                        start_date: startDate, end_date: endDate, weekdays, reason,
                        created_by_user_id: user.user_id,
                    })
                    .select('*')
            );
            const reservation = { ...inserted[0], direction, employee_name_snapshot: employeeName, department_name_snapshot: departmentName };
            await recordReservationAudit({ reservation, action: 'created', actorUserId: user.user_id, reason });
            return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('success', 'Seat reservation created.')].filter(Boolean) });
        }

        if (form.action === 'bulk_create') {
            // System Administrator only - stricter than the
            // booking.manage_seat_reservations permission every other
            // action here uses (HR Manager included).
            if (user.role_name !== ROLE_ADMIN) return notFound();

            const reservationType = form.reservation_type;
            if (!RESERVATION_TYPES.some((t) => t.value === reservationType)) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Invalid reservation type.')].filter(Boolean) });
            }

            const scheduleIdsRaw = form.schedule_ids;
            const scheduleIds = [...new Set((Array.isArray(scheduleIdsRaw) ? scheduleIdsRaw : scheduleIdsRaw ? [scheduleIdsRaw] : []).map(Number).filter(Boolean))];
            if (!scheduleIds.length) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Select at least one ferry schedule.')].filter(Boolean) });
            }

            const resortOption = form.resort_option;
            const resortId = resortOption === 'both' ? null : Number(resortOption) || null;
            if (resortOption !== 'both' && !resortId) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Please choose a valid resort.')].filter(Boolean) });
            }

            const seats = Math.max(1, Number(form.seats) || 0);
            const startDate = form.start_date;
            const endDate = form.end_date;
            const reason = (form.reason || '').trim() || null;
            const weekdaysRaw = form.weekdays;
            const weekdays = (Array.isArray(weekdaysRaw) ? weekdaysRaw : weekdaysRaw ? [weekdaysRaw] : []).filter((d) => WEEKDAY_OPTIONS.includes(d));

            if (!startDate || !endDate) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Start and end dates are required.')].filter(Boolean) });
            }
            if (endDate < startDate) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'End date must be on or after the start date.')].filter(Boolean) });
            }
            if (!weekdays.length) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Select at least one day of the week.')].filter(Boolean) });
            }

            const bulkEmployeeUserId = reservationType === 'employee_specific' && form.employee_user_id ? Number(form.employee_user_id) : null;
            const bulkDepartmentId = DEPARTMENT_SCOPED_TYPES.includes(reservationType) && form.department_id ? Number(form.department_id) : null;
            const bulkContactName = DEPARTMENT_SCOPED_TYPES.includes(reservationType) ? (form.contact_name || '').trim() || null : null;

            if (DEPARTMENT_REQUIRED_TYPES.includes(reservationType) && !bulkDepartmentId) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Department is required for a Department reservation.')].filter(Boolean) });
            }

            let bulkEmployeeName = null;
            if (bulkEmployeeUserId) {
                const rows = unwrap(await db().from('users').select('full_name').eq('user_id', bulkEmployeeUserId).limit(1));
                bulkEmployeeName = rows[0]?.full_name ?? null;
            }
            let bulkDepartmentName = null;
            if (bulkDepartmentId) {
                const rows = unwrap(await db().from('departments').select('department_name').eq('department_id', bulkDepartmentId).limit(1));
                bulkDepartmentName = rows[0]?.department_name ?? null;
            }

            const scheduleRows = unwrap(
                await db().from('ferry_schedule').select('schedule_id, capacity, status, ferry_routes(direction)').in('schedule_id', scheduleIds)
            );
            const scheduleById = new Map(scheduleRows.map((s) => [s.schedule_id, s]));
            const effectiveReason = reason || 'Bulk reservation (Administrator)';

            let createdCount = 0;
            const skipped = [];

            for (const scheduleId of scheduleIds) {
                const schedule = scheduleById.get(scheduleId);
                if (!schedule || schedule.status !== 'active') {
                    skipped.push(`#${scheduleId} (not found)`);
                    continue;
                }
                if (seats > schedule.capacity) {
                    skipped.push(`#${scheduleId} (exceeds capacity of ${schedule.capacity})`);
                    continue;
                }

                // Generalized duplicate guard: an active reservation of the
                // exact same type+resort+department/employee already
                // overlapping this date range for this specific schedule -
                // other types/resorts/departments are still free to coexist.
                let dupQuery = db()
                    .from('seat_reservations')
                    .select('reservation_id')
                    .eq('reservation_type', reservationType)
                    .eq('status', 'active')
                    .eq('schedule_id', scheduleId)
                    .lte('start_date', endDate)
                    .gte('end_date', startDate);
                dupQuery = resortId ? dupQuery.eq('resort_id', resortId) : dupQuery.is('resort_id', null);
                if (reservationType === 'employee_specific') {
                    dupQuery = bulkEmployeeUserId ? dupQuery.eq('employee_user_id', bulkEmployeeUserId) : dupQuery.is('employee_user_id', null);
                } else if (DEPARTMENT_SCOPED_TYPES.includes(reservationType)) {
                    dupQuery = bulkDepartmentId ? dupQuery.eq('department_id', bulkDepartmentId) : dupQuery.is('department_id', null);
                }
                const dup = unwrap(await dupQuery);
                if (dup.length) {
                    skipped.push(`#${scheduleId} (duplicate reservation)`);
                    continue;
                }

                const before = await getRemainingSeats(scheduleId, startDate);

                const bulkInserted = unwrap(
                    await db()
                        .from('seat_reservations')
                        .insert({
                            schedule_id: scheduleId, resort_id: resortId, reservation_type: reservationType,
                            employee_user_id: bulkEmployeeUserId, department_id: bulkDepartmentId, contact_name: bulkContactName, seats,
                            start_date: startDate, end_date: endDate, weekdays, reason: effectiveReason,
                            created_by_user_id: user.user_id,
                        })
                        .select('*')
                );

                const after = await getRemainingSeats(scheduleId, startDate);

                const reservation = {
                    ...bulkInserted[0],
                    direction: schedule.ferry_routes?.direction ?? null,
                    employee_name_snapshot: bulkEmployeeName,
                    department_name_snapshot: bulkDepartmentName,
                };
                await recordReservationAudit({
                    reservation,
                    action: 'created',
                    actorUserId: user.user_id,
                    reason: effectiveReason,
                    seatsAvailableBefore: before.remaining,
                    seatsAvailableAfter: after.remaining,
                });
                createdCount++;
            }

            await logActivity(user.user_id, 'Bulk seat reservation', `schedules=${scheduleIds.length} created=${createdCount} skipped=${skipped.length}`, clientIp(request));

            const message = createdCount
                ? `Created ${createdCount} reservation(s).${skipped.length ? ' Skipped: ' + skipped.join(', ') : ''}`
                : `No reservations created. Skipped: ${skipped.join(', ')}`;
            return redirectTo('/admin/seat_reservations', {
                cookies: [auth.setCookie, flashSetCookie(createdCount ? 'success' : 'error', message)].filter(Boolean),
            });
        }

        if (form.action === 'edit') {
            const reservationId = Number(form.reservation_id);
            const seats = Math.max(1, Number(form.seats));
            const startDate = form.start_date;
            const endDate = form.end_date;
            const reason = (form.reason || '').trim();
            const weekdays = WEEKDAY_OPTIONS;

            if (!startDate || !endDate || !reason) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'All fields are required.')].filter(Boolean) });
            }
            if (endDate < startDate) {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'End date must be on or after the start date.')].filter(Boolean) });
            }

            const rows = unwrap(
                await db()
                    .from('seat_reservations')
                    .select(
                        'reservation_id, schedule_id, resort_id, reservation_type, status, ' +
                            'employee:users!seat_reservations_employee_user_id_fkey(full_name), department:departments(department_name), ferry_schedule(ferry_routes(direction))'
                    )
                    .eq('reservation_id', reservationId)
                    .limit(1)
            );
            if (!rows.length || rows[0].status !== 'active') {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Reservation not found or already inactive.')].filter(Boolean) });
            }
            const existing = rows[0];
            const contactName = DEPARTMENT_SCOPED_TYPES.includes(existing.reservation_type) ? (form.contact_name || '').trim() || null : null;

            const update = { seats, start_date: startDate, end_date: endDate, weekdays, reason };
            if (DEPARTMENT_SCOPED_TYPES.includes(existing.reservation_type)) update.contact_name = contactName;
            unwrap(await db().from('seat_reservations').update(update).eq('reservation_id', reservationId));

            const reservation = {
                ...existing,
                seats,
                start_date: startDate,
                end_date: endDate,
                contact_name: contactName,
                direction: existing.ferry_schedule?.ferry_routes?.direction ?? null,
                employee_name_snapshot: existing.employee?.full_name ?? null,
                department_name_snapshot: existing.department?.department_name ?? null,
            };
            await recordReservationAudit({ reservation, action: 'modified', actorUserId: user.user_id, reason });
            return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('success', 'Reservation updated.')].filter(Boolean) });
        }

        if (form.action === 'release' || form.action === 'cancel') {
            const reservationId = Number(form.reservation_id);
            const rows = unwrap(
                await db()
                    .from('seat_reservations')
                    .select(
                        'reservation_id, schedule_id, resort_id, reservation_type, seats, start_date, end_date, status, contact_name, ' +
                            'employee:users!seat_reservations_employee_user_id_fkey(full_name), department:departments(department_name), ferry_schedule(ferry_routes(direction))'
                    )
                    .eq('reservation_id', reservationId)
                    .limit(1)
            );
            if (!rows.length || rows[0].status !== 'active') {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Reservation not found or already inactive.')].filter(Boolean) });
            }
            const existing = rows[0];
            const newStatus = form.action === 'release' ? 'released' : 'cancelled';
            unwrap(await db().from('seat_reservations').update({ status: newStatus }).eq('reservation_id', reservationId));

            const reservation = {
                ...existing,
                direction: existing.ferry_schedule?.ferry_routes?.direction ?? null,
                employee_name_snapshot: existing.employee?.full_name ?? null,
                department_name_snapshot: existing.department?.department_name ?? null,
            };
            await recordReservationAudit({ reservation, action: newStatus === 'released' ? 'released' : 'cancelled', actorUserId: user.user_id, reason: form.reason || null });
            return redirectTo('/admin/seat_reservations', {
                cookies: [auth.setCookie, flashSetCookie('success', newStatus === 'released' ? 'Reservation released.' : 'Reservation cancelled.')].filter(Boolean),
            });
        }

        if (form.action === 'delete') {
            // Administrator-only, and only once already Released/Cancelled/
            // Expired - forces a deliberate two-step (cancel/release, then
            // delete) rather than ever instantly purging a live,
            // capacity-holding reservation. Hard SQL DELETE - the only such
            // delete in this app - is safe here because
            // seat_reservation_log.reservation_id now uses ON DELETE SET
            // NULL (0026_seat_reservation_delete.sql), so the audit trail
            // (with its own denormalized snapshots) survives; a final
            // 'deleted' log row is written first, while the FK is still valid.
            if (user.role_name !== ROLE_ADMIN) return notFound();
            const reservationId = Number(form.reservation_id);
            const rows = unwrap(
                await db()
                    .from('seat_reservations')
                    .select(
                        'reservation_id, schedule_id, resort_id, reservation_type, seats, start_date, end_date, status, contact_name, ' +
                            'employee:users!seat_reservations_employee_user_id_fkey(full_name), department:departments(department_name), ferry_schedule(ferry_routes(direction))'
                    )
                    .eq('reservation_id', reservationId)
                    .limit(1)
            );
            if (!rows.length || rows[0].status === 'active') {
                return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('error', 'Reservation not found, or still active - release or cancel it first.')].filter(Boolean) });
            }
            const existing = rows[0];
            const reservation = {
                ...existing,
                direction: existing.ferry_schedule?.ferry_routes?.direction ?? null,
                employee_name_snapshot: existing.employee?.full_name ?? null,
                department_name_snapshot: existing.department?.department_name ?? null,
            };
            await recordReservationAudit({ reservation, action: 'deleted', actorUserId: user.user_id, reason: 'Deleted by Administrator from the Seat Reservations page' });
            unwrap(await db().from('seat_reservations').delete().eq('reservation_id', reservationId));
            await logActivity(user.user_id, 'Deleted seat reservation', `reservation_id=${reservationId}`, clientIp(request));
            return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie, flashSetCookie('success', 'Reservation permanently deleted.')].filter(Boolean) });
        }

        return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie] });
    });
}
