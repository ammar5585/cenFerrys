// Emergency Passenger Transfer - Bulk Ferry Reallocation. Business
// logic lives in ferryTransfer.js; this file stays thin, matching the
// route-file convention used across the app (routes/admin_ferry_services.js,
// routes/admin_seat_reservations.js).
//
// Gated by the booking.bulk_transfer_passengers permission (granted, by
// exact role_name, to Administrator/Cluster Director of HR/Assistant HR
// Manager/Cluster General Manager/Resident Manager - see
// 0029_ferry_transfer.sql). Security additionally gets read-only
// visibility via security.manage_manifest, with no destination picker,
// transfer options, or submit control - they can see capacity but
// cannot move anyone.

import { requireLogin } from '../guards.js';
import { hasPermission } from '../permissions.js';
import { accessDeniedResponse } from '../accessDenied.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { formatDate, formatTime } from '../format.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { logActivity, clientIp } from '../activity.js';
import { getFerryServices } from '../ferryServices.js';
import { getSourceSummary, getCandidateDestinations, performBulkTransfer } from '../ferryTransfer.js';

const ACTION_ERROR = {
    same_schedule: 'Source and destination ferry must be different.',
    invalid_option: 'Please choose a transfer option.',
    missing_reason: 'Please enter a reason for this transfer.',
    not_found: 'Ferry service not found.',
    no_passengers: 'No passengers match the selected transfer option.',
};

