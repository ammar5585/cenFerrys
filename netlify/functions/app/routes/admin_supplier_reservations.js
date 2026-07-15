// Supplier Visit Seat Reservation - admin page. Route file stays thin,
// business logic lives in supplierReservations.js, matching the
// convention used across the app (see admin_capacity_allocator.js).
//
// Access: booking.manage_supplier_reservations (Administrator, Cluster
// General Manager, Resident Manager, Cluster Director of HR, Assistant
// HR Manager - the 5 confirmed roles; any other role can be granted
// this later via Roles & Permissions with no code change).

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { hasPermission } from '../permissions.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { scheduleLabel, formatDate, formatTime, statusBadgeClass } from '../format.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { logActivity, clientIp } from '../activity.js';
import { getFerryServices } from '../ferryServices.js';
import { getActiveResorts, getActiveDepartments } from '../refData.js';
import {
    getVisitPurposes,
    createVisitPurpose,
    updateVisitPurpose,
    setVisitPurposeActive,
    createSupplierReservation,
    setLegStatus,
    cancelSupplierReservation,
    getSupplierReservations,
    getSupplierDashboardStats,
} from '../supplierReservations.js';

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

function statCard({ value, label, icon }) {
    return html`<div class="col-sm-6 col-lg-2">
    <div class="stat-card d-flex align-items-center gap-3">
        <div class="stat-icon-badge"><i class="bi ${icon}"></i></div>
        <div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>
    </div>
</div>`;
}

async function activeUsers() {
    return unwrap(await db().from('users').select('user_id, full_name, employee_id').eq('status', 'active').order('full_name'));
}

function legBadge(leg) {
    return `<span class="badge ${statusBadgeClass(leg.booking_status.badge_color)}">${h(leg.booking_status.status_name)}</span>`;
}

const LEG_ACTION_STATUSES = ['Pending', 'Approved', 'Confirmed', 'Cancelled'];

