// Port of transport/passenger_list.php and transport/manifest_print.php
// (Phase 2 scope; schedules_view.js lands in Phase 3).

import { db, unwrap } from '../db.js';
import { requireRole, requireLogin } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { getSetting } from '../settings.js';
import { csvResponse, htmlResponse, notFound } from '../response.js';
import { formatDate, formatTime } from '../format.js';
import { ROLE_TRANSPORT, ROLE_ADMIN } from '../session.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function transportDashboardBody() {
    const today = new Date().toISOString().slice(0, 10);
    const schedules = await activeSchedulesForDate(today);

    let totalPassengers = 0;
    const tripRows = [];
    for (const s of schedules) {
        const rows = unwrap(
            await db()
                .from('bookings')
                .select('seats, booking_status!inner(status_name)')
                .eq('schedule_id', s.schedule_id)
                .eq('travel_date', today)
                .in('booking_status.status_name', ['Approved', 'Completed'])
        );
        const passengers = rows.reduce((sum, b) => sum + b.seats, 0);
        totalPassengers += passengers;
        tripRows.push({ ...s, passengers });
    }

    const tripsHtml = tripRows
        .map(
            (t) => html`<tr>
            <td>${formatTime(t.departure_time)}</td><td>${t.ferry_routes.direction}</td><td>${t.capacity}</td><td>${t.passengers}</td>
            <td>
                <a class="btn btn-sm btn-outline-primary" href="/transport/passenger_list?date=${today}&schedule_id=${t.schedule_id}">View</a>
                <a class="btn btn-sm btn-outline-secondary" target="_blank" href="/transport/manifest_print?date=${today}&schedule_id=${t.schedule_id}"><i class="bi bi-printer"></i></a>
            </td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3">Welcome</h5>
<div class="row g-3 mb-4">
    <div class="col-sm-6 col-lg-3"><div class="stat-card bg-grad-blue d-flex justify-content-between align-items-center"><div><div class="stat-value">${tripRows.length}</div><div class="stat-label">Today's Ferry Trips</div></div><i class="bi bi-water"></i></div></div>
    <div class="col-sm-6 col-lg-3"><div class="stat-card bg-grad-green d-flex justify-content-between align-items-center"><div><div class="stat-value">${totalPassengers}</div><div class="stat-label">Total Passengers Today</div></div><i class="bi bi-people"></i></div></div>
</div>
<div class="card shadow-sm">
    <div class="card-header bg-white d-flex justify-content-between"><span><i class="bi bi-list-check"></i> Today's Departures</span><a href="/transport/passenger_list" class="small">View Passenger Lists</a></div>
    <div class="table-responsive"><table class="table table-hover mb-0 align-middle">
        <thead><tr><th>Time</th><th>Direction</th><th>Capacity</th><th>Passengers</th><th></th></tr></thead>
        <tbody>${raw(tripsHtml || '<tr><td colspan="5" class="text-center text-muted py-3">No ferry trips scheduled for today.</td></tr>')}</tbody>
    </table></div>
</div>`;
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

async function passengersFor(scheduleId, travelDate) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, seats, purpose, users!bookings_user_id_fkey(full_name, employee_id, phone, departments(department_name)), booking_status!inner(status_name)')
            .eq('schedule_id', scheduleId)
            .eq('travel_date', travelDate)
            .in('booking_status.status_name', ['Approved', 'Completed'])
    );
    // Sorted in JS rather than via a PostgREST embedded-resource order
    // clause, which isn't reliably expressible through supabase-js's typed API.
    return rows.sort((a, b) => a.users.full_name.localeCompare(b.users.full_name));
}

