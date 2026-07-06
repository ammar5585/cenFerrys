// Port of admin/reports.php and manager/reports.php - filterable booking
// reports with CSV export. "Export to PDF" is the browser's print
// dialog (same as the PHP version); "Export to Excel" is the same CSV,
// which Excel opens natively.
//
// The admin/HR scope additionally offers the Security Operations
// Module's 8 reports via a report_type selector - each one is a
// { fetchRows, columns } definition so the HTML table and CSV export
// are always driven from the same column list (no risk of the two
// drifting apart). The original generic Booking Report is report_type
// 'booking' (the default) and its rendering/CSV path is unchanged.
// The manager scope (GM/RM/HR, limited filters) is untouched.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csvResponse } from '../response.js';
import { getSetting } from '../settings.js';
import { formatDate, formatTime, formatDateTime } from '../format.js';
import { getAllDepartments, getAllResorts } from '../refData.js';

async function fetchReportRows({ dateFrom, dateTo, deptFilter, resortFilter, empFilter, routeFilter, statusFilter, purpose }) {
    let query = db()
        .from('bookings')
        .select(
            'booking_id, travel_date, purpose, seats, users!bookings_user_id_fkey(user_id, full_name, department_id, resort_id, departments(department_name), resorts(resort_name)), ferry_schedule(departure_time, route_id, ferry_routes(route_id, direction)), booking_status(status_name), current_approver_id, approver:current_approver_id(full_name)'
        )
        .order('travel_date', { ascending: false });
    if (dateFrom) query = query.gte('travel_date', dateFrom);
    if (dateTo) query = query.lte('travel_date', dateTo);
    if (statusFilter) query = query.eq('status_id', statusFilter);
    let rows = unwrap(await query);

    if (deptFilter) rows = rows.filter((r) => r.users.department_id === deptFilter);
    if (resortFilter) rows = rows.filter((r) => r.users.resort_id === resortFilter);
    if (empFilter) rows = rows.filter((r) => r.users.user_id === empFilter);
    if (routeFilter) rows = rows.filter((r) => r.ferry_schedule.ferry_routes.route_id === routeFilter);
    if (purpose) rows = rows.filter((r) => r.purpose.toLowerCase().includes(purpose.toLowerCase()));

    return rows;
}

// ---------------------------------------------------------------------
// Security Operations Module reports - shared bookings-with-movement
// select, filtered by status/date/department/resort/route, each just a
// different status-set + column list over the same underlying data
// (or, for the two audit reports, security_action_log instead).
// ---------------------------------------------------------------------
async function fetchBookingsByStatus(statusNames, { dateFrom, dateTo, deptFilter, resortFilter, routeFilter }) {
    let query = db()
        .from('bookings')
        .select(
            'booking_id, travel_date, seats, checked_in_at, departed_at, arrived_at, users!bookings_user_id_fkey(full_name, employee_id, department_id, resort_id, departments(department_name), resorts(resort_name)), ferry_schedule(departure_time, route_id, ferry_routes(route_id, direction)), booking_status!inner(status_name)'
        )
        .in('booking_status.status_name', statusNames)
        .order('travel_date', { ascending: false });
    if (dateFrom) query = query.gte('travel_date', dateFrom);
    if (dateTo) query = query.lte('travel_date', dateTo);
    let rows = unwrap(await query);
    if (deptFilter) rows = rows.filter((r) => r.users.department_id === deptFilter);
    if (resortFilter) rows = rows.filter((r) => r.users.resort_id === resortFilter);
    if (routeFilter) rows = rows.filter((r) => r.ferry_schedule.ferry_routes.route_id === routeFilter);
    return rows;
}

async function fetchSecurityActionLog({ dateFrom, dateTo, deptFilter, resortFilter }) {
    let query = db()
        .from('security_action_log')
        .select(
            'log_id, action, remarks, created_at, promotion_method, promotion_reason, security_officer:security_officer_id(full_name), booking:booking_id(booking_id, travel_date, users!bookings_user_id_fkey(full_name, employee_id, department_id, resort_id, departments(department_name), resorts(resort_name))), previous_status:previous_status_id(status_name), new_status:new_status_id(status_name)'
        )
        .order('created_at', { ascending: false })
        .limit(1000);
    if (dateFrom) query = query.gte('created_at', dateFrom);
    if (dateTo) query = query.lte('created_at', `${dateTo}T23:59:59`);
    let rows = unwrap(await query);
    if (deptFilter) rows = rows.filter((r) => r.booking?.users?.department_id === deptFilter);
    if (resortFilter) rows = rows.filter((r) => r.booking?.users?.resort_id === resortFilter);
    return rows;
}

