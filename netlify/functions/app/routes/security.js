// Security Operations Module routes: dashboard, per-trip passenger
// manifest (check-in/departed/no-show/arrived), and waiting-list
// promotion. Business logic lives in security.js; this file stays thin,
// following the same route-file convention as transport.js/manager.js.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getRemainingSeatsBatch } from '../seats.js';
import { getWaitingList, promoteWaitingListBooking, recordMovement } from '../security.js';
import { getActiveResorts } from '../refData.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDate, formatTime, formatDateTime, statusBadgeClass, greeting } from '../format.js';
import { ROLE_ADMIN, ROLE_HR } from '../session.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MANIFEST_STATUSES = ['Approved', 'Checked-In', 'Departed', 'Arrived', 'Completed'];

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
                'booking_id, seats, checked_in_at, departed_at, arrived_at, users!bookings_user_id_fkey(full_name, employee_id, designation, resort_id, departments(department_name), resorts(resort_name)), booking_status!inner(status_name, badge_color)'
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

function manifestActionButtons({ booking, csrfToken, date, scheduleId }) {
    const status = booking.booking_status.status_name;
    const form = (action, label, btnClass, confirmMsg) => `
        <form method="post" class="d-inline"${confirmMsg ? ` data-confirm="${h(confirmMsg)}"` : ''}>
            ${csrfField(csrfToken)}<input type="hidden" name="action" value="${action}"><input type="hidden" name="booking_id" value="${booking.booking_id}">
            <input type="hidden" name="date" value="${date}"><input type="hidden" name="schedule_id" value="${scheduleId}">
            <button class="btn btn-sm ${btnClass}">${label}</button>
        </form>`;
    if (status === 'Approved') {
        return raw(form('check_in', 'Check-In', 'btn-outline-primary') + form('no_show', 'No Show', 'btn-outline-danger', 'Mark this passenger as a no-show? Their seat will be released.'));
    }
    if (status === 'Checked-In') {
        return raw(form('departed', 'Mark Departed', 'btn-outline-success') + form('no_show', 'No Show', 'btn-outline-danger', 'Mark this passenger as a no-show? Their seat will be released.'));
    }
    if (status === 'Departed') {
        return raw(form('arrived', 'Mark Arrived', 'btn-outline-info'));
    }
    return raw('<span class="text-muted small">-</span>');
}

async function manifestPageBody({ date, scheduleId, schedules, resortFilter, csrfToken }) {
    let manifest = scheduleId ? await manifestFor(scheduleId, date) : [];
    if (resortFilter) manifest = manifest.filter((p) => p.users.resort_id === resortFilter);
    const resorts = await getActiveResorts();
    const scheduleOptions = schedules
        .map((s) => `<option value="${s.schedule_id}" ${scheduleId === s.schedule_id ? 'selected' : ''}>${h(s.ferry_routes.direction)} - ${h(formatTime(s.departure_time))}</option>`)
        .join('');
    const resortOptions = resorts.map((r) => `<option value="${r.resort_id}" ${resortFilter === r.resort_id ? 'selected' : ''}>${h(r.resort_name)}</option>`).join('');

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
            <td class="text-nowrap">${manifestActionButtons({ booking: p, csrfToken, date, scheduleId })}</td>
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
${scheduleId
    ? html`<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
        <thead><tr><th>Employee ID</th><th>Name</th><th>Department</th><th>Designation</th><th>Resort</th><th>Booking Ref</th><th>Seats</th><th>Departed</th><th>Arrived</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${raw(rowsHtml || '<tr><td colspan="11" class="text-center text-muted py-4">No passengers on this manifest.</td></tr>')}</tbody>
    </table></div></div>`
    : ''}`;
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
        const body = await manifestPageBody({ date, scheduleId, schedules, resortFilter, csrfToken: auth.user.csrf });
        return renderShellForRequest({ request, auth, pageTitle: 'Passenger Manifest', path: '/security/manifest', bodyHtml: body });
    });

    router.post('/security/manifest', async (request) => {
        const auth = await requirePermission(request, 'security.manage_manifest', { pageTitle: 'Passenger Manifest' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const bookingId = Number(form.booking_id);
        const action = form.action;
        if (!['check_in', 'departed', 'no_show', 'arrived'].includes(action)) {
            return redirectTo('/security/dashboard', { cookies: [auth.setCookie] });
        }

        await recordMovement(bookingId, action, { officerId: user.user_id, remarks: (form.remarks || '').trim() || null });
        await logActivity(user.user_id, `Security: ${action}`, `booking_id=${bookingId}`, clientIp(request));

        return redirectTo(`/security/manifest?date=${form.date || ''}&schedule_id=${form.schedule_id || ''}`, {
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
