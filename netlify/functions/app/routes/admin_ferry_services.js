// Route-Based Ferry Service Management (Phase 1): Administrator-only
// admin UI for managing ferry services and their route stops. Business
// logic lives in ferryServices.js; this file stays thin, matching the
// route-file convention used across the app (routes/security.js,
// routes/admin_seat_reservations.js).
//
// System Administrator only - stricter than any existing permission
// bitmask, gated by role literal (matching the same pattern used for
// the Bulk Reservation feature and the Seat Reservations Delete action).

import { requireRole } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { formatTime } from '../format.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { logActivity, clientIp } from '../activity.js';
import { ROLE_ADMIN } from '../session.js';
import {
    getFerryServices,
    getServiceWithStops,
    findSimilarActiveServiceWarning,
    createFerryService,
    updateFerryService,
    setFerryServiceStatus,
    bulkSetServiceStatus,
    duplicateFerryService,
    addRouteStop,
    updateRouteStop,
    removeRouteStop,
    moveRouteStop,
} from '../ferryServices.js';

const WEEKDAY_OPTIONS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const ACTION_ERROR = {
    invalid_name: 'Please enter a ferry name.',
    invalid_code: 'Please enter a ferry code.',
    duplicate_code: 'That ferry code is already in use.',
    invalid_capacity: 'Please enter a valid maximum passenger capacity.',
    invalid_weekdays: 'Select at least one operating day.',
    invalid_effective_date: 'Please choose an effective date.',
    invalid_expiry_date: 'Expiry date must be on or after the effective date.',
    invalid_status: 'Invalid status.',
    invalid_stop_name: 'Please enter a stop name.',
    invalid_chronology: null, // uses result.message directly - see flash() below
    not_found: 'Not found.',
    cannot_move: 'This stop cannot be moved further in that direction.',
};

function flash(result, successMessage) {
    if (result.ok) return { type: 'success', message: successMessage };
    return { type: 'error', message: result.message || ACTION_ERROR[result.reason] || 'Could not complete this action.' };
}

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

function weekdaysFromForm(form) {
    const raw_ = form.weekdays;
    return (Array.isArray(raw_) ? raw_ : raw_ ? [raw_] : []).filter((d) => WEEKDAY_OPTIONS.includes(d));
}