async function fetchFerryOccupancy({ dateFrom, dateTo, routeFilter }) {
    let schedQuery = db().from('ferry_schedule').select('schedule_id, departure_time, capacity, ferry_routes(route_id, direction)').eq('status', 'active');
    let schedules = unwrap(await schedQuery);
    if (routeFilter) schedules = schedules.filter((s) => s.ferry_routes.route_id === routeFilter);

    const from = dateFrom || new Date().toISOString().slice(0, 10);
    const to = dateTo || from;
    const rows = [];
    // One query for every schedule's bookings across the whole date
    // range, instead of one query per schedule - grouped in JS below
    // (same per-schedule/per-date aggregation as before, just batched).
    const excluded = ['Rejected', 'Cancelled', 'Expired', 'Waiting List'];
    const allBookingRows = schedules.length
        ? unwrap(
              await db()
                  .from('bookings')
                  .select('schedule_id, travel_date, seats, booking_status(status_name)')
                  .in('schedule_id', schedules.map((s) => s.schedule_id))
                  .gte('travel_date', from)
                  .lte('travel_date', to)
          )
        : [];
    const byScheduleId = new Map();
    for (const b of allBookingRows) {
        if (excluded.includes(b.booking_status.status_name)) continue;
        if (!byScheduleId.has(b.schedule_id)) byScheduleId.set(b.schedule_id, new Map());
        const byDate = byScheduleId.get(b.schedule_id);
        byDate.set(b.travel_date, (byDate.get(b.travel_date) || 0) + b.seats);
    }
    for (const s of schedules) {
        const byDate = byScheduleId.get(s.schedule_id) || new Map();
        for (const [travelDate, booked] of byDate.entries()) {
            rows.push({ schedule: s, travelDate, booked, capacity: s.capacity, occupancyPct: Math.round((booked / s.capacity) * 100) });
        }
    }
    return rows.sort((a, b) => (a.travelDate < b.travelDate ? 1 : -1));
}

/**
 * Each report_type maps to how to fetch its rows and how to render
 * them as both an HTML table and a CSV - one column list drives both,
 * so they can never drift apart.
 */
