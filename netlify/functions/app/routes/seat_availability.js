// Live Ferry Seat Availability Dashboard - open to every authenticated
// user regardless of role/permission (matches routes/misc.js's /help
// and /about: requireLogin only, no requirePermission), per spec. The
// "Book Now" CTA is the one thing gated per-user, on
// booking.create_own, since not every role that can VIEW availability
// can actually self-book (Security/HR/Administrator typically can't).
//
// Auto-refresh reuses this app's one established client-JS pattern
// (routes/staff.js's booking-form fetch()), just on a timer instead of
// on a field change - and returns a pre-rendered HTML fragment (same
// card-rendering function as the full page), not JSON, since this
// codebase has no client-side templating anywhere to hand JSON to.

import { requireLogin } from '../guards.js';
import { hasPermission } from '../permissions.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { formatTime, formatDateTime } from '../format.js';
import { htmlResponse } from '../response.js';
import { getLiveFerryAvailability } from '../seatAvailability.js';
import { getStopNameOptions } from '../ferryServices.js';
import { getActiveResorts } from '../refData.js';

const FERRY_STATUS_OPTIONS = ['Scheduled', 'Boarding', 'Departed', 'In Transit', 'Arrived', 'Delayed', 'Cancelled', 'Full', 'Completed'];

const FERRY_STATUS_BADGE = {
    Scheduled: 'bg-secondary',
    Boarding: 'bg-info text-dark',
    Departed: 'bg-primary',
    'In Transit': 'bg-primary',
    Arrived: 'bg-success',
    Delayed: 'bg-warning text-dark',
    Cancelled: 'bg-dark',
    Full: 'bg-danger',
    Completed: 'bg-success',
};

function statusSeatsHtml(statusSeats) {
    const rows = [
        ['Confirmed', statusSeats.confirmed],
        ['Pending Approval', statusSeats.pendingApproval],
        ['Waiting List', statusSeats.waitingList],
        ['Checked-In', statusSeats.checkedIn],
        ['Departed', statusSeats.departed],
        ['Arrived', statusSeats.arrived],
        ['No Show', statusSeats.noShow],
    ];
    return rows.map(([label, val]) => `<div class="d-flex justify-content-between small"><span class="text-muted">${label}</span><span>${val}</span></div>`).join('');
}