function insufficientCapacityMessage(result) {
    return `Not enough seats on the destination ferry: ${result.requestedSeats} passenger seat(s) requested, only ${result.availableSeats} remaining.`;
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

async function ferryTransferBody({ scheduleId, travelDate, csrfToken, canTransfer }) {
    const today = new Date().toISOString().slice(0, 10);
    const services = await getFerryServices({ statusFilter: 'active' });

    const selectionFormHtml = html`
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-3">
        <div class="col-md-5"><label class="form-label">Source Ferry (currently affected)</label>
            <select name="schedule_id" class="form-select" required>
                <option value="">-- Select Ferry --</option>
                ${raw(services.map((s) => `<option value="${s.schedule_id}" ${scheduleId === s.schedule_id ? 'selected' : ''}>${h(s.service_name ?? s.routeSnapshot)} (${h(s.service_code ?? '-')})</option>`).join(''))}
            </select>
        </div>
        <div class="col-md-4"><label class="form-label">Travel Date</label><input type="date" name="travel_date" class="form-control" value="${travelDate || today}" required></div>
        <div class="col-md-3 d-flex align-items-end"><button class="btn btn-primary w-100" type="submit"><i class="bi bi-search"></i> Load Passengers</button></div>
    </form>
</div></div>`;

    if (!scheduleId || !travelDate) {
        return html`
<h5 class="mb-3"><i class="bi bi-arrow-left-right"></i> Bulk Passenger Transfer</h5>
<div class="alert alert-info">Use this tool during a ferry breakdown, cancellation, maintenance, weather disruption, or capacity adjustment to move passengers already booked on one ferry to another running the same day. Select the affected ferry and date to begin.</div>
${selectionFormHtml}`;
    }

    const summary = await getSourceSummary({ scheduleId, travelDate });
    if (!summary) return notFound();

    const destinations = await getCandidateDestinations({ excludeScheduleId: scheduleId, travelDate });

    const summaryCardHtml = html`
<div class="card shadow-sm mb-3"><div class="card-header bg-white"><i class="bi bi-info-circle"></i> Source Ferry Summary - ${h(summary.label)} on ${formatDate(travelDate)}</div>
    <div class="card-body">
        <div class="row text-center g-2">
            <div class="col"><div class="fw-bold fs-5">${summary.capacity}</div><div class="text-muted small">Capacity</div></div>
            <div class="col"><div class="fw-bold fs-5">${summary.booked}</div><div class="text-muted small">Booked</div></div>
            <div class="col"><div class="fw-bold fs-5">${summary.remaining}</div><div class="text-muted small">Remaining</div></div>
            <div class="col"><div class="fw-bold fs-5">${summary.confirmedSeats}</div><div class="text-muted small">Confirmed</div></div>
            <div class="col"><div class="fw-bold fs-5">${summary.waitingSeats}</div><div class="text-muted small">Waiting List</div></div>
            <div class="col"><div class="fw-bold fs-5">${summary.transferableSeatsTotal}</div><div class="text-muted small">Transferable Total</div></div>
        </div>
        ${summary.skippedReservedCount ? html`<div class="alert alert-warning small mt-3 mb-0">${summary.skippedReservedCount} passenger seat(s) are on HOD/department reserved seats and are excluded here - reassign those manually via the HOD Reserved Seat workflow.</div>` : ''}
    </div>
</div>`;

    if (!summary.transferablePassengers.length) {
        return html`
<h5 class="mb-3"><i class="bi bi-arrow-left-right"></i> Bulk Passenger Transfer</h5>
${selectionFormHtml}
${summaryCardHtml}
<div class="alert alert-secondary">No transferable passengers on this ferry for this date.</div>`;
    }

    if (!canTransfer) {
        return html`
<h5 class="mb-3"><i class="bi bi-arrow-left-right"></i> Bulk Passenger Transfer</h5>
<div class="alert alert-secondary small"><i class="bi bi-eye"></i> Read-only view - you do not have permission to perform a transfer.</div>
${selectionFormHtml}
${summaryCardHtml}`;
    }

    if (!destinations.length) {
        return html`
<h5 class="mb-3"><i class="bi bi-arrow-left-right"></i> Bulk Passenger Transfer</h5>
${selectionFormHtml}
${summaryCardHtml}
<div class="alert alert-warning">No other active ferry services operate on ${formatDate(travelDate)}'s weekday. Add or activate one on the Ferry Services page before transferring passengers.</div>`;
    }

    const passengerRowsHtml = summary.transferablePassengers
        .map(
            (p) => `<tr>
        <td><input type="checkbox" class="form-check-input passenger-checkbox" name="booking_ids" value="${p.booking_id}"></td>
        <td>${h(p.users?.full_name ?? '-')}</td>
        <td>${h(p.users?.employee_id ?? '-')}</td>
        <td>${p.seats}</td>
        <td><span class="badge bg-light text-dark border">${h(p.statusName ?? '-')}</span></td>
    </tr>`
        )
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-arrow-left-right"></i> Bulk Passenger Transfer</h5>
${selectionFormHtml}
${summaryCardHtml}
<form method="post" id="transferForm" data-confirm="Transfer the selected passenger(s) to the chosen destination ferry? This cannot be undone automatically.">
    ${raw(csrfField(csrfToken))}
    <input type="hidden" name="schedule_id" value="${scheduleId}">
    <input type="hidden" name="travel_date" value="${travelDate}">
    <div class="card shadow-sm mb-3"><div class="card-header bg-white">Destination Ferry</div><div class="card-body">
        <select name="destination_schedule_id" class="form-select" required>
            <option value="">-- Select Destination Ferry --</option>
            ${raw(destinations.map((d) => `<option value="${d.scheduleId}">${h(d.label)} - ${formatTime(d.departureTime)} (${d.remaining} seat(s) remaining)</option>`).join(''))}
        </select>
    </div></div>
    <div class="card shadow-sm mb-3"><div class="card-header bg-white">Transfer Option</div><div class="card-body">
        <div class="form-check"><input class="form-check-input transfer-option" type="radio" name="transfer_option" value="all" id="optAll" checked><label class="form-check-label" for="optAll">All Passengers (${summary.transferableSeatsTotal} seat(s))</label></div>
        <div class="form-check"><input class="form-check-input transfer-option" type="radio" name="transfer_option" value="confirmed" id="optConfirmed"><label class="form-check-label" for="optConfirmed">Confirmed Only (${summary.confirmedSeats} seat(s))</label></div>
        <div class="form-check"><input class="form-check-input transfer-option" type="radio" name="transfer_option" value="confirmed_and_waiting" id="optConfirmedWaiting"><label class="form-check-label" for="optConfirmedWaiting">Confirmed + Waiting List (${summary.confirmedSeats + summary.waitingSeats} seat(s))</label></div>
        <div class="form-check"><input class="form-check-input transfer-option" type="radio" name="transfer_option" value="selected" id="optSelected"><label class="form-check-label" for="optSelected">Select Individual Passengers</label></div>
    </div></div>
    <div class="card shadow-sm mb-3" id="passengerPickerCard" style="display:none;"><div class="card-header bg-white d-flex justify-content-between align-items-center">
        <span>Select Passengers</span>
        <span><button type="button" class="btn btn-sm btn-link" id="pxSelectAll">Select All</button><button type="button" class="btn btn-sm btn-link" id="pxSelectNone">Select None</button></span>
    </div>
    <div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
        <thead><tr><th></th><th>Name</th><th>Employee ID</th><th>Seats</th><th>Status</th></tr></thead>
        <tbody>${raw(passengerRowsHtml)}</tbody>
    </table></div></div>
    <div class="card shadow-sm mb-3"><div class="card-body">
        <label class="form-label">Reason for Transfer <span class="text-danger">*</span></label>
        <textarea name="reason" class="form-control" rows="2" required placeholder="e.g. Ferry breakdown, weather cancellation, scheduled maintenance..."></textarea>
    </div></div>
    <button type="submit" class="btn btn-primary"><i class="bi bi-arrow-left-right"></i> Transfer Passengers</button>
</form>
<script>
(function () {
    var optSelected = document.getElementById('optSelected');
    var options = Array.prototype.slice.call(document.querySelectorAll('.transfer-option'));
    var pickerCard = document.getElementById('passengerPickerCard');
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.passenger-checkbox'));
    function sync() {
        pickerCard.style.display = optSelected.checked ? '' : 'none';
    }
    options.forEach(function (o) { o.addEventListener('change', sync); });
    sync();
    var allBtn = document.getElementById('pxSelectAll');
    var noneBtn = document.getElementById('pxSelectNone');
    if (allBtn) allBtn.addEventListener('click', function () { boxes.forEach(function (b) { b.checked = true; }); });
    if (noneBtn) noneBtn.addEventListener('click', function () { boxes.forEach(function (b) { b.checked = false; }); });
    var form = document.getElementById('transferForm');
    form.addEventListener('submit', function (e) {
        if (optSelected.checked && !boxes.some(function (b) { return b.checked; })) {
            e.preventDefault();
            alert('Select at least one passenger to transfer.');
        }
    });
})();
</script>`;
}

export function registerAdminFerryTransferRoutes(router) {
    router.get('/admin/ferry_transfer', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;
        const canTransfer = hasPermission(auth.user.perms, 'booking.bulk_transfer_passengers');
        const canViewReadOnly = hasPermission(auth.user.perms, 'security.manage_manifest');
        if (!canTransfer && !canViewReadOnly) {
            return await accessDeniedResponse({ request, auth, pageTitle: 'Bulk Passenger Transfer' });
        }

        const url = new URL(request.url);
        const scheduleId = Number(url.searchParams.get('schedule_id') || 0) || null;
        const travelDate = url.searchParams.get('travel_date') || '';
        const body = await ferryTransferBody({ scheduleId, travelDate, csrfToken: auth.user.csrf, canTransfer });
        return renderShellForRequest({ request, auth, pageTitle: 'Bulk Passenger Transfer', path: '/admin/ferry_transfer', bodyHtml: body });
    });

    router.post('/admin/ferry_transfer', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;
        if (!hasPermission(auth.user.perms, 'booking.bulk_transfer_passengers')) {
            return await accessDeniedResponse({ request, auth, pageTitle: 'Bulk Passenger Transfer' });
        }
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const scheduleId = Number(form.schedule_id);
        const travelDate = form.travel_date;
        const backTo = `/admin/ferry_transfer?schedule_id=${scheduleId}&travel_date=${travelDate}`;

        const bookingIdsRaw = form.booking_ids;
        const selectedBookingIds = (Array.isArray(bookingIdsRaw) ? bookingIdsRaw : bookingIdsRaw ? [bookingIdsRaw] : []).map(Number).filter(Boolean);

        const result = await performBulkTransfer({
            sourceScheduleId: scheduleId,
            destinationScheduleId: Number(form.destination_schedule_id),
            travelDate,
            transferOption: form.transfer_option,
            selectedBookingIds,
            reason: form.reason,
            actorUserId: user.user_id,
        });

        await logActivity(
            user.user_id,
            'Bulk ferry passenger transfer',
            `source_schedule_id=${scheduleId} destination_schedule_id=${form.destination_schedule_id} option=${form.transfer_option} travel_date=${travelDate} ok=${result.ok}`,
            clientIp(request)
        );

        if (!result.ok) {
            const message = result.reason === 'insufficient_capacity' ? insufficientCapacityMessage(result) : ACTION_ERROR[result.reason] || 'Could not complete this transfer.';
            return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('error', message)].filter(Boolean) });
        }

        const successMessage = `Transferred ${result.transferredCount} passenger(s) (${result.transferredSeats} seat(s)) from ${result.sourceLabel} to ${result.destinationLabel}.${result.skippedReservedCount ? ` ${result.skippedReservedCount} HOD/reserved-seat booking(s) were skipped - reassign those manually.` : ''}`;
        return redirectTo(backTo, { cookies: [auth.setCookie, flashSetCookie('success', successMessage)].filter(Boolean) });
    });
}