export function registerTransportRoutes(router) {
    router.get('/transport/dashboard', async (request) => {
        const auth = await requireRole(request, [ROLE_TRANSPORT]);
        if (auth.response) return auth.response;
        const body = await transportDashboardBody();
        return renderShellForRequest({ request, auth, pageTitle: 'Transport Dashboard', path: '/transport/dashboard', bodyHtml: body });
    });

    router.get('/transport/passenger_list', async (request) => {
        const auth = await requireRole(request, [ROLE_TRANSPORT]);
        if (auth.response) return auth.response;

        const url = new URL(request.url);
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const scheduleId = Number(url.searchParams.get('schedule_id') || 0);

        const schedules = await activeSchedulesForDate(date);
        let passengers = [];
        if (scheduleId) passengers = await passengersFor(scheduleId, date);

        if (url.searchParams.get('format') === 'csv' && scheduleId) {
            const header = 'Employee,Employee ID,Department,Phone,Seats,Purpose\n';
            const rows = passengers
                .map((p) => [p.users.full_name, p.users.employee_id, p.users.departments?.department_name ?? '', p.users.phone ?? '', p.seats, p.purpose].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
                .join('\n');
            return csvResponse(header + rows, `passenger_list_${date}.csv`);
        }

        const scheduleOptions = schedules
            .map((s) => `<option value="${s.schedule_id}" ${scheduleId === s.schedule_id ? 'selected' : ''}>${h(s.ferry_routes.direction)} - ${h(formatTime(s.departure_time))}</option>`)
            .join('');

        const passengerRows = passengers
            .map(
                (p, i) => html`<tr>
                <td>${i + 1}</td>
                <td>${p.users.full_name}</td>
                <td>${p.users.employee_id}</td>
                <td>${p.users.departments?.department_name ?? '-'}</td>
                <td>${p.users.phone ?? '-'}</td>
                <td>${p.seats}</td>
                <td>${p.purpose}</td>
            </tr>`
            )
            .map((r) => r.toString())
            .join('');

        const body = html`
<h5 class="mb-3"><i class="bi bi-list-check"></i> Passenger List</h5>
<div class="card shadow-sm mb-3">
    <div class="card-body">
        <form method="get" class="row g-2">
            <div class="col-md-3">
                <label class="form-label">Date</label>
                <input type="date" name="date" class="form-control" value="${date}">
            </div>
            <div class="col-md-4">
                <label class="form-label">Ferry Schedule</label>
                <select name="schedule_id" class="form-select">
                    <option value="0">-- Select Departure --</option>
                    ${raw(scheduleOptions)}
                </select>
            </div>
            <div class="col-md-2 d-flex align-items-end"><button class="btn btn-outline-primary btn-sm w-100" type="submit">View</button></div>
        </form>
    </div>
</div>
${scheduleId
    ? html`<div class="card shadow-sm">
        <div class="card-header bg-white d-flex justify-content-between align-items-center">
            <span>Passengers: ${passengers.length}</span>
            <div class="d-flex gap-2">
                <input type="text" id="searchPassenger" class="form-control form-control-sm" placeholder="Search passenger...">
                <a class="btn btn-sm btn-outline-success" href="?date=${date}&schedule_id=${scheduleId}&format=csv"><i class="bi bi-file-earmark-excel"></i> Export</a>
                <a class="btn btn-sm btn-outline-secondary" target="_blank" href="/transport/manifest_print?date=${date}&schedule_id=${scheduleId}"><i class="bi bi-printer"></i> Print</a>
            </div>
        </div>
        <div class="table-responsive">
            <table class="table table-hover mb-0 align-middle" id="passengerTable">
                <thead><tr><th>#</th><th>Employee</th><th>Employee ID</th><th>Department</th><th>Phone</th><th>Seats</th><th>Purpose</th></tr></thead>
                <tbody>${raw(passengerRows || '<tr><td colspan="7" class="text-center text-muted py-4">No approved passengers for this departure.</td></tr>')}</tbody>
            </table>
        </div>
    </div>`
    : ''}`;

        return renderShellForRequest({
            request,
            auth,
            pageTitle: 'Passenger List',
            path: '/transport/passenger_list',
            bodyHtml: body,
            extraScripts: `initTableSearch('searchPassenger', 'passengerTable');`,
        });
    });

    router.get('/transport/manifest_print', async (request) => {
        const auth = await requireRole(request, [ROLE_TRANSPORT, ROLE_ADMIN]);
        if (auth.response) return auth.response;

        const url = new URL(request.url);
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const scheduleId = Number(url.searchParams.get('schedule_id') || 0);

        const scheduleRows = unwrap(
            await db().from('ferry_schedule').select('departure_time, capacity, ferry_routes(direction)').eq('schedule_id', scheduleId).limit(1)
        );
        const schedule = scheduleRows[0];
        if (!schedule) return notFound('Schedule not found.');

        const passengers = await passengersFor(scheduleId, date);
        const totalSeats = passengers.reduce((sum, p) => sum + p.seats, 0);
        const companyName = await getSetting('company_name', 'Staff Ferry Transfer Portal');

        const rows = passengers
            .map(
                (p, i) => html`<tr>
                <td>${i + 1}</td><td>${p.users.full_name}</td><td>${p.users.employee_id}</td>
                <td>${p.users.departments?.department_name ?? '-'}</td><td>${p.seats}</td><td>${p.purpose}</td>
            </tr>`
            )
            .map((r) => r.toString())
            .join('');

        const body = html`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Passenger Manifest - ${date}</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet"></head>
<body class="p-4"><div class="container">
    <div class="text-center mb-4">
        <h4>${companyName}</h4>
        <p class="text-muted mb-0">Ferry Passenger Manifest</p>
        <p><strong>${schedule.ferry_routes.direction}</strong> &middot; ${formatDate(date)} &middot; Departure: ${formatTime(schedule.departure_time)}</p>
    </div>
    <table class="table table-bordered">
        <thead><tr><th>#</th><th>Employee Name</th><th>Employee ID</th><th>Department</th><th>Seats</th><th>Purpose</th></tr></thead>
        <tbody>${raw(rows)}</tbody>
        <tfoot><tr><th colspan="4" class="text-end">Total Passengers / Seats:</th><th colspan="2">${passengers.length} / ${totalSeats} of ${schedule.capacity}</th></tr></tfoot>
    </table>
    <div class="text-center no-print mt-3"><button class="btn btn-primary" onclick="window.print()">Print</button></div>
</div>
<style>@media print { .no-print { display: none; } }</style>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</body></html>`;
        return htmlResponse(body.toString());
    });
}