// ---------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------
async function servicesListBody({ statusFilter, csrfToken }) {
    const services = await getFerryServices({ statusFilter });

    const weekdayOptionsHtml = (checkedAll) =>
        WEEKDAY_OPTIONS.map((day) => `<div class="form-check form-check-inline"><input class="form-check-input" type="checkbox" name="weekdays" value="${day}" id="svcWd${day}" ${checkedAll ? 'checked' : ''}><label class="form-check-label" for="svcWd${day}">${day}</label></div>`).join('');

    const createModalHtml = `<div class="modal fade" id="createServiceModal" tabindex="-1"><div class="modal-dialog"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="create">
    <div class="modal-header"><h5 class="modal-title"><i class="bi bi-signpost-2"></i> New Ferry Service</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="row g-3">
            <div class="col-md-6"><label class="form-label">Ferry Name</label><input type="text" name="service_name" class="form-control" required></div>
            <div class="col-md-6"><label class="form-label">Ferry Code</label><input type="text" name="service_code" class="form-control" required></div>
            <div class="col-md-4"><label class="form-label">Maximum Passenger Capacity</label><input type="number" name="capacity" class="form-control" min="1" value="20" required></div>
            <div class="col-md-4"><label class="form-label">Effective Date</label><input type="date" name="effective_date" class="form-control" required value="${new Date().toISOString().slice(0, 10)}"></div>
            <div class="col-md-4"><label class="form-label">Expiry Date (optional)</label><input type="date" name="expiry_date" class="form-control"></div>
            <div class="col-12"><label class="form-label mb-1">Operating Days</label><div class="d-flex flex-wrap gap-2">${weekdayOptionsHtml(true)}</div></div>
            <div class="col-12"><div class="alert alert-info small mb-0">After creating the service, add its route stops on the next page - the first stop's departure time becomes this service's nominal departure time everywhere else in the app.</div></div>
        </div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Create Service</button></div>
</form></div></div>`;

    const rowsHtml = services
        .map((s) => {
            const statusBadge = s.status === 'active' ? 'bg-success' : 'bg-secondary';
            return `<tr>
            <td><input type="checkbox" class="form-check-input bulk-service-checkbox" name="schedule_ids" value="${s.schedule_id}" form="bulkServiceForm"></td>
            <td>${h(s.service_name ?? '-')}<div class="text-muted small">${h(s.service_code ?? '-')}</div></td>
            <td>${h(s.routeSnapshot)} <span class="badge bg-light text-dark border">${s.stopCount} stop(s)</span></td>
            <td>${(s.weekdays || []).join(', ')}</td>
            <td>${s.capacity}</td>
            <td>${s.effective_date ?? '-'} ${s.expiry_date ? '→ ' + s.expiry_date : ''}</td>
            <td><span class="badge ${statusBadge}">${s.status.charAt(0).toUpperCase() + s.status.slice(1)}</span></td>
            <td class="text-nowrap">
                <a href="/admin/ferry_services/manage?schedule_id=${s.schedule_id}" class="btn btn-sm btn-outline-primary"><i class="bi bi-signpost-split"></i> Manage Stops</a>
                <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-toggle="modal" data-bs-target="#editServiceModal${s.schedule_id}"><i class="bi bi-pencil"></i></button>
                <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-toggle="modal" data-bs-target="#duplicateServiceModal${s.schedule_id}"><i class="bi bi-copy"></i></button>
                <form method="post" class="d-inline" data-confirm="${s.status === 'active' ? 'Deactivate' : 'Activate'} this ferry service?">
                    ${csrfField(csrfToken)}<input type="hidden" name="action" value="${s.status === 'active' ? 'deactivate' : 'activate'}"><input type="hidden" name="schedule_id" value="${s.schedule_id}">
                    <button class="btn btn-sm btn-outline-secondary"><i class="bi bi-${s.status === 'active' ? 'pause' : 'play'}"></i></button>
                </form>
            </td>
        </tr>`;
        })
        .join('');

    // Edit/Duplicate modals generated separately from the <tr> rows and
    // concatenated only after </table> closes - a modal <div> can never
    // be a direct child of <tbody> (browser foster-parenting bug, fixed
    // the same way elsewhere in this app).
    const perServiceModalsHtml = services
        .map(
            (s) => `<div class="modal fade" id="editServiceModal${s.schedule_id}" tabindex="-1"><div class="modal-dialog"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="edit"><input type="hidden" name="schedule_id" value="${s.schedule_id}">
    <div class="modal-header"><h5 class="modal-title">Edit Ferry Service</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="row g-3">
            <div class="col-12"><label class="form-label">Ferry Name</label><input type="text" name="service_name" class="form-control" value="${h(s.service_name ?? '')}" required></div>
            <div class="col-md-6"><label class="form-label">Maximum Passenger Capacity</label><input type="number" name="capacity" class="form-control" min="1" value="${s.capacity}" required></div>
            <div class="col-md-6"></div>
            <div class="col-md-6"><label class="form-label">Effective Date</label><input type="date" name="effective_date" class="form-control" value="${s.effective_date ?? ''}" required></div>
            <div class="col-md-6"><label class="form-label">Expiry Date (optional)</label><input type="date" name="expiry_date" class="form-control" value="${s.expiry_date ?? ''}"></div>
            <div class="col-12"><label class="form-label mb-1">Operating Days</label><div class="d-flex flex-wrap gap-2">${WEEKDAY_OPTIONS.map((day) => `<div class="form-check form-check-inline"><input class="form-check-input" type="checkbox" name="weekdays" value="${day}" id="editWd${day}${s.schedule_id}" ${(s.weekdays || []).includes(day) ? 'checked' : ''}><label class="form-check-label" for="editWd${day}${s.schedule_id}">${day}</label></div>`).join('')}</div></div>
            <div class="col-12"><label class="form-label">Reason (optional)</label><input type="text" name="reason" class="form-control"></div>
        </div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div>
</form></div></div>
<div class="modal fade" id="duplicateServiceModal${s.schedule_id}" tabindex="-1"><div class="modal-dialog"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="duplicate"><input type="hidden" name="schedule_id" value="${s.schedule_id}">
    <div class="modal-header"><h5 class="modal-title">Duplicate "${h(s.service_name ?? '')}"</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="mb-3"><label class="form-label">New Ferry Name</label><input type="text" name="new_service_name" class="form-control" value="${h((s.service_name ?? '') + ' (Copy)')}" required></div>
        <div class="mb-0"><label class="form-label">New Ferry Code</label><input type="text" name="new_service_code" class="form-control" required></div>
        <div class="form-text">Copies all ${s.stopCount} route stop(s) from this service.</div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Duplicate</button></div>
</form></div></div>`
        )
        .join('');

    return html`
<div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="mb-0"><i class="bi bi-signpost-2"></i> Ferry Services</h5>
    <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#createServiceModal"><i class="bi bi-plus-lg"></i> New Ferry Service</button>
</div>
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-3"><select name="status" class="form-select">
            <option value="">All Status</option>
            <option value="active" ${statusFilter === 'active' ? 'selected' : ''}>Active</option>
            <option value="inactive" ${statusFilter === 'inactive' ? 'selected' : ''}>Inactive</option>
        </select></div>
        <div class="col-12"><button class="btn btn-sm btn-outline-primary" type="submit"><i class="bi bi-search"></i> Filter</button> <a href="/admin/ferry_services" class="btn btn-sm btn-outline-secondary">Reset</a></div>
    </form>
</div></div>
<form method="post" id="bulkServiceForm" class="card shadow-sm mb-3">
    ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="bulk_status">
    <div class="card-body d-flex flex-wrap gap-2 align-items-center">
        <span class="text-muted small">Bulk action on selected services:</span>
        <button type="submit" name="bulk_status" value="active" class="btn btn-sm btn-outline-success" data-confirm="Activate all selected ferry services?"><i class="bi bi-play"></i> Activate</button>
        <button type="submit" name="bulk_status" value="inactive" class="btn btn-sm btn-outline-secondary" data-confirm="Deactivate all selected ferry services?"><i class="bi bi-pause"></i> Deactivate</button>
        <button type="submit" name="bulk_status" value="archived" class="btn btn-sm btn-outline-danger" data-confirm="Archive all selected ferry services?"><i class="bi bi-archive"></i> Archive</button>
        <button type="button" class="btn btn-sm btn-link" id="svcSelectAll">Select All</button>
        <button type="button" class="btn btn-sm btn-link" id="svcSelectNone">Select None</button>
    </div>
</form>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th></th><th>Ferry</th><th>Route</th><th>Operating Days</th><th>Capacity</th><th>Effective / Expiry</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="8" class="text-center text-muted py-4">No ferry services found.</td></tr>')}</tbody>
</table></div></div>
${raw(createModalHtml)}
${raw(perServiceModalsHtml)}
<script>
(function () {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.bulk-service-checkbox'));
    var allBtn = document.getElementById('svcSelectAll');
    var noneBtn = document.getElementById('svcSelectNone');
    if (allBtn) allBtn.addEventListener('click', function () { boxes.forEach(function (b) { b.checked = true; }); });
    if (noneBtn) noneBtn.addEventListener('click', function () { boxes.forEach(function (b) { b.checked = false; }); });
    var bulkForm = document.getElementById('bulkServiceForm');
    if (bulkForm) {
        bulkForm.addEventListener('submit', function (e) {
            if (!boxes.some(function (b) { return b.checked; })) {
                e.preventDefault();
                alert('Select at least one ferry service first.');
            }
        });
    }
})();
</script>`;
}