function resortBreakdownHtml(resortBreakdown, resortAllocation) {
    // Once an Administrator has configured a Resort Capacity Allocator
    // split for this service, show its authoritative allocated/booked/
    // reserved/available-per-resort numbers instead of the shared-pool
    // breakdown - the two are computed by different code paths
    // (resortCapacity.js's own RPC vs. this dashboard's own grouping),
    // so showing both would risk looking inconsistent.
    if (resortAllocation) {
        return `<div class="table-responsive"><table class="table table-sm mb-0">
            <thead><tr><th>Resort</th><th>Allocated</th><th>Booked</th><th>Reserved</th><th>Available</th></tr></thead>
            <tbody>${resortAllocation.map((r) => `<tr><td>${h(r.resort_name)}</td><td>${r.allocated}</td><td>${r.booked}</td><td>${r.reserved}</td><td>${r.remaining}</td></tr>`).join('')}</tbody>
        </table></div>
        <div class="form-text">Capacity split via the Resort Capacity Allocator.</div>`;
    }
    return `<div class="table-responsive"><table class="table table-sm mb-0">
        <thead><tr><th>Resort</th><th>Reserved</th><th>Occupied</th></tr></thead>
        <tbody>${resortBreakdown.map((r) => `<tr><td>${h(r.resortName)}</td><td>${r.reserved}</td><td>${r.occupied}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="form-text">Total capacity (${resortBreakdown[0]?.total ?? 0}) and available seats (${resortBreakdown[0]?.available ?? 0}) are a shared pool across both resorts on this ferry.</div>`;
}

function stopProgressHtml(stopProgress) {
    return `<div class="d-flex flex-wrap align-items-center gap-1 mb-0 small">${stopProgress
        .map((s) => {
            const cls = s.stopState === 'completed' ? 'text-muted text-decoration-line-through' : s.stopState === 'current' ? 'fw-bold text-primary' : 'text-body';
            const icon = s.stopState === 'completed' ? 'bi-check-circle' : s.stopState === 'current' ? 'bi-geo-alt-fill' : 'bi-circle';
            return `<span class="${cls}"><i class="bi ${icon}"></i> ${h(s.stop_name)}</span>`;
        })
        .join('<span class="text-muted">&rarr;</span>')}</div>`;
}

function ferryCardHtml(card, { travelDate, canBook }) {
    const badge = FERRY_STATUS_BADGE[card.ferryStatus] || 'bg-secondary';
    const bookHref = `/staff/book?date=${encodeURIComponent(travelDate)}&direction=${encodeURIComponent(card.label)}`;
    let bookingArea = '';
    if (card.cutoff?.closed) {
        // Booking cut-off has passed - no booking action at all, unlike
        // a "Full" ferry which still offers the waiting list.
        bookingArea = `<div class="text-center small text-danger fw-bold">🔴 Booking Closed at ${formatDateTime(card.cutoff.cutoffTime)}</div>`;
    } else if (canBook) {
        bookingArea =
            card.available > 0
                ? `<a href="${bookHref}" class="btn btn-primary btn-sm w-100"><i class="bi bi-ticket-perforated"></i> Book Now</a>`
                : `<a href="${bookHref}" class="btn btn-outline-danger btn-sm w-100"><i class="bi bi-hourglass-split"></i> Full - Join Waiting List</a>`;
    } else if (card.available <= 0) {
        bookingArea = `<div class="text-center small text-danger fw-bold">Full</div>`;
    }

    return `<div class="col-12 col-md-6 col-xl-4">
    <div class="card shadow-sm h-100">
        <img src="${h(card.imageUrl)}" alt="${h(card.serviceName ?? 'Ferry')}" loading="lazy" class="card-img-top" style="height:160px;object-fit:cover;">
        <div class="card-header bg-white d-flex justify-content-between align-items-start">
            <div>
                <div class="fw-bold">${h(card.serviceName ?? '-')}</div>
                <div class="text-muted small">${h(card.serviceCode ?? '-')}</div>
            </div>
            <span class="badge ${badge}">${h(card.ferryStatus)}</span>
        </div>
        <div class="card-body">
            <div class="small text-muted mb-2">${h(card.routeSnapshot)}</div>
            ${stopProgressHtml(card.stopProgress)}
            <div class="d-flex justify-content-between align-items-center my-2">
                <div><i class="bi bi-clock"></i> ${formatTime(card.departureTime)}${card.arrivalTime ? ' &rarr; ' + formatTime(card.arrivalTime) : ''}</div>
                <div>${card.indicator.emoji} <span class="small">${h(card.indicator.label)}</span></div>
            </div>
            <div class="row text-center g-1 mb-2">
                <div class="col"><div class="fw-bold">${card.capacity}</div><div class="text-muted small">Capacity</div></div>
                <div class="col"><div class="fw-bold">${card.available}</div><div class="text-muted small">Available</div></div>
                <div class="col"><div class="fw-bold">${card.booked}</div><div class="text-muted small">Booked</div></div>
                <div class="col"><div class="fw-bold">${card.reserved}</div><div class="text-muted small">Reserved</div></div>
            </div>
            <details class="mb-2"><summary class="small text-muted" style="cursor:pointer">Passenger Breakdown</summary>${statusSeatsHtml(card.statusSeats)}</details>
            <details class="mb-2"><summary class="small text-muted" style="cursor:pointer">By Resort</summary>${resortBreakdownHtml(card.resortBreakdown, card.resortAllocation)}</details>
            <div class="small mb-2">Booking: <span class="badge ${card.bookingStatus === 'Open' ? 'bg-success' : 'bg-danger'}">${h(card.bookingStatus)}</span></div>
            ${bookingArea}
        </div>
    </div>
</div>`;
}

function readFilters(url) {
    return {
        travelDate: url.searchParams.get('date') || new Date().toISOString().slice(0, 10),
        q: url.searchParams.get('q') || '',
        resortName: url.searchParams.get('resort') || '',
        status: url.searchParams.get('status') || '',
        departureTime: url.searchParams.get('departure_time') || '',
        boardingLocation: url.searchParams.get('boarding') || '',
        destination: url.searchParams.get('destination') || '',
    };
}

async function cardsGridHtml(filters, canBook) {
    let cards;
    try {
        cards = await getLiveFerryAvailability({ travelDate: filters.travelDate, filters });
    } catch (err) {
        // Real-time-update/sync failure - logged for System Administrator
        // troubleshooting via Vercel's function logs (console.error is
        // captured there). Not written to activity_logs: this endpoint
        // is polled every ~20s per open tab, and activity_logs is an
        // insert-only, never-purged table elsewhere in this app (see
        // routes/admin_activity_logs.js's own comment on that) - writing
        // a row per poll would be the one genuinely abusive growth
        // pattern in the whole portal.
        console.error('Live Ferry Seat Availability Dashboard query failed:', err?.message || err);
        return `<div class="col-12"><div class="alert alert-danger">Could not load live ferry availability. <a href="#" class="retry-availability">Retry</a></div></div>`;
    }
    if (!cards.length) {
        return `<div class="col-12"><div class="alert alert-secondary">No active ferry services match the selected date/filters.</div></div>`;
    }
    return cards.map((c) => ferryCardHtml(c, { travelDate: filters.travelDate, canBook })).join('');
}

const REFRESH_SCRIPT = `
(function () {
    var baseUrl = window.BASE_URL || '/';
    var grid = document.getElementById('ferryAvailabilityGrid');
    var filterForm = document.getElementById('availabilityFilters');
    var lastUpdatedEl = document.getElementById('availabilityLastUpdated');
    if (!grid || !filterForm) return;

    function currentQuery() {
        return new URLSearchParams(new FormData(filterForm)).toString();
    }

    function refresh() {
        fetch(baseUrl + 'ferry_availability/fragment?' + currentQuery())
            .then(function (r) { return r.text(); })
            .then(function (fragmentHtml) {
                grid.innerHTML = fragmentHtml;
                if (lastUpdatedEl) lastUpdatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
            })
            .catch(function () { /* keep showing the last good data - a transient poll failure shouldn't blank the page */ });
    }

    grid.addEventListener('click', function (e) {
        if (e.target.closest('.retry-availability')) {
            e.preventDefault();
            refresh();
        }
    });

    // Lightweight polling, paused while the tab isn't visible - avoids
    // hammering the function on every background tab left open.
    var REFRESH_MS = 20000;
    var timer = setInterval(function () {
        if (document.visibilityState === 'visible') refresh();
    }, REFRESH_MS);
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') refresh();
    });
    window.addEventListener('beforeunload', function () { clearInterval(timer); });
})();`;

async function availabilityPageBody({ filters, canBook, stopNameOptions, resorts }) {
    const gridHtml = await cardsGridHtml(filters, canBook);
    const resortOptionsHtml = resorts.map((r) => `<option value="${h(r.resort_name)}" ${filters.resortName === r.resort_name ? 'selected' : ''}>${h(r.resort_name)}</option>`).join('');
    const stopOptionsHtml = (selected) => stopNameOptions.map((name) => `<option value="${h(name)}" ${selected === name ? 'selected' : ''}>${h(name)}</option>`).join('');
    const statusOptionsHtml = FERRY_STATUS_OPTIONS.map((s) => `<option value="${s}" ${filters.status === s ? 'selected' : ''}>${s}</option>`).join('');

    return html`
