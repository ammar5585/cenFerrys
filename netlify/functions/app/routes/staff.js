// Port of staff/dashboard.php, staff/book.php, staff/my_bookings.php,
// staff/profile.php, staff/print_confirmation.php.

import { db, unwrap } from '../db.js';
import { requirePermission, requireLogin } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getSetting } from '../settings.js';
import { getStatusId, routeDepartmentApproval, getApprovalWorkflowInfo } from '../approval.js';
import { bookFerrySeat } from '../seats.js';
import { notifySecurityIfWaitingList } from '../security.js';
import { createNotification } from '../notifications.js';
import { sendTemplatedEmail } from '../mailer.js';
import { deferBestEffort } from '../deferred.js';
import { logActivity, clientIp } from '../activity.js';
import { uploadProfilePicture } from '../uploads.js';
import { redirectTo, htmlResponse, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDate, formatDateTime, formatTime, statusBadgeClass, greeting } from '../format.js';
import { ROLE_ADMIN } from '../session.js';
import { getStopNameOptions } from '../ferryServices.js';
import { getLiveFerryAvailability, getStopTimeWindow, findOverlappingBooking } from '../seatAvailability.js';
import { getActiveResorts } from '../refData.js';

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------
async function staffDashboardBody(userId, fullName, csrfToken) {
    // Independent of each other - fired concurrently rather than
    // one-at-a-time (each round-trip to Supabase pays its own latency).
    const [upcoming, history] = await Promise.all([
        db()
            .from('bookings')
            .select('booking_id, travel_date, direction, purpose, seats, status_id, booking_status(status_name, badge_color), ferry_schedule(departure_time)')
            .eq('user_id', userId)
            .gte('travel_date', new Date().toISOString().slice(0, 10))
            .order('travel_date', { ascending: true })
            .then(unwrap),
        db()
            .from('bookings')
            .select('booking_id, travel_date, direction, booking_status(status_name, badge_color), ferry_schedule(departure_time)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(5)
            .then(unwrap),
    ]);
    const activeUpcoming = upcoming.filter((b) => !['Cancelled', 'Rejected', 'Expired'].includes(b.booking_status.status_name));

    const upcomingHtml = activeUpcoming
        .map(
            (b) => html`<li class="dash-todo-item">
            <span class="dash-todo-dot bg-${b.booking_status.badge_color}"></span>
            <div class="dash-todo-body">
                <div class="dash-todo-title">${formatDate(b.travel_date)} at ${formatTime(b.ferry_schedule.departure_time)} &middot; ${b.direction}</div>
                <div class="dash-todo-meta">${b.purpose} &middot; <span class="badge ${statusBadgeClass(b.booking_status.badge_color)}">${b.booking_status.status_name}</span></div>
            </div>
            <form method="post" action="/staff/my_bookings" data-confirm="Cancel this booking?">
                ${raw(csrfField(csrfToken))}
                <input type="hidden" name="action" value="cancel">
                <input type="hidden" name="booking_id" value="${b.booking_id}">
                <button class="btn btn-sm btn-outline-danger">Cancel</button>
            </form>
        </li>`
        )
        .map((r) => r.toString())
        .join('');

    const historyHtml = history
        .map(
            (b) => html`<li class="dash-activity-item">
            <span class="avatar-circle">${b.direction.charAt(0)}</span>
            <div class="dash-activity-body">
                <div class="dash-activity-title">${b.direction}</div>
                <div class="dash-activity-detail">${formatDate(b.travel_date)} at ${formatTime(b.ferry_schedule.departure_time)}</div>
            </div>
            <span class="badge ${statusBadgeClass(b.booking_status.badge_color)}">${b.booking_status.status_name}</span>
        </li>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<div class="d-flex justify-content-between align-items-center mb-1">
    <div>
        <div class="dash-greeting">${greeting()}, ${fullName.split(' ')[0]}!</div>
        <p class="dash-greeting-sub mb-0">Here's your ferry booking overview.</p>
    </div>
    <a href="/staff/book" class="btn btn-primary"><i class="bi bi-plus-circle"></i> New Booking</a>
</div>
<div class="row g-3 mt-1">
    <div class="col-lg-7">
        <div class="card shadow-sm mb-3">
            <div class="card-header bg-white"><i class="bi bi-calendar-check"></i> Upcoming Bookings</div>
            <div class="card-body pt-2">
                <ul class="dash-todo-list">${raw(upcomingHtml || '<li class="text-muted small py-2">No upcoming bookings. <a href="/staff/book">Book a ferry</a>.</li>')}</ul>
            </div>
        </div>
        <div class="card shadow-sm">
            <div class="card-header bg-white d-flex justify-content-between">
                <span><i class="bi bi-journal-text"></i> Recent Booking History</span>
                <a href="/staff/my_bookings" class="small">View all</a>
            </div>
            <div class="card-body pt-2">
                <ul class="dash-todo-list">${raw(historyHtml || '<li class="text-muted small py-2">No bookings yet.</li>')}</ul>
            </div>
        </div>
    </div>
    <div class="col-lg-5">
        <div class="card shadow-sm">
            <div class="card-body text-center">
                <i class="bi bi-water" style="font-size:2rem;color:var(--theme-primary-color);"></i>
                <h6 class="mt-2">Need a ferry transfer?</h6>
                <p class="text-muted small">Submit a booking request - it will be routed automatically for approval.</p>
                <a href="/staff/book" class="btn btn-primary w-100">Quick Booking</a>
            </div>
        </div>
    </div>
</div>`;
}

// ---------------------------------------------------------------------
// Booking form
// ---------------------------------------------------------------------
function approvalWorkflowInfoHtml(workflowInfo) {
    const execListHtml = workflowInfo.executives.map((e) => `<li>${h(e.fullName)} (${h(e.roleName)})</li>`).join('');

    if (workflowInfo.mode === 'department_hierarchy') {
        return html`
<p class="mb-2"><i class="bi bi-info-circle"></i> Your request will follow your department's approval workflow.</p>
<p class="mb-1 fw-semibold">Approval Hierarchy</p>
<ul class="ps-3 mb-2">
    <li>Primary Approver (In Charge / Head of Department)</li>
    <li>Secondary Approver (Assistant In Charge / Assistant Manager) - if the Primary Approver is unavailable</li>
</ul>
<p class="mb-1 fw-semibold">Executive Override</p>
<p class="mb-1">At any stage of the approval process, the following executives may review and approve or reject your request when necessary:</p>
<ul class="ps-3">${raw(execListHtml || '<li class="text-muted">No executive users are currently active.</li>')}</ul>`;
    }

    return html`
<p class="mb-2"><i class="bi bi-info-circle"></i> Your request will be routed automatically to the first available approver, in this order:</p>
<ul class="ps-3">${raw(execListHtml || '<li class="text-muted">No General Manager, Resident Manager, or HR Manager is currently active.</li>')}</ul>`;
}

/**
 * Renders one ferry as a selectable `.schedule-card` (existing CSS,
 * public/assets/css/style.css - a <label>/<input type=radio> combo
 * where the whole card is clickable) - `legPrefix` is 'outbound' or
 * 'return', giving each leg's radios their own `name` so a page can
 * hold both grids without them fighting over selection. data-*
 * attributes carry everything the client-side Booking Summary panel
 * needs, so no extra fetch is required once a card is selected.
 */
export function bookingCardHtml(card, legPrefix) {
    const full = card.available <= 0;
    const stopChips = card.stopProgress
        .map((s) => `<span class="${s.stopState === 'completed' ? 'text-muted text-decoration-line-through' : s.stopState === 'current' ? 'fw-bold text-primary' : ''}">${h(s.stop_name)}</span>`)
        .join(' <span class="text-muted">&rarr;</span> ');
    return `<div class="col-12 col-md-6 col-xl-4">
    <label class="schedule-card d-block" for="${legPrefix}${card.scheduleId}">
        <input type="radio" name="${legPrefix}_radio" id="${legPrefix}${card.scheduleId}" value="${card.scheduleId}"
            data-full="${full}" data-label="${h(card.label)}" data-departure="${h(formatTime(card.departureTime))}"
            data-arrival="${card.arrivalTime ? h(formatTime(card.arrivalTime)) : ''}" data-duration="${card.journeyDurationMinutes ?? ''}"
            data-status="${h(card.ferryStatus)}" data-available="${card.available}">
        <img src="${h(card.imageUrl)}" alt="${h(card.serviceName ?? 'Ferry')}" loading="lazy" style="width:calc(100% + 2rem);margin:-1rem -1rem 0.75rem;height:140px;object-fit:cover;border-radius:12px 12px 0 0;display:block;">
        <div class="d-flex justify-content-between align-items-start">
            <div><span class="schedule-card-time">${h(card.serviceName ?? card.label)}</span><div class="text-muted small">${h(card.serviceCode ?? '')} &middot; ${h(card.tripType)}</div></div>
            <span class="badge bg-secondary">${h(card.ferryStatus)}</span>
        </div>
        <div class="small text-muted my-1">${raw(stopChips)}</div>
        <div class="d-flex justify-content-between align-items-center my-1">
            <span>${formatTime(card.departureTime)}${card.arrivalTime ? ' &rarr; ' + formatTime(card.arrivalTime) : ''}${card.journeyDurationMinutes ? ' (' + card.journeyDurationMinutes + ' min)' : ''}</span>
            <span>${card.utilization.emoji} ${card.utilization.percentFull}% full</span>
        </div>
        <span class="${full ? 'schedule-card-seats-waitlist' : 'schedule-card-seats-ok'}">${full ? 'Full - Join Waiting List' : card.available + ' seats left'}</span>
        <span class="schedule-card-booked">${card.booked} booked${card.reserved > 0 ? ' &middot; ' + card.reserved + ' reserved' : ''}${card.statusSeats.waitingList > 0 ? ' &middot; ' + card.statusSeats.waitingList + ' waiting' : ''}</span>
    </label>
</div>`;
}

/** A grid fragment for either leg - the same shape returned by GET /ajax/booking_cards for polling/return-candidate refreshes, so the initial page render and every later refresh use identical markup. */
export function bookingCardsFragment(cards, legPrefix) {
    if (!cards.length) return `<div class="col-12 text-muted small">No ferries match the selected date/filters.</div>`;
    return cards.map((c) => bookingCardHtml(c, legPrefix)).join('');
}

/**
 * Candidate return ferries for a chosen outbound card - "opposite
 * direction, same date, departure later than outbound arrival, active,
 * available capacity" (available capacity is inherent: getLiveFerryAvailability
 * already only returns active/bookable services, and a full one still
 * shows here exactly like the outbound grid does, offering Join Waiting
 * List rather than being hidden). Matched by boarding/destination stop
 * name rather than requiring the full stop chain to reverse exactly -
 * real production data already has exactly this pair today (schedule 8
 * CGLM->CMLM->Hulhumale->Male / schedule 15 Male->Hulhumale->CMLM->CGLM).
 */
export async function getReturnCandidateCards({ outboundScheduleId, travelDate, filters = {} }) {
    const allCards = await getLiveFerryAvailability({ travelDate, filters });
    const outbound = allCards.find((c) => c.scheduleId === outboundScheduleId);
    if (!outbound || !outbound.arrivalTime) return [];
    return allCards.filter(
        (c) =>
            c.scheduleId !== outboundScheduleId &&
            c.boardingStopName === outbound.destinationStopName &&
            c.destinationStopName === outbound.boardingStopName &&
            c.departureTime > outbound.arrivalTime
    );
}

function bookingFormBody({ errors, maxSeats, workflowInfo, csrfToken, filters, stopNameOptions, resorts, outboundCardsHtml, prefillScheduleId = '', prefillReturnScheduleId = '', prefillBookingType = 'one_way' }) {
    const today = new Date().toISOString().slice(0, 10);
    const resortOptionsHtml = resorts.map((r) => `<option value="${h(r.resort_name)}" ${filters.resortName === r.resort_name ? 'selected' : ''}>${h(r.resort_name)}</option>`).join('');
    const stopOptionsHtml = (selected) => stopNameOptions.map((name) => `<option value="${h(name)}" ${selected === name ? 'selected' : ''}>${h(name)}</option>`).join('');

    return html`
<h5 class="mb-3"><i class="bi bi-plus-circle"></i> New Ferry Booking</h5>
${errors.length ? html`<div class="alert alert-danger">${raw(errors.map((e) => `${e}<br>`).join(''))}</div>` : ''}

<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" id="filterForm" class="row g-2">
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Travel Date</label><input type="date" name="date" id="travelDate" class="form-control form-control-sm" required min="${today}" value="${filters.travelDate}"></div>
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Search</label><input type="text" name="q" class="form-control form-control-sm" placeholder="Name, code, route" value="${h(filters.q)}"></div>
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Resort</label><select name="resort" class="form-select form-select-sm"><option value="">All Resorts</option>${raw(resortOptionsHtml)}</select></div>
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Boarding</label><select name="boarding" class="form-select form-select-sm"><option value="">Any</option>${raw(stopOptionsHtml(filters.boardingLocation))}</select></div>
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Destination</label><select name="destination" class="form-select form-select-sm"><option value="">Any</option>${raw(stopOptionsHtml(filters.destination))}</select></div>
        <div class="col-6 col-md-2 d-flex align-items-end"><button class="btn btn-sm btn-outline-primary w-100" type="submit"><i class="bi bi-search"></i> Filter</button></div>
    </form>
</div></div>

<form method="post" id="bookingForm">
    ${raw(csrfField(csrfToken))}
    <input type="hidden" name="travel_date" value="${filters.travelDate}">
    <input type="hidden" name="schedule_id" id="scheduleIdInput" value="${prefillScheduleId}">
    <input type="hidden" name="return_schedule_id" id="returnScheduleIdInput" value="${prefillReturnScheduleId}">
    <input type="hidden" name="booking_type" id="bookingTypeInput" value="${prefillBookingType}">

    <div class="card shadow-sm mb-3"><div class="card-body">
        <label class="form-label d-block">Booking Type</label>
        <div class="form-check form-check-inline"><input class="form-check-input" type="radio" name="booking_type_radio" id="bookingTypeOneWay" value="one_way" ${prefillBookingType !== 'same_day_return' ? 'checked' : ''}><label class="form-check-label" for="bookingTypeOneWay">One Way</label></div>
        <div class="form-check form-check-inline"><input class="form-check-input" type="radio" name="booking_type_radio" id="bookingTypeReturn" value="same_day_return" ${prefillBookingType === 'same_day_return' ? 'checked' : ''}><label class="form-check-label" for="bookingTypeReturn">Same-Day Return</label></div>
    </div></div>

    <h6 class="mb-2">Select Outbound Ferry</h6>
    <div class="row g-3 mb-3" id="outboundGrid">${raw(outboundCardsHtml)}</div>

    <div id="returnSection" style="${prefillBookingType === 'same_day_return' ? '' : 'display:none'}">
        <h6 class="mb-2">Select Return Ferry</h6>
        <div class="row g-3 mb-3" id="returnGrid"><div class="col-12 text-muted small">Select an outbound ferry first.</div></div>
    </div>

    <div class="card shadow-sm mb-3" id="bookingSummaryCard" style="display:none"><div class="card-header bg-white">Booking Summary</div><div class="card-body" id="bookingSummaryBody"></div></div>

    <div class="card shadow-sm mb-3"><div class="card-body">
        <div class="row g-3">
            <div class="col-md-4"><label class="form-label">Seats</label><select name="seats" class="form-select">${raw(Array.from({ length: maxSeats }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join(''))}</select></div>
            <div class="col-md-8"><label class="form-label">Purpose of Travel *</label><input type="text" name="purpose" class="form-control" required placeholder="e.g. Medical appointment, Day off, Bank errand"></div>
            <div class="col-12"><label class="form-label">Remarks</label><textarea name="remarks" class="form-control" rows="2"></textarea></div>
        </div>
    </div></div>

    <div class="card shadow-sm mb-3"><div class="card-body small text-muted">
        ${approvalWorkflowInfoHtml(workflowInfo)}
        <p class="mb-0">Maximum ${maxSeats} seat(s) per booking.</p>
    </div></div>

    <button type="submit" class="btn btn-primary" id="submitBtn" disabled>Submit Booking Request</button>
</form>`;
}

const BOOKING_PAGE_SCRIPT = `
(function () {
    // Falls back to '/' if window.BASE_URL somehow isn't set by the time
    // this runs (it's always just "/" in this app anyway - there's no
    // multi-tenant subpath deployment - so there's no reason a missing
    // global should ever break this fetch).
    var baseUrl = window.BASE_URL || '/';
    var form = document.getElementById('bookingForm');
    var filterForm = document.getElementById('filterForm');
    var bookingTypeRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="booking_type_radio"]'));
    var bookingTypeInput = document.getElementById('bookingTypeInput');
    var outboundGrid = document.getElementById('outboundGrid');
    var returnSection = document.getElementById('returnSection');
    var returnGrid = document.getElementById('returnGrid');
    var scheduleIdInput = document.getElementById('scheduleIdInput');
    var returnScheduleIdInput = document.getElementById('returnScheduleIdInput');
    var submitBtn = document.getElementById('submitBtn');
    var summaryCard = document.getElementById('bookingSummaryCard');
    var summaryBody = document.getElementById('bookingSummaryBody');
    if (!form || !outboundGrid) return;

    function isReturnMode() { return bookingTypeInput.value === 'same_day_return'; }
    function currentFilterQuery() { return new URLSearchParams(new FormData(filterForm)).toString(); }

    function wireOutboundRadios() {
        outboundGrid.querySelectorAll('input[name="outbound_radio"]').forEach(function (radio) {
            radio.addEventListener('change', onOutboundChange);
        });
    }
    function wireReturnRadios() {
        returnGrid.querySelectorAll('input[name="return_radio"]').forEach(function (radio) {
            radio.addEventListener('change', onReturnChange);
        });
    }

    function onOutboundChange() {
        var checked = outboundGrid.querySelector('input[name="outbound_radio"]:checked');
        scheduleIdInput.value = checked ? checked.value : '';
        returnScheduleIdInput.value = '';
        updateSummary();
        updateSubmitState();
        if (isReturnMode() && checked) loadReturnCards(checked.value);
    }
    function onReturnChange() {
        var checked = returnGrid.querySelector('input[name="return_radio"]:checked');
        returnScheduleIdInput.value = checked ? checked.value : '';
        updateSummary();
        updateSubmitState();
    }

    function loadReturnCards(outboundScheduleId) {
        var desiredReturnValue = returnScheduleIdInput.value;
        returnGrid.innerHTML = '<div class="col-12 text-muted small"><span class="spinner-border spinner-border-sm"></span> Loading return ferries...</div>';
        var qs = currentFilterQuery() + '&leg=return&outbound_schedule_id=' + encodeURIComponent(outboundScheduleId);
        fetch(baseUrl + 'ajax/booking_cards?' + qs)
            .then(function (r) { return r.text(); })
            .then(function (htmlText) {
                returnGrid.innerHTML = htmlText;
                wireReturnRadios();
                if (desiredReturnValue) {
                    var pre = returnGrid.querySelector('input[name="return_radio"][value="' + desiredReturnValue + '"]');
                    if (pre) pre.checked = true;
                }
                updateSummary();
                updateSubmitState();
            })
            .catch(function () {
                returnGrid.innerHTML = '<div class="col-12 text-danger small">Unable to load return ferries. <a href="#" class="retry-return">Retry</a></div>';
            });
    }

    function refreshOutboundCards() {
        var previouslyChecked = outboundGrid.querySelector('input[name="outbound_radio"]:checked');
        var previousValue = previouslyChecked ? previouslyChecked.value : null;
        var qs = currentFilterQuery() + '&leg=outbound';
        fetch(baseUrl + 'ajax/booking_cards?' + qs)
            .then(function (r) { return r.text(); })
            .then(function (htmlText) {
                outboundGrid.innerHTML = htmlText;
                wireOutboundRadios();
                if (previousValue) {
                    var stillThere = outboundGrid.querySelector('input[name="outbound_radio"][value="' + previousValue + '"]');
                    if (stillThere) stillThere.checked = true;
                }
            })
            .catch(function () { /* keep showing the last good data - a transient poll failure shouldn't blank the page */ });
    }

    function updateSubmitState() {
        var hasOutbound = !!scheduleIdInput.value;
        var hasReturn = !isReturnMode() || !!returnScheduleIdInput.value;
        submitBtn.disabled = !(hasOutbound && hasReturn);
        var anyFull = false;
        [outboundGrid, returnGrid].forEach(function (grid) {
            var checked = grid.querySelector('input:checked');
            if (checked && checked.getAttribute('data-full') === 'true') anyFull = true;
        });
        submitBtn.textContent = anyFull ? 'Join Waiting List' : 'Submit Booking Request';
    }

    function cardSummaryLine(prefix, radioName, gridEl) {
        var checked = gridEl.querySelector('input[name="' + radioName + '"]:checked');
        if (!checked) return '';
        return '<div class="mb-2"><strong>' + prefix + ':</strong> ' + checked.getAttribute('data-label') +
            '<br>' + checked.getAttribute('data-departure') + (checked.getAttribute('data-arrival') ? ' &rarr; ' + checked.getAttribute('data-arrival') : '') +
            (checked.getAttribute('data-duration') ? ' (' + checked.getAttribute('data-duration') + ' min)' : '') +
            '<br><span class="text-muted small">' + checked.getAttribute('data-available') + ' seat(s) available &middot; ' + checked.getAttribute('data-status') + '</span></div>';
    }
    function updateSummary() {
        var outboundLine = cardSummaryLine('Outbound Ferry', 'outbound_radio', outboundGrid);
        var returnLine = isReturnMode() ? cardSummaryLine('Return Ferry', 'return_radio', returnGrid) : '';
        if (!outboundLine && !returnLine) {
            summaryCard.style.display = 'none';
            return;
        }
        summaryBody.innerHTML = outboundLine + returnLine;
        summaryCard.style.display = '';
    }

    bookingTypeRadios.forEach(function (radio) {
        radio.addEventListener('change', function () {
            bookingTypeInput.value = radio.value;
            returnSection.style.display = isReturnMode() ? '' : 'none';
            returnScheduleIdInput.value = '';
            updateSummary();
            updateSubmitState();
            if (isReturnMode()) {
                var checkedOutbound = outboundGrid.querySelector('input[name="outbound_radio"]:checked');
                if (checkedOutbound) loadReturnCards(checkedOutbound.value);
            }
        });
    });

    outboundGrid.addEventListener('click', function (e) {
        if (e.target.closest('.retry-schedules')) { e.preventDefault(); refreshOutboundCards(); }
    });
    returnGrid.addEventListener('click', function (e) {
        if (e.target.closest('.retry-return')) {
            e.preventDefault();
            var checkedOutbound = outboundGrid.querySelector('input[name="outbound_radio"]:checked');
            if (checkedOutbound) loadReturnCards(checkedOutbound.value);
        }
    });

    wireOutboundRadios();

    // Restore state - either from a "Book Now" prefill or an error-path
    // re-render (prefillScheduleId/prefillReturnScheduleId/
    // prefillBookingType are already server-rendered into the hidden
    // inputs/checked radios at this point).
    if (scheduleIdInput.value) {
        var pre = outboundGrid.querySelector('input[name="outbound_radio"][value="' + scheduleIdInput.value + '"]');
        if (pre) pre.checked = true;
    }
    if (isReturnMode()) {
        returnSection.style.display = '';
        var checkedOutbound = outboundGrid.querySelector('input[name="outbound_radio"]:checked');
        if (checkedOutbound) loadReturnCards(checkedOutbound.value);
    }
    updateSummary();
    updateSubmitState();

    form.addEventListener('submit', function (e) {
        if (!scheduleIdInput.value) { e.preventDefault(); alert('Please select an outbound ferry.'); return; }
        if (isReturnMode() && !returnScheduleIdInput.value) { e.preventDefault(); alert('Please select a return ferry.'); return; }
    });

    // Lightweight auto-refresh of the outbound grid, paused while the
    // tab isn't visible - same pattern as the Live Ferry Availability
    // Dashboard's polling (routes/seat_availability.js).
    var REFRESH_MS = 20000;
    var timer = setInterval(function () { if (document.visibilityState === 'visible') refreshOutboundCards(); }, REFRESH_MS);
    window.addEventListener('beforeunload', function () { clearInterval(timer); });
})();`;

// ---------------------------------------------------------------------
// My bookings
// ---------------------------------------------------------------------
async function myBookingsBody(userId, statusFilter, csrfToken) {
    let query = db()
        .from('bookings')
        .select('booking_id, travel_date, direction, purpose, seats, created_at, status_id, booking_status(status_name, badge_color), ferry_schedule(departure_time)')
        .eq('user_id', userId)
        .order('travel_date', { ascending: false });
    if (statusFilter) query = query.eq('status_id', statusFilter);
    const bookings = unwrap(await query);

    const statuses = unwrap(await db().from('booking_status').select('status_id, status_name').order('status_id'));

    const rows = bookings
        .map((b) => {
            const cancellable = !['Cancelled', 'Rejected', 'Completed', 'Expired'].includes(b.booking_status.status_name);
            return html`<tr>
                <td>${formatDate(b.travel_date)}</td>
                <td>${formatTime(b.ferry_schedule.departure_time)}</td>
                <td>${b.direction}</td>
                <td>${b.purpose}</td>
                <td>${b.seats}</td>
                <td><span class="badge ${statusBadgeClass(b.booking_status.badge_color)}">${b.booking_status.status_name}</span></td>
                <td>${formatDateTime(b.created_at)}</td>
                <td>
                    ${cancellable
                        ? html`<form method="post" data-confirm="Cancel this booking?">
                            ${raw(csrfField(csrfToken))}
                            <input type="hidden" name="action" value="cancel">
                            <input type="hidden" name="booking_id" value="${b.booking_id}">
                            <button class="btn btn-sm btn-outline-danger">Cancel</button>
                        </form>`
                        : ''}
                    <a class="btn btn-sm btn-outline-secondary" target="_blank" href="/staff/print_confirmation?id=${b.booking_id}"><i class="bi bi-printer"></i></a>
                </td>
            </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-journal-text"></i> My Booking History</h5>
<div class="card shadow-sm mb-3">
    <div class="card-body">
        <form method="get" class="row g-2">
            <div class="col-md-3">
                <select name="status" class="form-select">
                    <option value="0">All Status</option>
                    ${raw(statuses.map((s) => `<option value="${s.status_id}" ${statusFilter == s.status_id ? 'selected' : ''}>${h(s.status_name)}</option>`).join(''))}
                </select>
            </div>
            <div class="col-md-2"><button class="btn btn-outline-primary btn-sm w-100" type="submit">Filter</button></div>
        </form>
    </div>
</div>
<div class="card shadow-sm">
    <div class="table-responsive">
        <table class="table table-hover mb-0 align-middle">
            <thead><tr><th>Date</th><th>Time</th><th>Ferry</th><th>Purpose</th><th>Seats</th><th>Status</th><th>Submitted</th><th></th></tr></thead>
            <tbody>${raw(rows || '<tr><td colspan="8" class="text-center text-muted py-4">No bookings yet.</td></tr>')}</tbody>
        </table>
    </div>
</div>`;
}

// ---------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------
async function profileBody({ profile, errors, csrfToken }) {
    return html`
<h5 class="mb-3"><i class="bi bi-person-circle"></i> My Profile</h5>
${errors.length ? html`<div class="alert alert-danger">${raw(errors.map((e) => `${e}<br>`).join(''))}</div>` : ''}
<div class="row g-3">
    <div class="col-lg-4">
        <div class="card shadow-sm text-center">
            <div class="card-body">
                ${profile.profile_picture
                    ? html`<img src="${profile.profile_picture}" class="rounded-circle mb-2" width="100" height="100" style="object-fit:cover;" alt="Profile photo">`
                    : html`<div class="avatar-circle mx-auto mb-2" style="width:80px;height:80px;font-size:2rem;">${profile.full_name.charAt(0).toUpperCase()}</div>`}
                <h6>${profile.full_name}</h6>
                <p class="text-muted small mb-0">${profile.roles?.role_name ?? ''}</p>
            </div>
        </div>
    </div>
    <div class="col-lg-8">
        <div class="card shadow-sm">
            <div class="card-body">
                <dl class="row small text-muted mb-3">
                    <dt class="col-sm-4">Employee ID</dt><dd class="col-sm-8">${profile.employee_id}</dd>
                    <dt class="col-sm-4">Username</dt><dd class="col-sm-8">${profile.username}</dd>
                    <dt class="col-sm-4">Department</dt><dd class="col-sm-8">${profile.departments?.department_name ?? '-'}</dd>
                    <dt class="col-sm-4">Designation</dt><dd class="col-sm-8">${profile.designation ?? '-'}</dd>
                </dl>
                <form method="post" enctype="multipart/form-data">
                    ${raw(csrfField(csrfToken))}
                    <div class="mb-3">
                        <label class="form-label">Email (optional)</label>
                        <input type="email" name="email" class="form-control" value="${profile.email ?? ''}">
                    </div>
                    <div class="mb-3">
                        <label class="form-label">Phone (optional)</label>
                        <input type="text" name="phone" class="form-control" value="${profile.phone ?? ''}">
                    </div>
                    <div class="mb-3">
                        <label class="form-label">Profile Picture</label>
                        <input type="file" name="profile_picture" class="form-control" accept=".jpg,.jpeg,.png,.webp">
                    </div>
                    <button type="submit" class="btn btn-primary">Save Changes</button>
                </form>
            </div>
        </div>
    </div>
</div>`;
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
export function registerStaffRoutes(router) {
    router.get('/staff/dashboard', async (request) => {
        const auth = await requirePermission(request, 'dashboard.view_staff', { pageTitle: 'My Dashboard' });
        if (auth.response) return auth.response;
        const body = await staffDashboardBody(auth.user.user_id, auth.user.full_name, auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'My Dashboard', path: '/staff/dashboard', bodyHtml: body });
    });

    router.get('/staff/book', async (request) => {
        const auth = await requirePermission(request, 'booking.create_own', { pageTitle: 'New Booking' });
        if (auth.response) return auth.response;

        const maxSeats = Number(await getSetting('max_seats_per_booking', 4));
        const url = new URL(request.url);
        const today = new Date().toISOString().slice(0, 10);
        const filters = {
            travelDate: url.searchParams.get('date') || today,
            q: url.searchParams.get('q') || '',
            resortName: url.searchParams.get('resort') || '',
            boardingLocation: url.searchParams.get('boarding') || '',
            destination: url.searchParams.get('destination') || '',
        };

        const bookerRows = unwrap(await db().from('users').select('department_id, resort_id').eq('user_id', auth.user.user_id).limit(1));
        const [workflowInfo, outboundCards, stopNameOptions, resorts] = await Promise.all([
            getApprovalWorkflowInfo(bookerRows[0]?.resort_id ?? null, bookerRows[0]?.department_id ?? null),
            getLiveFerryAvailability({ travelDate: filters.travelDate, filters }),
            getStopNameOptions(),
            getActiveResorts(),
        ]);

        // Optional pre-fill from the Live Ferry Seat Availability
        // Dashboard's "Book Now"/"Join Waiting List" links (?date=&direction=)
        // - only applied if it actually matches one of today's real
        // bookable cards, so a stale/tampered query param can't silently
        // pre-select something invalid.
        const prefillDirectionRaw = url.searchParams.get('direction') || '';
        const prefillCard = prefillDirectionRaw ? outboundCards.find((c) => c.label === prefillDirectionRaw) : null;

        const body = bookingFormBody({
            errors: [],
            maxSeats,
            workflowInfo,
            csrfToken: auth.user.csrf,
            filters,
            stopNameOptions,
            resorts,
            outboundCardsHtml: bookingCardsFragment(outboundCards, 'outbound'),
            prefillScheduleId: prefillCard ? String(prefillCard.scheduleId) : '',
        });
        return renderShellForRequest({
            request,
            auth,
            pageTitle: 'New Booking',
            path: '/staff/book',
            bodyHtml: body,
            extraScripts: BOOKING_PAGE_SCRIPT,
        });
    });

    router.post('/staff/book', async (request) => {
        const auth = await requirePermission(request, 'booking.create_own', { pageTitle: 'New Booking' });
        if (auth.response) return auth.response;
        const { user } = auth;

        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const maxSeats = Number(await getSetting('max_seats_per_booking', 4));
        const travelDate = form.travel_date || '';
        const bookingType = form.booking_type === 'same_day_return' ? 'same_day_return' : 'one_way';
        const outboundScheduleId = Number(form.schedule_id || 0);
        const returnScheduleId = Number(form.return_schedule_id || 0);
        const seats = Math.max(1, Math.min(maxSeats, Number(form.seats || 1)));
        const purpose = (form.purpose || '').trim();
        const remarks = (form.remarks || '').trim();

        const errors = [];
        const today = new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate) || travelDate < today) {
            errors.push('Please choose a valid, future travel date.');
        }
        if (!purpose) errors.push('Purpose of travel is required.');
        if (!outboundScheduleId) errors.push('Please select an outbound ferry.');
        if (bookingType === 'same_day_return' && !returnScheduleId) errors.push('Please select a return ferry.');

        // Re-validate both legs server-side - the client-side card grids
        // are advisory UI only, never trusted for the actual decision.
        let outboundCard = null;
        let returnCard = null;
        if (!errors.length) {
            const allCards = await getLiveFerryAvailability({ travelDate, filters: {} });
            outboundCard = allCards.find((c) => c.scheduleId === outboundScheduleId) ?? null;
            if (!outboundCard) errors.push('Please select a valid, active outbound ferry.');

            if (bookingType === 'same_day_return' && outboundCard) {
                returnCard = allCards.find((c) => c.scheduleId === returnScheduleId) ?? null;
                if (!returnCard) {
                    errors.push('Please select a valid, active return ferry.');
                } else {
                    const validReturn =
                        returnCard.boardingStopName === outboundCard.destinationStopName &&
                        returnCard.destinationStopName === outboundCard.boardingStopName &&
                        outboundCard.arrivalTime &&
                        returnCard.departureTime > outboundCard.arrivalTime;
                    if (!validReturn) errors.push('The selected return ferry is not a valid return for this outbound journey.');
                }
            }
        }

        // Overlap guard: a passenger can't be on two ferries whose
        // boarding-to-destination windows overlap on the same date.
        if (!errors.length) {
            const legsToCheck = bookingType === 'same_day_return' ? [outboundCard, returnCard] : [outboundCard];
            for (const leg of legsToCheck) {
                const window = await getStopTimeWindow(leg.scheduleId, travelDate);
                const overlap = await findOverlappingBooking({
                    userId: user.user_id,
                    travelDate,
                    firstDepartureInstant: window.firstDepartureInstant,
                    lastArrivalInstant: window.lastArrivalInstant,
                });
                if (overlap) {
                    errors.push(`This overlaps with an existing booking of yours on ${formatDate(travelDate)}.`);
                    break;
                }
            }
        }

        if (!errors.length) {
            try {
                const bookerRows = unwrap(await db().from('users').select('department_id, resort_id, full_name, email').eq('user_id', user.user_id).limit(1));
                const legs =
                    bookingType === 'same_day_return'
                        ? [
                              { card: outboundCard, legLabel: 'Outbound' },
                              { card: returnCard, legLabel: 'Return' },
                          ]
                        : [{ card: outboundCard, legLabel: null }];

                let anyWaitlisted = false;
                const waitingListStatusId = await getStatusId('Waiting List');
                for (const leg of legs) {
                    const legRemarks = leg.legLabel ? `Same-Day Return - ${leg.legLabel} leg.${remarks ? ' ' + remarks : ''}` : remarks;
                    const booking = await bookFerrySeat({
                        userId: user.user_id,
                        scheduleId: leg.card.scheduleId,
                        travelDate,
                        direction: leg.card.label,
                        purpose,
                        remarks: legRemarks,
                        seats,
                    });

                    // book_ferry_seat() waitlists (rather than rejects) a
                    // booking that can't get a seat - skip approval routing
                    // entirely for those; a waiting-list passenger only
                    // reaches Approved via a Security/Admin/HR promotion.
                    if (booking.status_id === waitingListStatusId) {
                        anyWaitlisted = true;
                        await createNotification(
                            user.user_id,
                            `This ferry (${leg.card.label}) is full - your booking has been placed on the waiting list and you will be notified if a seat opens up.`,
                            'booking',
                            booking.booking_id
                        );
                        await logActivity(user.user_id, 'Ferry booking placed on waiting list', `booking_id=${booking.booking_id}`, clientIp(request));
                        continue;
                    }

                    // Department-hierarchy routing if the booker's department
                    // has opted in; routeDepartmentApproval delegates to the
                    // untouched legacy GM->RM->HR chain otherwise.
                    await routeDepartmentApproval(booking.booking_id, bookerRows[0]?.resort_id ?? null, bookerRows[0]?.department_id ?? null);
                    await createNotification(user.user_id, 'Your ferry booking request has been submitted and is awaiting approval.', 'booking', booking.booking_id);
                    await logActivity(user.user_id, 'Submitted ferry booking', `booking_id=${booking.booking_id}`, clientIp(request));
                    deferBestEffort(
                        sendTemplatedEmail(
                            'booking_confirmation',
                            bookerRows[0]?.email,
                            {
                                full_name: bookerRows[0]?.full_name ?? '',
                                route_name: leg.card.label,
                                direction: leg.card.label,
                                travel_date: formatDate(travelDate),
                                departure_time: formatTime(leg.card.departureTime),
                                booking_id: booking.booking_id,
                            },
                            { relatedBookingId: booking.booking_id }
                        ),
                        'sendTemplatedEmail:booking_confirmation'
                    );
                }

                const message = anyWaitlisted
                    ? bookingType === 'same_day_return'
                        ? 'Booking submitted - one or both legs were placed on the waiting list where full.'
                        : 'This ferry is full - your booking has been placed on the waiting list.'
                    : bookingType === 'same_day_return'
                      ? 'Both legs of your same-day return booking were submitted and routed for approval.'
                      : 'Booking submitted successfully and routed for approval.';
                return redirectTo('/staff/my_bookings', { cookies: [auth.setCookie, flashSetCookie('success', message)].filter(Boolean) });
            } catch (err) {
                if (err.message === 'CAPACITY_EXCEEDED') {
                    errors.push('Not enough seats remaining on one of the selected ferries. Please choose another time.');
                } else {
                    errors.push(`Could not create booking: ${err.message}`);
                }
            }
        }

        const errorFilters = { travelDate: travelDate || today, q: '', resortName: '', boardingLocation: '', destination: '' };
        const errorBookerRows = unwrap(await db().from('users').select('department_id, resort_id').eq('user_id', user.user_id).limit(1));
        const [workflowInfo, outboundCards, stopNameOptions, resorts] = await Promise.all([
            getApprovalWorkflowInfo(errorBookerRows[0]?.resort_id ?? null, errorBookerRows[0]?.department_id ?? null),
            getLiveFerryAvailability({ travelDate: errorFilters.travelDate, filters: errorFilters }),
            getStopNameOptions(),
            getActiveResorts(),
        ]);
        const body = bookingFormBody({
            errors,
            maxSeats,
            workflowInfo,
            csrfToken: user.csrf,
            filters: errorFilters,
            stopNameOptions,
            resorts,
            outboundCardsHtml: bookingCardsFragment(outboundCards, 'outbound'),
            prefillScheduleId: outboundScheduleId ? String(outboundScheduleId) : '',
            prefillReturnScheduleId: returnScheduleId ? String(returnScheduleId) : '',
            prefillBookingType: bookingType,
        });
        return renderShellForRequest({
            request,
            auth,
            pageTitle: 'New Booking',
            path: '/staff/book',
            bodyHtml: body,
            extraScripts: BOOKING_PAGE_SCRIPT,
        });
    });

    router.get('/staff/my_bookings', async (request) => {
        const auth = await requirePermission(request, 'booking.view_own', { pageTitle: 'My Bookings' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const statusFilter = Number(url.searchParams.get('status') || 0);
        const body = await myBookingsBody(auth.user.user_id, statusFilter, auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'My Bookings', path: '/staff/my_bookings', bodyHtml: body });
    });

    router.post('/staff/my_bookings', async (request) => {
        const auth = await requirePermission(request, 'booking.cancel_own', { pageTitle: 'My Bookings' });
        if (auth.response) return auth.response;
        const { user } = auth;

        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        if (form.action === 'cancel') {
            const bookingId = Number(form.booking_id);
            const rows = unwrap(
                await db().from('bookings').select('booking_id, schedule_id, travel_date').eq('booking_id', bookingId).eq('user_id', user.user_id).limit(1)
            );
            if (rows.length) {
                const cancelledId = await getStatusId('Cancelled');
                unwrap(await db().from('bookings').update({ status_id: cancelledId }).eq('booking_id', bookingId));
                await logActivity(user.user_id, 'Cancelled booking', `booking_id=${bookingId}`, clientIp(request));
                await createNotification(user.user_id, 'Your ferry booking has been cancelled.', 'booking', bookingId);
                // A cancellation frees a seat - if this schedule/date has a
                // waiting list, prompt Security to consider promoting.
                await notifySecurityIfWaitingList(rows[0].schedule_id, rows[0].travel_date);
                return redirectTo('/staff/my_bookings', { cookies: [auth.setCookie, flashSetCookie('success', 'Booking cancelled.')].filter(Boolean) });
            }
            return redirectTo('/staff/my_bookings', { cookies: [auth.setCookie, flashSetCookie('error', 'Booking not found.')].filter(Boolean) });
        }
        return redirectTo('/staff/my_bookings', { cookies: [auth.setCookie] });
    });

    // Accessible to any logged-in role (not staff-only) - matches the PHP version.
    router.get('/staff/profile', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;

        const rows = unwrap(
            await db()
                .from('users')
                .select('user_id, employee_id, full_name, username, email, phone, profile_picture, designation, roles(role_name), departments(department_name)')
                .eq('user_id', auth.user.user_id)
                .limit(1)
        );
        const body = await profileBody({ profile: rows[0], errors: [], csrfToken: auth.user.csrf });
        return renderShellForRequest({ request, auth, pageTitle: 'My Profile', path: '/staff/profile', bodyHtml: body });
    });

    router.post('/staff/profile', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;
        const { user } = auth;

        const form = await request.formData();
        if (!verifyCsrf(user.csrf, form.get('csrf_token'))) return notFound();

        const errors = [];
        const update = {
            email: (form.get('email') || '').toString().trim() || null,
            phone: (form.get('phone') || '').toString().trim() || null,
        };

        const file = form.get('profile_picture');
        if (file && file.size > 0) {
            try {
                update.profile_picture = await uploadProfilePicture(file, user.user_id);
            } catch (err) {
                errors.push(err.message);
            }
        }

        if (!errors.length) {
            unwrap(await db().from('users').update(update).eq('user_id', user.user_id));
            await logActivity(user.user_id, 'Updated profile', null, clientIp(request));
            return redirectTo('/staff/profile', { cookies: [auth.setCookie, flashSetCookie('success', 'Profile updated.')].filter(Boolean) });
        }

        const rows = unwrap(
            await db()
                .from('users')
                .select('user_id, employee_id, full_name, username, email, phone, profile_picture, designation, roles(role_name), departments(department_name)')
                .eq('user_id', user.user_id)
                .limit(1)
        );
        const body = await profileBody({ profile: rows[0], errors, csrfToken: user.csrf });
        return renderShellForRequest({ request, auth, pageTitle: 'My Profile', path: '/staff/profile', bodyHtml: body });
    });

    router.get('/staff/print_confirmation', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;

        const url = new URL(request.url);
        const bookingId = Number(url.searchParams.get('id') || 0);
        const rows = unwrap(
            await db()
                .from('bookings')
                .select('booking_id, user_id, travel_date, direction, purpose, seats, booking_status(status_name), ferry_schedule(departure_time), users!bookings_user_id_fkey(full_name, employee_id)')
                .eq('booking_id', bookingId)
                .limit(1)
        );
        const booking = rows[0];
        if (!booking || (booking.user_id !== auth.user.user_id && auth.user.role_name !== ROLE_ADMIN)) {
            return notFound('Booking not found.');
        }

        const companyName = await getSetting('company_name', 'Staff Ferry Transfer Portal');
        const siteLogo = await getSetting('site_logo', '');
        const body = html`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Booking Confirmation #${booking.booking_id}</title>
<link href="/assets/vendor/bootstrap/bootstrap.min.css" rel="stylesheet"></head>
<body class="p-4"><div class="container" style="max-width: 600px;">
    <div class="text-center mb-4">${siteLogo ? html`<img src="${siteLogo}" alt="" style="max-height:60px;" class="mb-2 d-block mx-auto">` : ''}<h4>${companyName}</h4><p class="text-muted">Ferry Booking Confirmation</p></div>
    <table class="table table-bordered">
        <tr><th>Booking ID</th><td>#${booking.booking_id}</td></tr>
        <tr><th>Employee</th><td>${booking.users.full_name} (${booking.users.employee_id})</td></tr>
        <tr><th>Travel Date</th><td>${formatDate(booking.travel_date)}</td></tr>
        <tr><th>Departure Time</th><td>${formatTime(booking.ferry_schedule.departure_time)}</td></tr>
        <tr><th>Ferry</th><td>${booking.direction}</td></tr>
        <tr><th>Seats</th><td>${booking.seats}</td></tr>
        <tr><th>Purpose</th><td>${booking.purpose}</td></tr>
        <tr><th>Status</th><td>${booking.booking_status.status_name}</td></tr>
    </table>
    <div class="text-center no-print mt-3"><button class="btn btn-primary" onclick="window.print()">Print</button></div>
</div>
<style>@media print { .no-print { display: none; } }</style>
<script src="/assets/vendor/bootstrap/bootstrap.bundle.min.js"></script>
</body></html>`;
        return htmlResponse(body.toString());
    });
}
