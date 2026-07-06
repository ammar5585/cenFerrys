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

async function recordReservationAudit({ reservation, action, actorUserId, reason }) {
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
        })
    );
}

async function reservationsPageBody({ statusFilter, resortFilter, csrfToken }) {
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
    const reservations = unwrap(await query);

    const resorts = await getActiveResorts();
    const departments = await getAllDepartments();
    const activeUsers = unwrap(await db().from('users').select('user_id, full_name, employee_id').eq('status', 'active').order('full_name'));
    const schedules = unwrap(
        await db().from('ferry_schedule').select('schedule_id, departure_time, ferry_routes(route_name, direction)').eq('status', 'active').order('departure_time')
    );

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
        .map((s) => `<option value="${s.schedule_id}">${h(s.ferry_routes.route_name)} - ${h(s.ferry_routes.direction)} - ${h(formatTime(s.departure_time))}</option>`)
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
    function sync() {
        employeeField.style.display = typeSelect.value === 'employee_specific' ? '' : 'none';
        var isDepartmentScoped = departmentScopedTypes.indexOf(typeSelect.value) !== -1;
        departmentField.style.display = isDepartmentScoped ? '' : 'none';
        nameField.style.display = isDepartmentScoped ? '' : 'none';
    }
    typeSelect.addEventListener('change', sync);
    sync();
})();
</script>`;

    return html`
<div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="mb-0"><i class="bi bi-bookmark-star"></i> Seat Reservations</h5>
    <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#createReservationModal"><i class="bi bi-plus-lg"></i> New Reservation</button>
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
${raw(editModalsHtml)}`;
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

        return redirectTo('/admin/seat_reservations', { cookies: [auth.setCookie] });
    });
}