const REPORT_TYPES = {
    daily_departure: {
        label: 'Daily Departure Report',
        fetchRows: (f) => fetchBookingsByStatus(['Approved', 'Checked-In', 'Departed', 'Arrived', 'Completed'], f),
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Department', get: (r) => r.users.departments?.department_name ?? '' },
            { header: 'Resort', get: (r) => r.users.resorts?.resort_name ?? '' },
            { header: 'Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Departure Time', get: (r) => formatTime(r.ferry_schedule.departure_time) },
            { header: 'Route', get: (r) => r.ferry_schedule.ferry_routes.direction },
            { header: 'Seats', get: (r) => r.seats },
            { header: 'Status', get: (r) => r.booking_status.status_name },
        ],
    },
    daily_arrival: {
        label: 'Daily Arrival Report',
        fetchRows: (f) => fetchBookingsByStatus(['Arrived', 'Completed'], f),
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Department', get: (r) => r.users.departments?.department_name ?? '' },
            { header: 'Resort', get: (r) => r.users.resorts?.resort_name ?? '' },
            { header: 'Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Route', get: (r) => r.ferry_schedule.ferry_routes.direction },
            { header: 'Arrival Time', get: (r) => (r.arrived_at ? formatDateTime(r.arrived_at) : '-') },
            { header: 'Status', get: (r) => r.booking_status.status_name },
        ],
    },
    passenger_manifest: {
        label: 'Passenger Manifest',
        fetchRows: (f) => fetchBookingsByStatus(['Approved', 'Checked-In', 'Departed', 'Arrived', 'Completed'], f),
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Department', get: (r) => r.users.departments?.department_name ?? '' },
            { header: 'Resort', get: (r) => r.users.resorts?.resort_name ?? '' },
            { header: 'Booking Ref', get: (r) => `BK-${r.booking_id}` },
            { header: 'Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Route', get: (r) => r.ferry_schedule.ferry_routes.direction },
            { header: 'Departure Time', get: (r) => formatTime(r.ferry_schedule.departure_time) },
            { header: 'Seats', get: (r) => r.seats },
            { header: 'Status', get: (r) => r.booking_status.status_name },
        ],
    },
    waiting_list_report: {
        label: 'Waiting List Report',
        fetchRows: (f) => fetchBookingsByStatus(['Waiting List'], f),
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Department', get: (r) => r.users.departments?.department_name ?? '' },
            { header: 'Resort', get: (r) => r.users.resorts?.resort_name ?? '' },
            { header: 'Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Route', get: (r) => r.ferry_schedule.ferry_routes.direction },
            { header: 'Seats Requested', get: (r) => r.seats },
        ],
    },
    no_show_report: {
        label: 'No Show Report',
        fetchRows: (f) => fetchBookingsByStatus(['No Show'], f),
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Department', get: (r) => r.users.departments?.department_name ?? '' },
            { header: 'Resort', get: (r) => r.users.resorts?.resort_name ?? '' },
            { header: 'Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Route', get: (r) => r.ferry_schedule.ferry_routes.direction },
            { header: 'Departure Time', get: (r) => formatTime(r.ferry_schedule.departure_time) },
        ],
    },
    ferry_occupancy: {
        label: 'Ferry Occupancy Report',
        fetchRows: (f) => fetchFerryOccupancy(f),
        columns: [
            { header: 'Date', get: (r) => formatDate(r.travelDate) },
            { header: 'Route', get: (r) => r.schedule.ferry_routes.direction },
            { header: 'Departure Time', get: (r) => formatTime(r.schedule.departure_time) },
            { header: 'Capacity', get: (r) => r.capacity },
            { header: 'Booked', get: (r) => r.booked },
            { header: 'Occupancy %', get: (r) => `${r.occupancyPct}%` },
        ],
    },
    security_activity: {
        label: 'Security Activity Report',
        fetchRows: (f) => fetchSecurityActionLog(f),
        columns: [
            { header: 'Booking Ref', get: (r) => `BK-${r.booking?.booking_id ?? ''}` },
            { header: 'Employee', get: (r) => r.booking?.users?.full_name ?? '-' },
            { header: 'Department', get: (r) => r.booking?.users?.departments?.department_name ?? '-' },
            { header: 'Resort', get: (r) => r.booking?.users?.resorts?.resort_name ?? '-' },
            { header: 'Action', get: (r) => r.action },
            { header: 'Previous Status', get: (r) => r.previous_status?.status_name ?? '-' },
            { header: 'New Status', get: (r) => r.new_status?.status_name ?? '-' },
            { header: 'Security Officer', get: (r) => r.security_officer?.full_name ?? '-' },
            { header: 'Remarks', get: (r) => r.remarks ?? '' },
            { header: 'Date/Time', get: (r) => formatDateTime(r.created_at) },
        ],
    },
    passenger_movement_history: {
        label: 'Passenger Movement History',
        fetchRows: (f) => fetchBookingsByStatus(['Checked-In', 'Departed', 'Arrived', 'Completed', 'No Show'], f),
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Booking Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Route', get: (r) => r.ferry_schedule.ferry_routes.direction },
            { header: 'Checked-In', get: (r) => (r.checked_in_at ? formatDateTime(r.checked_in_at) : '-') },
            { header: 'Departed', get: (r) => (r.departed_at ? formatDateTime(r.departed_at) : '-') },
            { header: 'Arrived', get: (r) => (r.arrived_at ? formatDateTime(r.arrived_at) : '-') },
            { header: 'Current Status', get: (r) => r.booking_status.status_name },
        ],
    },
};

