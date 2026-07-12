// Resort Capacity Allocator (CGLM / CMLM) - Phase 1: configuration +
// read-only usage stats only (see resortCapacity.js's header comment -
// Phase 2 wires this into actual booking-acceptance enforcement).
// Route file stays thin, business logic lives in resortCapacity.js,
// matching the convention used across the app.
//
// View access: booking.view_resort_capacity (Administrator, Cluster
// General Manager, Resident Manager, Cluster Director of HR, Assistant
// HR Manager). Modify access: booking.manage_resort_capacity
// (Administrator only) - checked per POST action, and edit/bulk
// controls are hidden entirely in the UI for view-only users.

import { requirePermission } from '../guards.js';
import { hasPermission } from '../permissions.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { scheduleLabel } from '../format.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { logActivity, clientIp } from '../activity.js';
import { getFerryServices } from '../ferryServices.js';
import { getActiveResorts } from '../refData.js';
import { getAllocationForService, setAllocation, removeAllocation, bulkApplyAllocation, getUsageForService, ALLOCATION_ERROR_MESSAGES } from '../resortCapacity.js';

function flash(result, successMessage) {
    if (result.ok) return { type: 'success', message: successMessage };
    return { type: 'error', message: result.message || ALLOCATION_ERROR_MESSAGES[result.reason] || 'Could not complete this action.' };
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

function allocationsFromForm(form, resorts) {
    return resorts.map((r) => ({ resortId: r.resort_id, seats: Number(form[`seats_${r.resort_id}`] || 0) }));
}

const LIVE_CALCULATOR_SCRIPT = `
(function () {
    document.querySelectorAll('[data-capacity-form]').forEach(function (form) {
        var total = Number(form.getAttribute('data-total-capacity'));
        var inputs = Array.prototype.slice.call(form.querySelectorAll('.resort-seats-input'));
        var summary = form.querySelector('.capacity-live-summary');
        var submitBtn = form.querySelector('button[type="submit"]');
        function recompute() {
            var sum = inputs.reduce(function (acc, el) { return acc + (Number(el.value) || 0); }, 0);
            var remaining = total - sum;
            var ok = remaining === 0 && inputs.every(function (el) { return Number(el.value) >= 0; });
            summary.textContent = 'Allocated ' + sum + ' / ' + total + (remaining !== 0 ? ' (' + (remaining > 0 ? remaining + ' seat(s) unallocated' : (-remaining) + ' seat(s) over capacity') + ')' : ' - matches total capacity');
            summary.className = 'capacity-live-summary small mt-1 ' + (ok ? 'text-success' : 'text-danger fw-bold');
            if (submitBtn) submitBtn.disabled = !ok;
        }
        inputs.forEach(function (el) { el.addEventListener('input', recompute); });
        recompute();
    });
})();`;

async function servicesListBody({ csrfToken, canManage }) {
    const [services, resorts] = await Promise.all([getFerryServices({ statusFilter: 'active' }), getActiveResorts()]);
    const allocations = await Promise.all(services.map((s) => getAllocationForService(s.schedule_id)));

    const rowsHtml = services
        .map((s, i) => {
            const alloc = allocations[i];
            const label = scheduleLabel(s);
            const statusBadge = alloc ? `<span class="badge bg-success">Split Configured</span>` : `<span class="badge bg-secondary">Shared Pool (Not Split)</span>`;
            const breakdown = alloc ? alloc.rows.map((r) => `${h(r.resortName)}: ${r.allocatedSeats}`).join(' &middot; ') : '<span class="text-muted">-</span>';
            return `<tr>
            <td><input type="checkbox" class="form-check-input bulk-service-checkbox" name="schedule_ids" value="${s.schedule_id}" form="bulkAllocationModalForm"></td>
            <td>${h(label)}<div class="text-muted small">${h(s.routeSnapshot)}</div></td>
            <td>${s.capacity}</td>
            <td>${statusBadge}</td>
            <td>${breakdown}</td>
            <td><a href="/admin/resort_capacity/manage?schedule_id=${s.schedule_id}" class="btn btn-sm btn-outline-primary"><i class="bi bi-pie-chart"></i> ${canManage ? 'Configure' : 'View'}</a></td>
        </tr>`;
        })
        .join('');

    const bulkResortInputsHtml = resorts
        .map((r) => `<div class="col-md-4"><label class="form-label">${h(r.resort_name)} Seats</label><input type="number" name="seats_${r.resort_id}" class="form-control resort-seats-input" min="0" value="0" required></div>`)
        .join('');

    const bulkModalHtml = canManage
        ? `<div class="modal fade" id="bulkAllocationModal" tabindex="-1"><div class="modal-dialog modal-lg"><form method="post" class="modal-content" id="bulkAllocationModalForm" data-capacity-form data-total-capacity="0">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="bulk_apply">
    <div class="modal-header"><h5 class="modal-title"><i class="bi bi-collection"></i> Bulk Capacity Allocation</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="alert alert-info small">Applies the same CGLM/CMLM split to every selected ferry service below. Each selected service's own total capacity must already equal the sum you enter here - a service with a different total capacity will be skipped (and reported) rather than rescaled.</div>
        <div class="mb-3"><label class="form-label">This split's total (must match each selected service's capacity)</label><input type="number" class="form-control" id="bulkTotalCapacityInput" min="0" value="0"></div>
        <div class="row g-3">${bulkResortInputsHtml}</div>
        <div class="capacity-live-summary small mt-1"></div>
        <div class="mt-3"><label class="form-label">Reason (required)</label><textarea name="reason" class="form-control" rows="2" required></textarea></div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Apply to Selected</button></div>
</form></div></div>
<script>
(function () {
    var totalInput = document.getElementById('bulkTotalCapacityInput');
    var form = document.getElementById('bulkAllocationModalForm');
    if (!totalInput || !form) return;
    totalInput.addEventListener('input', function () { form.setAttribute('data-total-capacity', totalInput.value || '0'); });
})();
</script>`
        : '';

    return html`
<div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="mb-0"><i class="bi bi-pie-chart"></i> Resort Capacity Allocator</h5>
    ${canManage ? raw(`<button class="btn btn-outline-primary" data-bs-toggle="modal" data-bs-target="#bulkAllocationModal"><i class="bi bi-collection"></i> Bulk Allocation</button>`) : ''}
</div>
${!canManage ? html`<div class="alert alert-secondary small"><i class="bi bi-eye"></i> Read-only view - you do not have permission to change capacity allocations.</div>` : ''}
${canManage ? html`<div class="mb-2"><button type="button" class="btn btn-sm btn-link p-0 me-2" id="capSelectAll">Select All</button><button type="button" class="btn btn-sm btn-link p-0" id="capSelectNone">Select None</button></div>` : ''}
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th></th><th>Ferry</th><th>Total Capacity</th><th>Status</th><th>Current Split</th><th>Actions</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="6" class="text-center text-muted py-4">No active ferry services found.</td></tr>')}</tbody>
</table></div></div>
${raw(bulkModalHtml)}
<script>
(function () {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.bulk-service-checkbox'));
    var allBtn = document.getElementById('capSelectAll');
    var noneBtn = document.getElementById('capSelectNone');
    if (allBtn) allBtn.addEventListener('click', function () { boxes.forEach(function (b) { b.checked = true; }); });
    if (noneBtn) noneBtn.addEventListener('click', function () { boxes.forEach(function (b) { b.checked = false; }); });
    var bulkForm = document.getElementById('bulkAllocationModalForm');
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

function usageTableHtml(usage) {
    if (!usage) return `<div class="alert alert-secondary small mb-0">This service has no capacity split configured yet - it uses one shared pool today.</div>`;
    return `<div class="table-responsive"><table class="table table-sm mb-0">
        <thead><tr><th>Resort</th><th>Allocated</th><th>Booked</th><th>Reserved</th><th>Available</th><th>Waiting List</th><th>Utilization</th></tr></thead>
        <tbody>${usage
            .map(
                (u) => `<tr>
            <td>${h(u.resortName)}</td>
            <td>${u.allocated}</td>
            <td>${u.booked}</td>
            <td>${u.reserved}</td>
            <td>${u.available}</td>
            <td>${u.waitingList}</td>
            <td>${u.booked + u.reserved} / ${u.allocated} (${u.utilizationPercent}%)</td>
        </tr>`
            )
            .join('')}</tbody>
    </table></div>`;
}

async function manageServiceBody({ service, allocation, usage, travelDate, resorts, csrfToken, canManage }) {
    const label = scheduleLabel(service);
    const seatsByResort = new Map((allocation?.rows ?? []).map((r) => [r.resortId, r.allocatedSeats]));

    const resortInputsHtml = resorts
        .map((r) => {
            const value = seatsByResort.get(r.resort_id) ?? 0;
            return `<div class="col-md-6"><label class="form-label">${h(r.resort_name)} Seats</label><input type="number" name="seats_${r.resort_id}" class="form-control resort-seats-input" min="0" value="${value}" ${canManage ? '' : 'disabled'} required></div>`;
        })
        .join('');

    const editorHtml = canManage
        ? `<form method="post" class="row g-3" data-capacity-form data-total-capacity="${service.capacity}">
        ${csrfField(csrfToken)}<input type="hidden" name="action" value="save"><input type="hidden" name="schedule_id" value="${service.schedule_id}">
        <div class="col-12"><div class="alert alert-info small mb-0">Total Ferry Capacity: <strong>${service.capacity}</strong> - the seats below must add up to exactly this number.</div></div>
        ${resortInputsHtml}
        <div class="capacity-live-summary small"></div>
        <div class="col-12"><label class="form-label">Reason for Change (required)</label><textarea name="reason" class="form-control" rows="2" required></textarea></div>
        <div class="col-12"><button type="submit" class="btn btn-primary">Save Allocation</button></div>
    </form>
    ${
        allocation
            ? `<form method="post" class="mt-3" data-confirm="Remove this capacity split? The service reverts to one shared pool.">
        ${csrfField(csrfToken)}<input type="hidden" name="action" value="remove"><input type="hidden" name="schedule_id" value="${service.schedule_id}">
        <div class="mb-2"><label class="form-label">Reason (required)</label><input type="text" name="reason" class="form-control" required></div>
        <button type="submit" class="btn btn-outline-danger btn-sm"><i class="bi bi-x-circle"></i> Remove Split (Revert to Shared Pool)</button>
    </form>`
            : ''
    }`
        : `<div class="row g-3">${resortInputsHtml}</div>`;

    return html`
<a href="/admin/resort_capacity" class="btn btn-sm btn-outline-secondary mb-3"><i class="bi bi-arrow-left"></i> Back to Resort Capacity Allocator</a>
<h5 class="mb-1"><i class="bi bi-pie-chart"></i> ${h(label)}</h5>
<p class="text-muted mb-3">${h(service.routeSnapshot)}</p>
<div class="row g-3">
    <div class="col-lg-6"><div class="card shadow-sm"><div class="card-header bg-white">Capacity Allocation</div><div class="card-body">${raw(editorHtml)}</div></div></div>
    <div class="col-lg-6"><div class="card shadow-sm"><div class="card-header bg-white d-flex justify-content-between align-items-center">
        <span>Live Usage</span>
        <form method="get" class="d-flex gap-2"><input type="hidden" name="schedule_id" value="${service.schedule_id}"><input type="date" name="date" class="form-control form-control-sm" value="${travelDate}"><button class="btn btn-sm btn-outline-primary" type="submit">View</button></form>
    </div><div class="card-body">${raw(usageTableHtml(usage))}</div></div></div>
</div>`;
}

export function registerAdminCapacityAllocatorRoutes(router) {
    router.get('/admin/resort_capacity', async (request) => {
        const auth = await requirePermission(request, 'booking.view_resort_capacity', { pageTitle: 'Resort Capacity Allocator' });
        if (auth.response) return auth.response;
        const canManage = hasPermission(auth.user.perms, 'booking.manage_resort_capacity');
        const body = await servicesListBody({ csrfToken: auth.user.csrf, canManage });
        return renderShellForRequest({ request, auth, pageTitle: 'Resort Capacity Allocator', path: '/admin/resort_capacity', bodyHtml: body, extraScripts: LIVE_CALCULATOR_SCRIPT });
    });

    router.get('/admin/resort_capacity/manage', async (request) => {
        const auth = await requirePermission(request, 'booking.view_resort_capacity', { pageTitle: 'Resort Capacity Allocator' });
        if (auth.response) return auth.response;
        const canManage = hasPermission(auth.user.perms, 'booking.manage_resort_capacity');

        const url = new URL(request.url);
        const scheduleId = Number(url.searchParams.get('schedule_id') || 0);
        const travelDate = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

        const services = await getFerryServices({ statusFilter: 'active' });
        const service = services.find((s) => s.schedule_id === scheduleId);
        if (!service) return notFound();

        const [allocation, usage, resorts] = await Promise.all([getAllocationForService(scheduleId), getUsageForService(scheduleId, travelDate), getActiveResorts()]);

        const body = await manageServiceBody({ service, allocation, usage, travelDate, resorts, csrfToken: auth.user.csrf, canManage });
        return renderShellForRequest({ request, auth, pageTitle: 'Manage Resort Capacity', path: '/admin/resort_capacity/manage', bodyHtml: body, extraScripts: LIVE_CALCULATOR_SCRIPT });
    });

    router.post('/admin/resort_capacity', async (request) => {
        const auth = await requirePermission(request, 'booking.manage_resort_capacity', { pageTitle: 'Resort Capacity Allocator' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const backTo = '/admin/resort_capacity';

        if (form.action === 'bulk_apply') {
            const scheduleIdsRaw = form.schedule_ids;
            const scheduleIds = [...new Set((Array.isArray(scheduleIdsRaw) ? scheduleIdsRaw : scheduleIdsRaw ? [scheduleIdsRaw] : []).map(Number).filter(Boolean))];
            if (!scheduleIds.length) {
                return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('error', 'Select at least one ferry service.')].filter(Boolean) });
            }
            const resorts = await getActiveResorts();
            const allocations = allocationsFromForm(form, resorts);
            const reason = (form.reason || '').trim();
            if (!reason) {
                return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('error', 'Please provide a reason for this change.')].filter(Boolean) });
            }

            const { appliedCount, skipped } = await bulkApplyAllocation({ scheduleIds, allocations, actorUserId: user.user_id, reason });
            await logActivity(user.user_id, 'Bulk resort capacity allocation', `schedules=${scheduleIds.length} applied=${appliedCount} skipped=${skipped.length}`, clientIp(request));

            const message = appliedCount
                ? `Applied to ${appliedCount} service(s).${skipped.length ? ' Skipped: ' + skipped.join(', ') : ''}`
                : `No services updated. Skipped: ${skipped.join(', ')}`;
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(appliedCount ? 'success' : 'error', message)].filter(Boolean) });
        }

        return redirectTo(backTo, { cookies: [auth.setCookie] });
    });

    router.post('/admin/resort_capacity/manage', async (request) => {
        const auth = await requirePermission(request, 'booking.manage_resort_capacity', { pageTitle: 'Resort Capacity Allocator' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const scheduleId = Number(form.schedule_id);
        const backTo = `/admin/resort_capacity/manage?schedule_id=${scheduleId}`;

        if (form.action === 'save') {
            const resorts = await getActiveResorts();
            const allocations = allocationsFromForm(form, resorts);
            const reason = (form.reason || '').trim();
            const result = await setAllocation({ scheduleId, allocations, actorUserId: user.user_id, reason });
            await logActivity(user.user_id, 'Resort capacity allocation saved', `schedule_id=${scheduleId} ok=${result.ok}`, clientIp(request));
            const f = flash(result, 'Capacity allocation saved.');
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(f.type, f.message)].filter(Boolean) });
        }

        if (form.action === 'remove') {
            const reason = (form.reason || '').trim();
            const result = await removeAllocation({ scheduleId, actorUserId: user.user_id, reason });
            await logActivity(user.user_id, 'Resort capacity allocation removed', `schedule_id=${scheduleId}`, clientIp(request));
            const f = flash(result, 'Capacity split removed - this service now uses one shared pool again.');
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie(f.type, f.message)].filter(Boolean) });
        }

        return redirectTo(backTo, { cookies: [auth.setCookie] });
    });
}
