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
import { getWholeRouteDirections, getLegacyOnlyDirections } from '../ferryServices.js';

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

function bookingFormBody({ errors, maxSeats, routes, workflowInfo, csrfToken, prefillDate = '', prefillDirection = '' }) {
    return html`
<h5 class="mb-3"><i class="bi bi-plus-circle"></i> New Ferry Booking</h5>

${errors.length ? html`<div class="alert alert-danger">${raw(errors.map((e) => `${e}<br>`).join(''))}</div>` : ''}

<div class="row">
    <div class="col-lg-8">
        <div class="card shadow-sm">
            <div class="card-body">
                <form method="post" id="bookingForm">
                    ${raw(csrfField(csrfToken))}
                    <div class="row g-3">
                        <div class="col-md-6">
                            <label class="form-label">Travel Date *</label>
                            <input type="date" name="travel_date" id="travelDate" class="form-control" required min="${new Date().toISOString().slice(0, 10)}" value="${prefillDate}">
                        </div>
                        <div class="col-md-6">
                            <label class="form-label">Ferry *</label>
                            <select name="direction_select" id="direction" class="form-select" required>
                                <option value="">-- Select Ferry --</option>
                                ${raw(routes.map((r) => `<option value="${h(r.direction)}" ${r.direction === prefillDirection ? 'selected' : ''}>${h(r.direction)}</option>`).join(''))}
                            </select>
                        </div>
                        <div class="col-12">
                            <label class="form-label">Ferry Time *</label>
                            <div id="scheduleOptions" class="row g-2">
                                <div class="col-12 text-muted small">Select a date and ferry to view available times.</div>
                            </div>
                            <input type="hidden" name="schedule_id" id="scheduleId" required>
                        </div>
                        <div class="col-md-4">
                            <label class="form-label">Seats</label>
                            <select name="seats" class="form-select">
                                ${raw(Array.from({ length: maxSeats }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join(''))}
                            </select>
                        </div>
                        <div class="col-md-8">
                            <label class="form-label">Purpose of Travel *</label>
                            <input type="text" name="purpose" class="form-control" required placeholder="e.g. Medical appointment, Day off, Bank errand">
                        </div>
                        <div class="col-12">
                            <label class="form-label">Remarks</label>
                            <textarea name="remarks" class="form-control" rows="2"></textarea>
                        </div>
                    </div>
                    <button type="submit" class="btn btn-primary mt-3" id="submitBtn" disabled>Submit Booking Request</button>
                </form>
            </div>
        </div>
    </div>
    <div class="col-lg-4">
        <div class="card shadow-sm">
            <div class="card-body small text-muted">
                ${approvalWorkflowInfoHtml(workflowInfo)}
                <p class="mb-0">Maximum ${maxSeats} seat(s) per booking.</p>
            </div>
        </div>
    </div>
</div>`;
}