// Approval must go to HR (or Administrator) - a role that can create a
// supplier reservation (booking.manage_supplier_reservations) but
// lacks booking.approve_supplier_reservations cannot self-approve it,
// so "Approved" is left out of their dropdown entirely (also enforced
// server-side in the POST handler - never trust the client alone).
function legRowHtml(reservation, leg, legLabel, csrfToken, canApprove) {
    const statusOptions = LEG_ACTION_STATUSES.filter((s) => s !== 'Approved' || canApprove || leg.booking_status.status_name === 'Approved');
    return `<div class="d-flex justify-content-between align-items-center py-1">
        <div><strong>${legLabel}</strong>: ${h(scheduleLabel(leg.ferry_schedule))} - ${formatDate(leg.travel_date)} ${formatTime(leg.ferry_schedule.departure_time)} (${leg.seats} pax) ${legBadge(leg)}</div>
        <form method="post" class="d-flex gap-1">
            ${csrfField(csrfToken)}<input type="hidden" name="action" value="set_leg_status"><input type="hidden" name="booking_id" value="${leg.booking_id}">
            <select name="status_name" class="form-select form-select-sm">
                ${statusOptions.map((s) => `<option value="${s}" ${leg.booking_status.status_name === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <button class="btn btn-sm btn-outline-primary">Set</button>
        </form>
    </div>`;
}

async function listBody({ csrfToken, search, dateFrom, dateTo, canApprove }) {
    const [stats, reservations, resorts, departments, users, ferryServices, visitPurposes] = await Promise.all([
        getSupplierDashboardStats(),
        getSupplierReservations({ dateFrom, dateTo, search }),
        getActiveResorts(),
        getActiveDepartments(),
        activeUsers(),
        getFerryServices({ statusFilter: 'active' }),
        getVisitPurposes({}),
    ]);

    const statsHtml = [
        statCard({ value: stats.today, label: 'Reservations Today', icon: 'bi-calendar-check' }),
        statCard({ value: stats.upcoming, label: 'Upcoming Visits', icon: 'bi-calendar-plus' }),
        statCard({ value: stats.checkedIn, label: 'Checked-In', icon: 'bi-box-arrow-in-right' }),
        statCard({ value: stats.departed, label: 'Departed', icon: 'bi-arrow-up-right' }),
        statCard({ value: stats.arrived, label: 'Arrived', icon: 'bi-flag' }),
        statCard({ value: stats.cancelled, label: 'Cancelled', icon: 'bi-x-circle' }),
    ]
        .map((s) => s.toString())
        .join('');

    const rowsHtml = reservations
        .map((r) => {
            const legsHtml = r.bookings
                .map((leg, i) => legRowHtml(r, leg, r.bookings.length > 1 ? (i === 0 ? 'Outbound' : 'Return') : 'Trip', csrfToken, canApprove))
                .join('');
            return `<tr>
            <td>${h(r.supplier_company)}<div class="text-muted small">${h(r.visitor_name)}</div></td>
            <td>${h(r.users?.full_name ?? '-')}<div class="text-muted small">${h(r.host_department?.department_name ?? '-')}</div></td>
            <td>${h(r.visit_purposes?.purpose_name ?? '-')}</td>
            <td>${h(r.resorts?.resort_name ?? '-')}</td>
            <td>${legsHtml}</td>
            <td>
                <form method="post" data-confirm="Cancel this supplier visit reservation? Both legs (if any) will be cancelled.">
                    ${csrfField(csrfToken)}<input type="hidden" name="action" value="cancel"><input type="hidden" name="reservation_id" value="${r.reservation_id}">
                    <button class="btn btn-sm btn-outline-danger"><i class="bi bi-x-circle"></i> Cancel Visit</button>
                </form>
            </td>
        </tr>`;
        })
        .join('');

    const resortOptionsHtml = resorts.map((rr) => `<option value="${rr.resort_id}">${h(rr.resort_name)}</option>`).join('');
    const departmentOptionsHtml = departments.map((d) => `<option value="${d.department_id}">${h(d.department_name)}</option>`).join('');
    const userOptionsHtml = users.map((u) => `<option value="${u.user_id}">${h(u.full_name)} (${h(u.employee_id)})</option>`).join('');
    const scheduleOptionsHtml = ferryServices.map((s) => `<option value="${s.schedule_id}">${h(scheduleLabel(s))} - ${h(formatTime(s.departure_time))}</option>`).join('');
    const purposeOptionsHtml = visitPurposes
        .filter((p) => p.is_active)
        .map((p) => `<option value="${p.purpose_id}">${h(p.purpose_name)}</option>`)
        .join('');

    const createModalHtml = `<div class="modal fade" id="createSupplierReservationModal" tabindex="-1"><div class="modal-dialog modal-lg"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="create">
    <div class="modal-header"><h5 class="modal-title"><i class="bi bi-person-plus"></i> New Supplier Visit Reservation</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="row g-3">
            <div class="col-md-6"><label class="form-label">Supplier Company Name</label><input type="text" name="supplier_company" class="form-control" required></div>
            <div class="col-md-6"><label class="form-label">Visitor Full Name</label><input type="text" name="visitor_name" class="form-control" required></div>
            <div class="col-md-4"><label class="form-label">Nationality (Optional)</label><input type="text" name="nationality" class="form-control"></div>
            <div class="col-md-4"><label class="form-label">Contact Number</label><input type="text" name="contact_number" class="form-control" required></div>
            <div class="col-md-4"><label class="form-label">Email Address (Optional)</label><input type="email" name="email" class="form-control"></div>
            <div class="col-md-4"><label class="form-label">Number of Passengers (PAX)</label><input type="number" name="pax" class="form-control" min="1" value="1" required></div>
            <div class="col-md-8"><label class="form-label">Visit Purpose</label><select name="visit_purpose_id" class="form-select" required>${purposeOptionsHtml}</select></div>
            <div class="col-md-6"><label class="form-label">Visiting Department</label><select name="visiting_department_id" class="form-select"><option value="">-</option>${departmentOptionsHtml}</select></div>
            <div class="col-md-6"><label class="form-label">Host Employee</label><select name="host_employee_user_id" class="form-select" required><option value="">-- Select --</option>${userOptionsHtml}</select></div>
            <div class="col-md-6"><label class="form-label">Host Department</label><select name="host_department_id" class="form-select"><option value="">-</option>${departmentOptionsHtml}</select></div>
            <div class="col-md-6"><label class="form-label">Resort</label><select name="resort_id" class="form-select"><option value="">-</option>${resortOptionsHtml}</select></div>
            <div class="col-md-6"><label class="form-label">Boarding Location</label><input type="text" name="boarding_location" class="form-control"></div>
            <div class="col-md-6"><label class="form-label">Destination</label><input type="text" name="destination" class="form-control"></div>
            <div class="col-md-6"><label class="form-label">Travel Date</label><input type="date" name="travel_date" class="form-control" required value="${new Date().toISOString().slice(0, 10)}"></div>
            <div class="col-md-6"><label class="form-label">Ferry Service</label><select name="schedule_id" class="form-select" required>${scheduleOptionsHtml}</select></div>
            <div class="col-md-4"><label class="form-label d-block">Return Required</label>
                <div class="form-check form-switch mt-2"><input class="form-check-input" type="checkbox" role="switch" name="return_required" value="1" id="supReturnRequired"><label class="form-check-label" for="supReturnRequired">Yes</label></div>
            </div>
            <div class="col-md-8" id="supReturnScheduleWrap" style="display:none"><label class="form-label">Return Ferry</label><select name="return_schedule_id" class="form-select">${scheduleOptionsHtml}</select></div>
            <div class="col-12"><label class="form-label">Remarks</label><textarea name="remarks" class="form-control" rows="2"></textarea></div>
        </div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Create Reservation</button></div>
</form></div></div>
<script>
(function () {
    var toggle = document.getElementById('supReturnRequired');
    var wrap = document.getElementById('supReturnScheduleWrap');
    if (!toggle || !wrap) return;
    toggle.addEventListener('change', function () { wrap.style.display = toggle.checked ? '' : 'none'; });
})();
</script>`;

    const purposesRowsHtml = visitPurposes
        .map(
            (p) => `<tr>
        <td>
            <form method="post" class="d-flex gap-2">
                ${csrfField(csrfToken)}<input type="hidden" name="action" value="update_purpose"><input type="hidden" name="purpose_id" value="${p.purpose_id}">
                <input type="text" name="purpose_name" class="form-control form-control-sm" value="${h(p.purpose_name)}">
                <button class="btn btn-sm btn-outline-primary">Save</button>
            </form>
        </td>
        <td>
            <form method="post">
                ${csrfField(csrfToken)}<input type="hidden" name="action" value="toggle_purpose"><input type="hidden" name="purpose_id" value="${p.purpose_id}"><input type="hidden" name="is_active" value="${p.is_active ? '0' : '1'}">
                <button class="btn btn-sm ${p.is_active ? 'btn-outline-secondary' : 'btn-outline-success'}">${p.is_active ? 'Deactivate' : 'Activate'}</button>
            </form>
        </td>
    </tr>`
        )
        .join('');

    const purposesModalHtml = `<div class="modal fade" id="managePurposesModal" tabindex="-1"><div class="modal-dialog"><div class="modal-content">
    <div class="modal-header"><h5 class="modal-title"><i class="bi bi-tags"></i> Manage Visit Purposes</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <table class="table table-sm"><tbody>${purposesRowsHtml}</tbody></table>
        <form method="post" class="d-flex gap-2 mt-2">
            ${csrfField(csrfToken)}<input type="hidden" name="action" value="create_purpose">
            <input type="text" name="purpose_name" class="form-control form-control-sm" placeholder="New visit purpose" required>
            <button class="btn btn-sm btn-primary">Add</button>
        </form>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button></div>
</div></div></div>`;

    return html`
<div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="mb-0"><i class="bi bi-person-badge"></i> Supplier Visit Reservations</h5>
    <div class="d-flex gap-2">
        <button class="btn btn-outline-secondary" data-bs-toggle="modal" data-bs-target="#managePurposesModal"><i class="bi bi-tags"></i> Visit Purposes</button>
        <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#createSupplierReservationModal"><i class="bi bi-plus-lg"></i> New Reservation</button>
    </div>
</div>
${!canApprove ? html`<div class="alert alert-secondary small"><i class="bi bi-info-circle"></i> Approving a reservation (Pending &rarr; Approved) requires HR or an Administrator - you can still create reservations and set Confirmed/Cancelled.</div>` : ''}
<div class="row g-3 mb-3">${raw(statsHtml)}</div>
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-3"><input type="text" name="q" class="form-control" placeholder="Company, visitor, host, department, ferry, date" value="${h(search || '')}"></div>
        <div class="col-md-3"><input type="date" name="date_from" class="form-control" value="${dateFrom || ''}"></div>
        <div class="col-md-3"><input type="date" name="date_to" class="form-control" value="${dateTo || ''}"></div>
        <div class="col-md-3"><button class="btn btn-sm btn-outline-primary" type="submit"><i class="bi bi-search"></i> Search</button> <a href="/admin/supplier_reservations" class="btn btn-sm btn-outline-secondary">Reset</a></div>
    </form>
</div></div>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Supplier / Visitor</th><th>Host</th><th>Purpose</th><th>Resort</th><th>Leg(s)</th><th>Actions</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="6" class="text-center text-muted py-4">No supplier reservations found.</td></tr>')}</tbody>
</table></div></div>
${raw(createModalHtml)}
${raw(purposesModalHtml)}`;
}

export function registerAdminSupplierReservationsRoutes(router) {
    router.get('/admin/supplier_reservations', async (request) => {
        const auth = await requirePermission(request, 'booking.manage_supplier_reservations', { pageTitle: 'Supplier Visit Reservations' });
        if (auth.response) return auth.response;

        const url = new URL(request.url);
        const search = url.searchParams.get('q') || '';
        const dateFrom = url.searchParams.get('date_from') || '';
        const dateTo = url.searchParams.get('date_to') || '';

        const canApprove = hasPermission(auth.user.perms, 'booking.approve_supplier_reservations');
        const body = await listBody({ csrfToken: auth.user.csrf, search, dateFrom, dateTo, canApprove });
        return renderShellForRequest({ request, auth, pageTitle: 'Supplier Visit Reservations', path: '/admin/supplier_reservations', bodyHtml: body });
    });

    router.post('/admin/supplier_reservations', async (request) => {
        const auth = await requirePermission(request, 'booking.manage_supplier_reservations', { pageTitle: 'Supplier Visit Reservations' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const backTo = '/admin/supplier_reservations';

        if (form.action === 'create') {
            const returnRequired = !!form.return_required;
            try {
                const { reservation } = await createSupplierReservation({
                    supplierCompany: (form.supplier_company || '').trim(),
                    visitorName: (form.visitor_name || '').trim(),
                    nationality: (form.nationality || '').trim(),
                    contactNumber: (form.contact_number || '').trim(),
                    email: (form.email || '').trim(),
                    pax: Math.max(1, Number(form.pax) || 1),
                    visitPurposeId: Number(form.visit_purpose_id) || null,
                    visitingDepartmentId: Number(form.visiting_department_id) || null,
                    hostEmployeeUserId: Number(form.host_employee_user_id),
                    hostDepartmentId: Number(form.host_department_id) || null,
                    resortId: Number(form.resort_id) || null,
                    boardingLocation: (form.boarding_location || '').trim(),
                    destination: (form.destination || '').trim(),
                    travelDate: form.travel_date,
                    scheduleId: Number(form.schedule_id),
                    returnRequired,
                    returnScheduleId: returnRequired ? Number(form.return_schedule_id) || null : null,
                    remarks: (form.remarks || '').trim(),
                    createdByUserId: user.user_id,
                });
                await logActivity(user.user_id, 'Created supplier visit reservation', `reservation_id=${reservation.reservation_id}`, clientIp(request));
                return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('success', 'Supplier visit reservation created.')].filter(Boolean) });
            } catch (err) {
                const message = err.message === 'CAPACITY_EXCEEDED' ? 'Not enough seats remaining on the selected ferry.' : `Could not create reservation: ${err.message}`;
                return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('error', message)].filter(Boolean) });
            }
        }

        if (form.action === 'set_leg_status') {
            // Approval must go to HR (or Administrator) - never trust the
            // client-side dropdown filtering alone.
            if (form.status_name === 'Approved' && !hasPermission(user.perms, 'booking.approve_supplier_reservations')) {
                return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('error', 'Only HR or an Administrator can approve a supplier visit reservation.')].filter(Boolean) });
            }
            const result = await setLegStatus(Number(form.booking_id), form.status_name, user.user_id);
            await logActivity(user.user_id, 'Set supplier reservation leg status', `booking_id=${form.booking_id} status=${form.status_name}`, clientIp(request));
            const message = result.ok ? 'Status updated.' : 'Could not update status.';
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', message)].filter(Boolean) });
        }

        if (form.action === 'cancel') {
            await cancelSupplierReservation(Number(form.reservation_id), user.user_id);
            await logActivity(user.user_id, 'Cancelled supplier visit reservation', `reservation_id=${form.reservation_id}`, clientIp(request));
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('success', 'Supplier visit reservation cancelled.')].filter(Boolean) });
        }

        if (form.action === 'create_purpose') {
            const result = await createVisitPurpose(form.purpose_name);
            await logActivity(user.user_id, 'Created visit purpose', form.purpose_name, clientIp(request));
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? 'Visit purpose added.' : 'That visit purpose already exists.')].filter(Boolean) });
        }

        if (form.action === 'update_purpose') {
            await updateVisitPurpose(Number(form.purpose_id), form.purpose_name);
            await logActivity(user.user_id, 'Edited visit purpose', `purpose_id=${form.purpose_id}`, clientIp(request));
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('success', 'Visit purpose updated.')].filter(Boolean) });
        }

        if (form.action === 'toggle_purpose') {
            await setVisitPurposeActive(Number(form.purpose_id), form.is_active === '1');
            await logActivity(user.user_id, 'Toggled visit purpose status', `purpose_id=${form.purpose_id}`, clientIp(request));
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('success', 'Visit purpose updated.')].filter(Boolean) });
        }

        return redirectTo(backTo, { cookies: [auth.setCookie] });
    });
}