function genericReportBody({ reportType, rows, filters, filterOptions, basePath, companyName, siteLogo }) {
    const def = REPORT_TYPES[reportType];
    const { departments, resorts, routes } = filterOptions;

    const rowsHtml = rows
        .map((r) => html`<tr>${raw(def.columns.map((c) => `<td>${h(String(c.get(r) ?? ''))}</td>`).join(''))}</tr>`)
        .map((r) => r.toString())
        .join('');

    return html`
<div class="print-masthead d-none text-center mb-3">
    ${siteLogo ? html`<img src="${siteLogo}" alt="" style="max-height:60px;" class="mb-2 d-block mx-auto">` : ''}
    <h4>${companyName}</h4>
    <p class="text-muted mb-0">${def.label}</p>
</div>
<h5 class="mb-3"><i class="bi bi-graph-up"></i> Reports</h5>
${reportTypeSelector(reportType)}
<div class="card shadow-sm mb-3 no-print"><div class="card-body">
    <form method="get" class="row g-2">
        <input type="hidden" name="report_type" value="${reportType}">
        <div class="col-md-2"><input type="date" name="date_from" class="form-control" value="${filters.dateFrom}"></div>
        <div class="col-md-2"><input type="date" name="date_to" class="form-control" value="${filters.dateTo}"></div>
        <div class="col-md-2"><select name="department" class="form-select"><option value="0">All Departments</option>${raw(departments.map((d) => `<option value="${d.department_id}" ${filters.deptFilter == d.department_id ? 'selected' : ''}>${h(d.department_name)}</option>`).join(''))}</select></div>
        <div class="col-md-2"><select name="resort" class="form-select"><option value="0">All Resorts</option>${raw(resorts.map((rt) => `<option value="${rt.resort_id}" ${filters.resortFilter == rt.resort_id ? 'selected' : ''}>${h(rt.resort_name)}</option>`).join(''))}</select></div>
        <div class="col-md-2"><select name="route" class="form-select"><option value="0">All Routes</option>${raw(routes.map((rt) => `<option value="${rt.route_id}" ${filters.routeFilter == rt.route_id ? 'selected' : ''}>${h(rt.direction)}</option>`).join(''))}</select></div>
        <div class="col-md-9 d-flex align-items-end gap-2 mt-2">
            <button class="btn btn-outline-primary btn-sm" type="submit"><i class="bi bi-search"></i> Run Report</button>
            <a class="btn btn-outline-success btn-sm" href="${basePath}?${filters.queryString}&report_type=${reportType}&format=csv"><i class="bi bi-file-earmark-excel"></i> Export CSV / Excel</a>
            <button type="button" class="btn btn-outline-secondary btn-sm" onclick="window.print()"><i class="bi bi-file-earmark-pdf"></i> Export PDF (Print)</button>
        </div>
    </form>
</div></div>
<div class="card shadow-sm">
    <div class="card-header bg-white">Results: ${rows.length} record(s)</div>
    <div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
        <thead><tr>${raw(def.columns.map((c) => `<th>${h(c.header)}</th>`).join(''))}</tr></thead>
        <tbody>${raw(rowsHtml || `<tr><td colspan="${def.columns.length}" class="text-center text-muted py-4">No results for the selected filters.</td></tr>`)}</tbody>
    </table></div>
</div>
<style>@media print { .no-print, .sidebar, .topbar, .portal-banner { display: none !important; } .main-content { margin-left: 0 !important; } .print-masthead { display: block !important; } }</style>`;
}

function genericReportCsv(reportType, rows) {
    const def = REPORT_TYPES[reportType];
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = def.columns.map((c) => escape(c.header)).join(',') + '\n';
    const body = rows.map((r) => def.columns.map((c) => escape(c.get(r))).join(',')).join('\n');
    return header + body;
}

function reportTypeSelector(current) {
    const options = [
        { value: 'booking', label: 'Booking Report' },
        ...Object.entries(REPORT_TYPES).map(([value, def]) => ({ value, label: def.label })),
    ];
    return html`
<div class="mb-3 no-print">
    <form method="get" class="d-inline">
        <select name="report_type" class="form-select form-select-sm d-inline-block w-auto" onchange="this.form.submit()">
            ${raw(options.map((o) => `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${h(o.label)}</option>`).join(''))}
        </select>
    </form>
</div>`;
}