<div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
    <h5 class="mb-0"><i class="bi bi-broadcast"></i> Live Ferry Seat Availability</h5>
    <span class="text-muted small" id="availabilityLastUpdated"></span>
</div>
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" id="availabilityFilters" class="row g-2">
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Travel Date</label><input type="date" name="date" class="form-control form-control-sm" value="${filters.travelDate}"></div>
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Search</label><input type="text" name="q" class="form-control form-control-sm" placeholder="Name, code, route" value="${h(filters.q)}"></div>
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Resort</label><select name="resort" class="form-select form-select-sm"><option value="">All Resorts</option>${raw(resortOptionsHtml)}</select></div>
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Status</label><select name="status" class="form-select form-select-sm"><option value="">All Statuses</option>${raw(statusOptionsHtml)}</select></div>
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Boarding Location</label><select name="boarding" class="form-select form-select-sm"><option value="">Any</option>${raw(stopOptionsHtml(filters.boardingLocation))}</select></div>
        <div class="col-6 col-md-2"><label class="form-label small mb-1">Destination</label><select name="destination" class="form-select form-select-sm"><option value="">Any</option>${raw(stopOptionsHtml(filters.destination))}</select></div>
        <div class="col-12"><button class="btn btn-sm btn-outline-primary" type="submit"><i class="bi bi-search"></i> Filter</button> <a href="/ferry_availability" class="btn btn-sm btn-outline-secondary">Reset</a></div>
    </form>
</div></div>
<div class="row g-3" id="ferryAvailabilityGrid">${raw(gridHtml)}</div>
<div class="mt-3 small text-muted"><span class="text-success">🟢</span> Available (more than 10 seats) &middot; <span>🟡</span> Limited (5-10) &middot; <span>🟠</span> Nearly Full (1-4) &middot; <span>🔴</span> Full (0)</div>`;
}

export function registerSeatAvailabilityRoutes(router) {
    router.get('/ferry_availability', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;

        const url = new URL(request.url);
        const filters = readFilters(url);
        const canBook = hasPermission(auth.user.perms, 'booking.create_own');
        const [stopNameOptions, resorts] = await Promise.all([getStopNameOptions(), getActiveResorts()]);

        const body = await availabilityPageBody({ filters, canBook, stopNameOptions, resorts });
        return renderShellForRequest({
            request,
            auth,
            pageTitle: 'Live Ferry Seat Availability',
            path: '/ferry_availability',
            bodyHtml: body,
            extraScripts: REFRESH_SCRIPT,
        });
    });

    // Polling target: same card grid, rendered standalone (no shell) -
    // this IS the "auto refresh without a full page reload" mechanism.
    router.get('/ferry_availability/fragment', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;

        const url = new URL(request.url);
        const filters = readFilters(url);
        const canBook = hasPermission(auth.user.perms, 'booking.create_own');
        const fragment = await cardsGridHtml(filters, canBook);
        return htmlResponse(fragment);
    });
}