const BOOKING_PAGE_SCRIPT = `
(function () {
    // Falls back to '/' if window.BASE_URL somehow isn't set by the time
    // this runs (it's always just "/" in this app anyway - there's no
    // multi-tenant subpath deployment - so there's no reason a missing
    // global should ever break this fetch).
    var baseUrl = window.BASE_URL || '/';
    var dateInput = document.getElementById('travelDate');
    var directionSelect = document.getElementById('direction');
    var container = document.getElementById('scheduleOptions');
    var scheduleIdInput = document.getElementById('scheduleId');
    var submitBtn = document.getElementById('submitBtn');

    function loadSchedules() {
        scheduleIdInput.value = '';
        submitBtn.disabled = true;
        var date = dateInput.value, direction = directionSelect.value;
        if (!date || !direction) {
            container.innerHTML = '<div class="col-12 text-muted small">Select a date and ferry to view available times.</div>';
            return;
        }
        container.innerHTML = '<div class="col-12 text-muted small"><span class="spinner-border spinner-border-sm"></span> Loading...</div>';

        fetch(baseUrl + 'ajax/get_schedule_seats?date=' + encodeURIComponent(date) + '&direction=' + encodeURIComponent(direction))
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.success && res.message === 'Not authenticated') {
                    container.innerHTML = '<div class="col-12 text-danger small">Your session has expired. Please <a href="' + baseUrl + 'auth/login">log in again</a>.</div>';
                    return;
                }
                if (!res.success) {
                    container.innerHTML = '<div class="col-12 text-danger small">' + (res.message || 'Could not load ferry schedules.') +
                        ' <a href="#" class="retry-schedules">Retry</a></div>';
                    return;
                }
                if (!res.schedules || res.schedules.length === 0) {
                    container.innerHTML = '<div class="col-12 text-muted small">No ferries operate on the selected date.</div>';
                    return;
                }
                container.innerHTML = '';
                res.schedules.forEach(function (s) {
                    // A full schedule is still selectable - book_ferry_seat()
                    // auto-waitlists rather than rejecting, so blocking
                    // selection here would make the waiting list
                    // unreachable from self-service booking entirely.
                    var full = s.remaining <= 0;
                    var col = document.createElement('div');
                    col.className = 'col-md-4';
                    col.innerHTML =
                        '<label class="schedule-card" for="sch' + s.schedule_id + '">' +
                        '<input type="radio" name="schedule_radio" value="' + s.schedule_id + '" id="sch' + s.schedule_id + '" data-full="' + full + '">' +
                        '<span class="schedule-card-time">Departs ' + s.time_label + (s.arrival_label ? ' &middot; Arrives ' + s.arrival_label : '') + '</span>' +
                        '<span class="' + (full ? 'schedule-card-seats-waitlist' : 'schedule-card-seats-ok') + '">' + (full ? 'Full - Join Waiting List' : s.remaining + ' seats left') + '</span>' +
                        '<span class="schedule-card-booked">' + s.booked + ' / ' + s.capacity + ' booked</span>' +
                        (s.reserved > 0 ? '<span class="schedule-card-reserved">' + s.reserved + ' reserved</span>' : '') +
                        '</label>';
                    container.appendChild(col);
                });
                container.querySelectorAll('input[name="schedule_radio"]').forEach(function (radio) {
                    radio.addEventListener('change', function () {
                        scheduleIdInput.value = this.value;
                        submitBtn.textContent = this.getAttribute('data-full') === 'true' ? 'Join Waiting List' : 'Submit Booking Request';
                        submitBtn.disabled = false;
                    });
                });
            })
            .catch(function () {
                container.innerHTML = '<div class="col-12 text-danger small">Unable to reach the server. Check your connection and ' +
                    '<a href="#" class="retry-schedules">retry</a>.</div>';
            });
    }

    container.addEventListener('click', function (e) {
        if (e.target.closest('.retry-schedules')) {
            e.preventDefault();
            loadSchedules();
        }
    });

    dateInput.addEventListener('change', loadSchedules);
    directionSelect.addEventListener('change', loadSchedules);

    // Pre-filled from the Live Ferry Seat Availability Dashboard's "Book
    // Now"/"Join Waiting List" links - load the ferry-time cards
    // immediately rather than waiting for the user to touch a field.
    if (dateInput.value && directionSelect.value) loadSchedules();
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
        // Legacy ferry_routes-linked directions merged with Ferry Services'
        // whole-route directions (a service has no ferry_routes row at all,
        // route_id being NULL by design - see ferryServices.js's
        // getWholeRouteDirections header comment) - both are real, bookable
        // directions today.
        const legacyDirections = await getLegacyOnlyDirections();
        const serviceDirections = await getWholeRouteDirections();
        const directionNames = [...new Set([...legacyDirections, ...serviceDirections.map((d) => d.direction)])].sort();
        const routes = directionNames.map((direction) => ({ direction }));
        const bookerRows = unwrap(await db().from('users').select('department_id, resort_id').eq('user_id', auth.user.user_id).limit(1));
        const workflowInfo = await getApprovalWorkflowInfo(bookerRows[0]?.resort_id ?? null, bookerRows[0]?.department_id ?? null);

        // Optional pre-fill from the Live Ferry Seat Availability
        // Dashboard's "Book Now"/"Join Waiting List" links - only
        // applied if the value is actually one of today's real bookable
        // options, so a stale/tampered query param can't silently
        // pre-select something invalid.
        const url = new URL(request.url);
        const prefillDate = url.searchParams.get('date') || '';
        const prefillDirectionRaw = url.searchParams.get('direction') || '';
        const prefillDirection = directionNames.includes(prefillDirectionRaw) ? prefillDirectionRaw : '';

        const body = bookingFormBody({ errors: [], maxSeats, routes, workflowInfo, csrfToken: auth.user.csrf, prefillDate, prefillDirection });
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
        const scheduleId = Number(form.schedule_id || 0);
        const travelDate = form.travel_date || '';
        const seats = Math.max(1, Math.min(maxSeats, Number(form.seats || 1)));
        const purpose = (form.purpose || '').trim();
        const remarks = (form.remarks || '').trim();

        const errors = [];
        const today = new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate) || travelDate < today) {
            errors.push('Please choose a valid, future travel date.');
        }
        if (!purpose) errors.push('Purpose of travel is required.');

        let schedule = null;
        if (scheduleId) {
            const rows = unwrap(
                await db()
                    .from('ferry_schedule')
                    .select('schedule_id, departure_time, weekdays, service_name, ferry_routes(direction, route_name)')
                    .eq('schedule_id', scheduleId)
                    .eq('status', 'active')
                    .limit(1)
            );
            schedule = rows[0] ?? null;
        }
        if (!schedule) {
            errors.push('Please select a valid ferry schedule.');
        } else if (!errors.length) {
            const weekdayAbbr = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${travelDate}T00:00:00Z`).getUTCDay()];
            if (!schedule.weekdays.includes(weekdayAbbr)) {
                errors.push('The selected ferry does not operate on that day.');
            }
        }

        // A Ferry Service (admin_ferry_services.js) has no ferry_routes row
        // at all - route_id is NULL by design - so schedule.ferry_routes is
        // null for one. direction_select is what the employee actually
        // picked (and what the AJAX seat-check already validated against),
        // so it's the authoritative source. service_name comes before the
        // legacy ferry_routes join - a schedule that was migrated into a
        // Ferry Service keeps its old ferry_routes link, which goes stale
        // the moment the ferry is renamed via the Ferry Services page, so
        // showing it over the current service_name would display the
        // wrong ferry name.
        const directionLabel = schedule ? (form.direction_select || '').trim() || schedule.service_name || schedule.ferry_routes?.direction || '' : '';
        const routeNameLabel = schedule ? schedule.service_name || schedule.ferry_routes?.route_name || '' : '';

        if (!errors.length) {
            try {
                const booking = await bookFerrySeat({
                    userId: user.user_id,
                    scheduleId,
                    travelDate,
                    direction: directionLabel,
                    purpose,
                    remarks,
                    seats,
                });

                // book_ferry_seat() waitlists (rather than rejects) a booking
                // that can't get a seat - skip approval routing entirely for
                // those; a waiting-list passenger only reaches Approved via
                // a Security/Admin/HR promotion (see security.js).
                const waitingListStatusId = await getStatusId('Waiting List');
                if (booking.status_id === waitingListStatusId) {
                    await createNotification(
                        user.user_id,
                        'This ferry is full - your booking has been placed on the waiting list and you will be notified if a seat opens up.',
                        'booking',
                        booking.booking_id
                    );
                    await logActivity(user.user_id, 'Ferry booking placed on waiting list', `booking_id=${booking.booking_id}`, clientIp(request));
                    return redirectTo('/staff/my_bookings', {
                        cookies: [auth.setCookie, flashSetCookie('success', 'This ferry is full - your booking has been placed on the waiting list.')].filter(Boolean),
                    });
                }

                // Department-hierarchy routing if the booker's department has opted
                // in; routeDepartmentApproval delegates to the untouched legacy
                // GM->RM->HR chain otherwise (departmentId null also falls through
                // to legacy - nothing to look up).
                const bookerRows = unwrap(await db().from('users').select('department_id, resort_id, full_name, email').eq('user_id', user.user_id).limit(1));
                await routeDepartmentApproval(booking.booking_id, bookerRows[0]?.resort_id ?? null, bookerRows[0]?.department_id ?? null);
                await createNotification(user.user_id, 'Your ferry booking request has been submitted and is awaiting approval.', 'booking', booking.booking_id);
                await logActivity(user.user_id, 'Submitted ferry booking', `booking_id=${booking.booking_id}`, clientIp(request));
                deferBestEffort(
                    sendTemplatedEmail(
                        'booking_confirmation',
                        bookerRows[0]?.email,
                        {
                            full_name: bookerRows[0]?.full_name ?? '',
                            route_name: routeNameLabel,
                            direction: directionLabel,
                            travel_date: formatDate(travelDate),
                            departure_time: formatTime(schedule.departure_time),
                            booking_id: booking.booking_id,
                        },
                        { relatedBookingId: booking.booking_id }
                    ),
                    'sendTemplatedEmail:booking_confirmation'
                );

                return redirectTo('/staff/my_bookings', {
                    cookies: [auth.setCookie, flashSetCookie('success', 'Booking submitted successfully and routed for approval.')].filter(Boolean),
                });
            } catch (err) {
                if (err.message === 'CAPACITY_EXCEEDED') {
                    errors.push('Not enough seats remaining on this ferry. Please choose another time.');
                } else {
                    errors.push(`Could not create booking: ${err.message}`);
                }
            }
        }

        const errorPathLegacyDirections = await getLegacyOnlyDirections();
        const errorPathServiceDirections = await getWholeRouteDirections();
        const errorPathDirectionNames = [...new Set([...errorPathLegacyDirections, ...errorPathServiceDirections.map((d) => d.direction)])].sort();
        const routes = errorPathDirectionNames.map((direction) => ({ direction }));
        const errorPathBookerRows = unwrap(await db().from('users').select('department_id, resort_id').eq('user_id', user.user_id).limit(1));
        const workflowInfo = await getApprovalWorkflowInfo(errorPathBookerRows[0]?.resort_id ?? null, errorPathBookerRows[0]?.department_id ?? null);
        const body = bookingFormBody({ errors, maxSeats, routes, workflowInfo, csrfToken: user.csrf });
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