function reportPageBody({ rows, filters, filterOptions, scope, basePath, companyName, siteLogo }) {
    const { departments, employees, routes, statuses } = filterOptions;
    const showFullFilters = scope === 'admin';

    const rowsHtml = rows
        .map(
            (r) => html`<tr>
            <td>#${r.booking_id}</td><td>${r.users.full_name}</td>
            <td>${r.users.departments?.department_name ?? '-'}</td>
            <td>${formatDate(r.travel_date)}</td><td>${formatTime(r.ferry_schedule.departure_time)}</td>
            <td>${r.ferry_schedule.ferry_routes.direction}</td><td>${r.purpose}</td>
            <td>${r.booking_status.status_name}</td><td>${r.seats}</td>
            ${showFullFilters ? html`<td>${r.approver?.full_name ?? '-'}</td>` : ''}
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<div class="print-masthead d-none text-center mb-3">
    ${siteLogo ? html`<img src="${siteLogo}" alt="" style="max-height:60px;" class="mb-2 d-block mx-auto">` : ''}
    <h4>${companyName}</h4>
    <p class="text-muted mb-0">Booking Report</p>
</div>
<h5 class="mb-3"><i class="bi bi-graph-up"></i> Reports</h5>
${showFullFilters ? reportTypeSelector('booking') : ''}
<div class="card shadow-sm mb-3 no-print"><div class="card-body">
    <form method="get" class="row g-2">
        ${showFullFilters ? html`<input type="hidden" name="report_type" value="booking">` : ''}
        <div class="col-md-2"><input type="date" name="date_from" class="form-control" value="${filters.dateFrom}"></div>
        <div class="col-md-2"><input type="date" name="date_to" class="form-control" value="${filters.dateTo}"></div>
        <div class="col-md-2"><select name="department" class="form-select"><option value="0">All Departments</option>${raw(departments.map((d) => `<option value="${d.department_id}" ${filters.deptFilter == d.department_id ? 'selected' : ''}>${h(d.department_name)}</option>`).join(''))}</select></div>
        ${showFullFilters
            ? html`
        <div class="col-md-2"><select name="resort" class="form-select"><option value="0">All Resorts</option>${raw(filterOptions.resorts.map((rt) => `<option value="${rt.resort_id}" ${filters.resortFilter == rt.resort_id ? 'selected' : ''}>${h(rt.resort_name)}</option>`).join(''))}</select></div>
        <div class="col-md-2"><select name="employee" class="form-select"><option value="0">All Employees</option>${raw(employees.map((e) => `<option value="${e.user_id}" ${filters.empFilter == e.user_id ? 'selected' : ''}>${h(e.full_name)}</option>`).join(''))}</select></div>
        <div class="col-md-2"><select name="route" class="form-select"><option value="0">All Routes</option>${raw(routes.map((rt) => `<option value="${rt.route_id}" ${filters.routeFilter == rt.route_id ? 'selected' : ''}>${h(rt.direction)}</option>`).join(''))}</select></div>
        <div class="col-md-2"><select name="status" class="form-select"><option value="0">All Status</option>${raw(statuses.map((s) => `<option value="${s.status_id}" ${filters.statusFilter == s.status_id ? 'selected' : ''}>${h(s.status_name)}</option>`).join(''))}</select></div>
        <div class="col-md-3"><input type="text" name="purpose" class="form-control" placeholder="Purpose contains..." value="${filters.purpose}"></div>`
            : ''}
        <div class="col-md-9 d-flex align-items-end gap-2 mt-2">
            <button class="btn btn-outline-primary btn-sm" type="submit"><i class="bi bi-search"></i> Run Report</button>
            <a class="btn btn-outline-success btn-sm" href="${basePath}?${filters.queryString}&format=csv"><i class="bi bi-file-earmark-excel"></i> Export CSV / Excel</a>
            <button type="button" class="btn btn-outline-secondary btn-sm" onclick="window.print()"><i class="bi bi-file-earmark-pdf"></i> Export PDF (Print)</button>
        </div>
    </form>
</div></div>
<div class="card shadow-sm">
    <div class="card-header bg-white">Results: ${rows.length} booking(s)</div>
    <div class="table-responsive"><table class="table table-hover mb-0 align-middle">
        <thead><tr><th>ID</th><th>Employee</th><th>Department</th><th>Date</th><th>Time</th><th>Direction</th><th>Purpose</th><th>Status</th><th>Seats</th>${showFullFilters ? html`<th>Approver</th>` : ''}</tr></thead>
        <tbody>${raw(rowsHtml || `<tr><td colspan="${showFullFilters ? 10 : 9}" class="text-center text-muted py-4">No results for the selected filters.</td></tr>`)}</tbody>
    </table></div>
</div>
<style>@media print { .no-print, .sidebar, .topbar, .portal-banner { display: none !important; } .main-content { margin-left: 0 !important; } .print-masthead { display: block !important; } }</style>`;
}

async function loadFilterOptions() {
    return {
        departments: await getAllDepartments(),
        resorts: await getAllResorts(),
        employees: unwrap(await db().from('users').select('user_id, full_name').order('full_name')),
        routes: unwrap(await db().from('ferry_routes').select('*').order('route_name')),
        statuses: unwrap(await db().from('booking_status').select('*').order('status_id')),
    };
}

function toCsv(rows, includeApprover) {
    const header = includeApprover
        ? 'Booking ID,Employee,Employee ID,Department,Travel Date,Time,Direction,Purpose,Status,Seats,Approver\n'
        : 'Booking ID,Employee,Department,Travel Date,Time,Direction,Purpose,Status,Seats\n';
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = rows
        .map((r) => {
            const fields = includeApprover
                ? [r.booking_id, r.users.full_name, r.users.employee_id ?? '', r.users.departments?.department_name ?? '', r.travel_date, r.ferry_schedule.departure_time, r.ferry_schedule.ferry_routes.direction, r.purpose, r.booking_status.status_name, r.seats, r.approver?.full_name ?? '']
                : [r.booking_id, r.users.full_name, r.users.departments?.department_name ?? '', r.travel_date, r.ferry_schedule.departure_time, r.ferry_schedule.ferry_routes.direction, r.purpose, r.booking_status.status_name, r.seats];
            return fields.map(escape).join(',');
        })
        .join('\n');
    return header + body;
}

export function registerReportsRoutes(router) {
    router.get('/admin/reports', async (request) => {
        const auth = await requirePermission(request, 'reports.view_admin', { pageTitle: 'Reports' });
        if (auth.response) return auth.response;
        return handleReport(request, auth, 'admin', '/admin/reports');
    });

    router.get('/manager/reports', async (request) => {
        const auth = await requirePermission(request, 'reports.view_manager', { pageTitle: 'Reports' });
        if (auth.response) return auth.response;
        return handleReport(request, auth, 'manager', '/manager/reports');
    });
}

async function handleReport(request, auth, scope, basePath) {
    const url = new URL(request.url);
    const reportType = scope === 'admin' ? url.searchParams.get('report_type') || 'booking' : 'booking';
    const filters = {
        dateFrom: url.searchParams.get('date_from') || '',
        dateTo: url.searchParams.get('date_to') || '',
        deptFilter: Number(url.searchParams.get('department') || 0),
        resortFilter: scope === 'admin' ? Number(url.searchParams.get('resort') || 0) : 0,
        empFilter: scope === 'admin' && reportType === 'booking' ? Number(url.searchParams.get('employee') || 0) : 0,
        routeFilter: scope === 'admin' ? Number(url.searchParams.get('route') || 0) : 0,
        statusFilter: scope === 'admin' && reportType === 'booking' ? Number(url.searchParams.get('status') || 0) : 0,
        purpose: scope === 'admin' && reportType === 'booking' ? url.searchParams.get('purpose') || '' : '',
    };
    filters.queryString = new URLSearchParams({
        date_from: filters.dateFrom,
        date_to: filters.dateTo,
        department: String(filters.deptFilter),
        ...(scope === 'admin' ? { resort: String(filters.resortFilter), route: String(filters.routeFilter) } : {}),
        ...(scope === 'admin' && reportType === 'booking' ? { employee: String(filters.empFilter), status: String(filters.statusFilter), purpose: filters.purpose } : {}),
    }).toString();

    const companyName = await getSetting('company_name', 'Staff Ferry Transfer Portal');
    const siteLogo = await getSetting('site_logo', '');

    if (scope === 'admin' && reportType !== 'booking' && REPORT_TYPES[reportType]) {
        const rows = await REPORT_TYPES[reportType].fetchRows(filters);
        if (url.searchParams.get('format') === 'csv') {
            const filename = `${reportType}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
            return csvResponse(genericReportCsv(reportType, rows), filename);
        }
        const filterOptions = await loadFilterOptions();
        const body = genericReportBody({ reportType, rows, filters, filterOptions, basePath, companyName, siteLogo });
        return renderShellForRequest({ request, auth, pageTitle: 'Reports', path: basePath, bodyHtml: body });
    }

    const rows = await fetchReportRows(filters);

    if (url.searchParams.get('format') === 'csv') {
        const filename = `${scope === 'admin' ? 'ferry_bookings_report' : 'booking_report'}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
        return csvResponse(toCsv(rows, scope === 'admin'), filename);
    }

    const filterOptions = await loadFilterOptions();
    const body = reportPageBody({ rows, filters, filterOptions, scope, basePath, companyName, siteLogo });
    return renderShellForRequest({ request, auth, pageTitle: 'Reports', path: basePath, bodyHtml: body });
}