// ---------------------------------------------------------------------
// Manage Stops page (one service)
// ---------------------------------------------------------------------
async function manageStopsBody({ service, csrfToken }) {
    const stopsHtml = service.stops
        .map((stop, i) => {
            const isFirst = i === 0;
            const isLast = i === service.stops.length - 1;
            return `<tr>
            <td>${stop.stop_order}</td>
            <td>${h(stop.stop_name)}</td>
            <td>${stop.arrival_time ? formatTime(stop.arrival_time) : (isFirst ? '<span class="text-muted">-</span>' : '')}</td>
            <td>${stop.departure_time ? formatTime(stop.departure_time) : (isLast ? '<span class="text-muted">End of Route</span>' : '')}</td>
            <td>${stop.boarding_allowed ? '<i class="bi bi-check-lg text-success"></i>' : '<i class="bi bi-x-lg text-muted"></i>'}</td>
            <td>${stop.dropoff_allowed ? '<i class="bi bi-check-lg text-success"></i>' : '<i class="bi bi-x-lg text-muted"></i>'}</td>
            <td><span class="badge ${stop.status === 'active' ? 'bg-success' : 'bg-secondary'}">${stop.status}</span></td>
            <td class="text-nowrap">
                <form method="post" class="d-inline">${csrfField(csrfToken)}<input type="hidden" name="action" value="move_stop"><input type="hidden" name="stop_id" value="${stop.stop_id}"><input type="hidden" name="schedule_id" value="${service.schedule_id}"><input type="hidden" name="direction" value="up">
                    <button class="btn btn-sm btn-outline-secondary" ${isFirst ? 'disabled' : ''}><i class="bi bi-arrow-up"></i></button></form>
                <form method="post" class="d-inline">${csrfField(csrfToken)}<input type="hidden" name="action" value="move_stop"><input type="hidden" name="stop_id" value="${stop.stop_id}"><input type="hidden" name="schedule_id" value="${service.schedule_id}"><input type="hidden" name="direction" value="down">
                    <button class="btn btn-sm btn-outline-secondary" ${isLast ? 'disabled' : ''}><i class="bi bi-arrow-down"></i></button></form>
                <button type="button" class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#editStopModal${stop.stop_id}"><i class="bi bi-pencil"></i></button>
                <form method="post" class="d-inline" data-confirm="Remove this stop from the route?">${csrfField(csrfToken)}<input type="hidden" name="action" value="remove_stop"><input type="hidden" name="stop_id" value="${stop.stop_id}"><input type="hidden" name="schedule_id" value="${service.schedule_id}">
                    <button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>
            </td>
        </tr>`;
        })
        .join('');

    const editStopModalsHtml = service.stops
        .map(
            (stop) => `<div class="modal fade" id="editStopModal${stop.stop_id}" tabindex="-1"><div class="modal-dialog"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="update_stop"><input type="hidden" name="stop_id" value="${stop.stop_id}"><input type="hidden" name="schedule_id" value="${service.schedule_id}">
    <div class="modal-header"><h5 class="modal-title">Edit Stop - ${h(stop.stop_name)}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="mb-3"><label class="form-label">Stop Name</label><input type="text" name="stop_name" class="form-control" value="${h(stop.stop_name)}" required></div>
        <div class="row g-2 mb-3">
            <div class="col-6"><label class="form-label">Arrival Time</label><input type="time" name="arrival_time" class="form-control" value="${stop.arrival_time ? stop.arrival_time.slice(0, 5) : ''}"></div>
            <div class="col-6"><label class="form-label">Departure Time</label><input type="time" name="departure_time" class="form-control" value="${stop.departure_time ? stop.departure_time.slice(0, 5) : ''}"></div>
        </div>
        <div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" role="switch" name="boarding_allowed" id="boarding${stop.stop_id}" ${stop.boarding_allowed ? 'checked' : ''}><label class="form-check-label" for="boarding${stop.stop_id}">Boarding Allowed</label></div>
        <div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" role="switch" name="dropoff_allowed" id="dropoff${stop.stop_id}" ${stop.dropoff_allowed ? 'checked' : ''}><label class="form-check-label" for="dropoff${stop.stop_id}">Drop-off Allowed</label></div>
        <div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" role="switch" name="status" value="active" id="stopActive${stop.stop_id}" ${stop.status === 'active' ? 'checked' : ''}><label class="form-check-label" for="stopActive${stop.stop_id}">Active</label></div>
        <div class="mb-0"><label class="form-label">Reason (optional)</label><input type="text" name="reason" class="form-control"></div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div>
</form></div></div>`
        )
        .join('');

    return html`
<h5 class="mb-1"><i class="bi bi-signpost-split"></i> Manage Stops - ${h(service.service_name ?? '')}</h5>
<p class="text-muted mb-3">${h(service.service_code ?? '')} &middot; ${h(service.routeSnapshot)}</p>
<a href="/admin/ferry_services" class="btn btn-sm btn-outline-secondary mb-3"><i class="bi bi-arrow-left"></i> Back to Ferry Services</a>
<div class="card shadow-sm mb-3"><div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
    <thead><tr><th>#</th><th>Stop</th><th>Arrival</th><th>Departure</th><th>Boarding</th><th>Drop-off</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${raw(stopsHtml || '<tr><td colspan="8" class="text-center text-muted py-4">No stops configured yet - add the first one below.</td></tr>')}</tbody>
</table></div></div>
<div class="card shadow-sm"><div class="card-header bg-white">Add Stop</div><div class="card-body">
    <form method="post" class="row g-3">
        ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="add_stop"><input type="hidden" name="schedule_id" value="${service.schedule_id}">
        <div class="col-md-4"><label class="form-label">Stop Name</label><input type="text" name="stop_name" class="form-control" required></div>
        <div class="col-md-3"><label class="form-label">Arrival Time</label><input type="time" name="arrival_time" class="form-control"></div>
        <div class="col-md-3"><label class="form-label">Departure Time</label><input type="time" name="departure_time" class="form-control"></div>
        <div class="col-md-2 d-flex align-items-end"><button class="btn btn-primary w-100"><i class="bi bi-plus-lg"></i> Add</button></div>
        <div class="col-md-6"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" name="boarding_allowed" id="newStopBoarding" checked><label class="form-check-label" for="newStopBoarding">Boarding Allowed</label></div></div>
        <div class="col-md-6"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" name="dropoff_allowed" id="newStopDropoff" checked><label class="form-check-label" for="newStopDropoff">Drop-off Allowed</label></div></div>
    </form>
</div></div>
${raw(editStopModalsHtml)}`;
}

export function registerAdminFerryServicesRoutes(router) {
    router.get('/admin/ferry_services', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const body = await servicesListBody({ statusFilter: url.searchParams.get('status') || '', csrfToken: auth.user.csrf });
        return renderShellForRequest({ request, auth, pageTitle: 'Ferry Services', path: '/admin/ferry_services', bodyHtml: body });
    });

    router.post('/admin/ferry_services', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const backTo = '/admin/ferry_services';

        if (form.action === 'create') {
            const result = await createFerryService({
                serviceName: form.service_name,
                serviceCode: form.service_code,
                weekdays: weekdaysFromForm(form),
                capacity: Number(form.capacity),
                effectiveDate: form.effective_date,
                expiryDate: form.expiry_date || null,
                createdByUserId: user.user_id,
            });
            await logActivity(user.user_id, 'Created ferry service', `service_code=${form.service_code || ''}`, clientIp(request));
            const f = flash(result, 'Ferry service created - now add its route stops.');
            return redirectTo(result.ok ? `/admin/ferry_services/manage?schedule_id=${result.service.schedule_id}` : backTo, { cookies: [auth.setCookie, flashSetCookie(f.type, f.message)].filter(Boolean) });
        }

        if (form.action === 'edit') {
            const scheduleId = Number(form.schedule_id);
            const result = await updateFerryService({
                scheduleId,
                serviceName: form.service_name,
                weekdays: weekdaysFromForm(form),
                capacity: Number(form.capacity),
                effectiveDate: form.effective_date,
                expiryDate: form.expiry_date || null,
                actorUserId: user.user_id,
                reason: form.reason || null,
            });
            await logActivity(user.user_id, 'Edited ferry service', `schedule_id=${scheduleId}`, clientIp(request));
            const f = flash(result, 'Ferry service updated.');
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(f.type, f.message)].filter(Boolean) });
        }

        if (form.action === 'activate' || form.action === 'deactivate') {
            const scheduleId = Number(form.schedule_id);
            const result = await setFerryServiceStatus({ scheduleId, status: form.action === 'activate' ? 'active' : 'inactive', actorUserId: user.user_id, reason: null });
            await logActivity(user.user_id, `${form.action === 'activate' ? 'Activated' : 'Deactivated'} ferry service`, `schedule_id=${scheduleId}`, clientIp(request));
            const f = flash(result, `Ferry service ${form.action === 'activate' ? 'activated' : 'deactivated'}.`);
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(f.type, f.message)].filter(Boolean) });
        }

        if (form.action === 'bulk_status') {
            const scheduleIdsRaw = form.schedule_ids;
            const scheduleIds = [...new Set((Array.isArray(scheduleIdsRaw) ? scheduleIdsRaw : scheduleIdsRaw ? [scheduleIdsRaw] : []).map(Number).filter(Boolean))];
            const bulkAction = form.bulk_status; // 'active' | 'inactive' | 'archived'
            if (!scheduleIds.length || !['active', 'inactive', 'archived'].includes(bulkAction)) {
                return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('error', 'Select at least one ferry service.')].filter(Boolean) });
            }
            const status = bulkAction === 'active' ? 'active' : 'inactive';
            const { updatedCount } = await bulkSetServiceStatus({ scheduleIds, status, action: bulkAction, actorUserId: user.user_id, reason: null });
            await logActivity(user.user_id, 'Bulk ferry service status change', `action=${bulkAction} count=${updatedCount}/${scheduleIds.length}`, clientIp(request));
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('success', `Updated ${updatedCount} of ${scheduleIds.length} selected ferry service(s).`)].filter(Boolean) });
        }

        if (form.action === 'duplicate') {
            const scheduleId = Number(form.schedule_id);
            const result = await duplicateFerryService({ scheduleId, newServiceName: form.new_service_name, newServiceCode: form.new_service_code, actorUserId: user.user_id });
            await logActivity(user.user_id, 'Duplicated ferry service', `schedule_id=${scheduleId}`, clientIp(request));
            const f = flash(result, 'Ferry service duplicated.');
            return redirectTo(result.ok ? `/admin/ferry_services/manage?schedule_id=${result.service.schedule_id}` : backTo, { cookies: [auth.setCookie, flashSetCookie(f.type, f.message)].filter(Boolean) });
        }

        return redirectTo(backTo, { cookies: [auth.setCookie] });
    });

    router.get('/admin/ferry_services/manage', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const scheduleId = Number(url.searchParams.get('schedule_id') || 0);
        const service = scheduleId ? await getServiceWithStops(scheduleId) : null;
        if (!service) return notFound();
        const body = await manageStopsBody({ service, csrfToken: auth.user.csrf });
        return renderShellForRequest({ request, auth, pageTitle: 'Manage Stops', path: '/admin/ferry_services/manage', bodyHtml: body });
    });

    router.post('/admin/ferry_services/manage', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const scheduleId = Number(form.schedule_id);
        const backTo = `/admin/ferry_services/manage?schedule_id=${scheduleId}`;

        if (form.action === 'add_stop') {
            const result = await addRouteStop({
                scheduleId,
                stopName: form.stop_name,
                arrivalTime: form.arrival_time || null,
                departureTime: form.departure_time || null,
                boardingAllowed: form.boarding_allowed === 'on',
                dropoffAllowed: form.dropoff_allowed === 'on',
                actorUserId: user.user_id,
            });
            await logActivity(user.user_id, 'Added route stop', `schedule_id=${scheduleId} stop_name=${form.stop_name || ''}`, clientIp(request));
            let message = flash(result, 'Stop added.');
            if (result.ok) {
                const warning = await findSimilarActiveServiceWarning(scheduleId);
                if (warning) message = { type: 'success', message: `Stop added. ${warning}` };
            }
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(message.type, message.message)].filter(Boolean) });
        }

        if (form.action === 'update_stop') {
            const result = await updateRouteStop({
                stopId: Number(form.stop_id),
                stopName: form.stop_name,
                arrivalTime: form.arrival_time || null,
                departureTime: form.departure_time || null,
                boardingAllowed: form.boarding_allowed === 'on',
                dropoffAllowed: form.dropoff_allowed === 'on',
                status: form.status === 'active' ? 'active' : 'inactive',
                actorUserId: user.user_id,
                reason: form.reason || null,
            });
            await logActivity(user.user_id, 'Updated route stop', `stop_id=${form.stop_id || ''}`, clientIp(request));
            const f = flash(result, 'Stop updated.');
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(f.type, f.message)].filter(Boolean) });
        }

        if (form.action === 'remove_stop') {
            const result = await removeRouteStop({ stopId: Number(form.stop_id), actorUserId: user.user_id, reason: null });
            await logActivity(user.user_id, 'Removed route stop', `stop_id=${form.stop_id || ''}`, clientIp(request));
            const f = flash(result, 'Stop removed.');
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(f.type, f.message)].filter(Boolean) });
        }

        if (form.action === 'move_stop') {
            const result = await moveRouteStop({ stopId: Number(form.stop_id), direction: form.direction, actorUserId: user.user_id });
            const f = flash(result, 'Stop order updated.');
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(f.type, f.message)].filter(Boolean) });
        }

        return redirectTo(backTo, { cookies: [auth.setCookie] });
    });
}
