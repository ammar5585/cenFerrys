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
import { formatDate, formatTime, formatDateTime, statusBadgeClass } from '../format.js';
import { getAllDepartments, getAllResorts } from '../refData.js';

async function fetchReportRows({ dateFrom, dateTo, deptFilter, resortFilter, empFilter, routeFilter, statusFilter, purpose }) {
    let query = db()
        .from('bookings')
        .select(
            'booking_id, travel_date, purpose, seats, users!bookings_user_id_fkey(user_id, full_name, department_id, resort_id, departments(department_name), resorts(resort_name)), ferry_schedule(departure_time, route_id, service_name, ferry_routes(route_id, direction)), booking_status(status_name, badge_color), current_approver_id, approver:current_approver_id(full_name), ' +
                'supplier_reservations(supplier_company, visitor_name)'
        )
        .order('travel_date', { ascending: false });
    if (dateFrom) query = query.gte('travel_date', dateFrom);
    if (dateTo) query = query.lte('travel_date', dateTo);
    if (statusFilter) query = query.eq('status_id', statusFilter);
    let rows = unwrap(await query);

    if (deptFilter) rows = rows.filter((r) => r.users.department_id === deptFilter);
    if (resortFilter) rows = rows.filter((r) => r.users.resort_id === resortFilter);
    if (empFilter) rows = rows.filter((r) => r.users.user_id === empFilter);
    if (routeFilter) rows = rows.filter((r) => r.ferry_schedule.ferry_routes?.route_id === routeFilter);
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
            'booking_id, travel_date, seats, checked_in_at, departed_at, arrived_at, users!bookings_user_id_fkey(full_name, employee_id, department_id, resort_id, departments(department_name), resorts(resort_name)), ferry_schedule(departure_time, route_id, service_name, ferry_routes(route_id, direction)), booking_status!inner(status_name, badge_color)'
        )
        .in('booking_status.status_name', statusNames)
        .order('travel_date', { ascending: false });
    if (dateFrom) query = query.gte('travel_date', dateFrom);
    if (dateTo) query = query.lte('travel_date', dateTo);
    let rows = unwrap(await query);
    if (deptFilter) rows = rows.filter((r) => r.users.department_id === deptFilter);
    if (resortFilter) rows = rows.filter((r) => r.users.resort_id === resortFilter);
    if (routeFilter) rows = rows.filter((r) => r.ferry_schedule.ferry_routes?.route_id === routeFilter);
    return rows;
}

async function fetchSecurityActionLog({ dateFrom, dateTo, deptFilter, resortFilter }) {
    let query = db()
        .from('security_action_log')
        .select(
            'log_id, action, remarks, created_at, promotion_method, promotion_reason, security_officer:security_officer_id(full_name), booking:booking_id(booking_id, travel_date, users!bookings_user_id_fkey(full_name, employee_id, department_id, resort_id, departments(department_name), resorts(resort_name))), previous_status:previous_status_id(status_name), new_status:new_status_id(status_name, badge_color)'
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
    let schedQuery = db().from('ferry_schedule').select('schedule_id, departure_time, capacity, service_name, ferry_routes(route_id, direction)').eq('status', 'active');
    let schedules = unwrap(await schedQuery);
    if (routeFilter) schedules = schedules.filter((s) => s.ferry_routes?.route_id === routeFilter);

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
// getStatus/getSeats are used only for the Executive Summary KPI cards
// and the Status-column badge - kept separate from `columns` (which
// drives the table/CSV) so adding them can't change either. Report
// shapes with no real status concept (ferry_occupancy) or no seats
// concept (security_activity) simply omit the corresponding accessor -
// the KPI/badge code below treats that as "not applicable" rather than
// fabricating a number.
const STATUS_FROM_BOOKING = (r) => (r.booking_status ? { name: r.booking_status.status_name, color: r.booking_status.badge_color } : null);

const REPORT_TYPES = {
    daily_departure: {
        label: 'Daily Departure Report',
        fetchRows: (f) => fetchBookingsByStatus(['Approved', 'Checked-In', 'Departed', 'Arrived', 'Completed'], f),
        getStatus: STATUS_FROM_BOOKING,
        getSeats: (r) => r.seats,
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Department', get: (r) => r.users.departments?.department_name ?? '' },
            { header: 'Resort', get: (r) => r.users.resorts?.resort_name ?? '' },
            { header: 'Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Departure Time', get: (r) => formatTime(r.ferry_schedule.departure_time) },
            { header: 'Route', get: (r) => r.ferry_schedule.service_name ?? r.ferry_schedule.ferry_routes?.direction ?? '-' },
            { header: 'Seats', get: (r) => r.seats },
            { header: 'Status', get: (r) => r.booking_status.status_name },
        ],
    },
    daily_arrival: {
        label: 'Daily Arrival Report',
        fetchRows: (f) => fetchBookingsByStatus(['Arrived', 'Completed'], f),
        getStatus: STATUS_FROM_BOOKING,
        getSeats: (r) => r.seats,
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Department', get: (r) => r.users.departments?.department_name ?? '' },
            { header: 'Resort', get: (r) => r.users.resorts?.resort_name ?? '' },
            { header: 'Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Route', get: (r) => r.ferry_schedule.service_name ?? r.ferry_schedule.ferry_routes?.direction ?? '-' },
            { header: 'Arrival Time', get: (r) => (r.arrived_at ? formatDateTime(r.arrived_at) : '-') },
            { header: 'Status', get: (r) => r.booking_status.status_name },
        ],
    },
    passenger_manifest: {
        label: 'Passenger Manifest',
        fetchRows: (f) => fetchBookingsByStatus(['Approved', 'Checked-In', 'Departed', 'Arrived', 'Completed'], f),
        getStatus: STATUS_FROM_BOOKING,
        getSeats: (r) => r.seats,
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Department', get: (r) => r.users.departments?.department_name ?? '' },
            { header: 'Resort', get: (r) => r.users.resorts?.resort_name ?? '' },
            { header: 'Booking Ref', get: (r) => `BK-${r.booking_id}` },
            { header: 'Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Route', get: (r) => r.ferry_schedule.service_name ?? r.ferry_schedule.ferry_routes?.direction ?? '-' },
            { header: 'Departure Time', get: (r) => formatTime(r.ferry_schedule.departure_time) },
            { header: 'Seats', get: (r) => r.seats },
            { header: 'Status', get: (r) => r.booking_status.status_name },
        ],
    },
    waiting_list_report: {
        label: 'Waiting List Report',
        fetchRows: (f) => fetchBookingsByStatus(['Waiting List'], f),
        getSeats: (r) => r.seats,
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Department', get: (r) => r.users.departments?.department_name ?? '' },
            { header: 'Resort', get: (r) => r.users.resorts?.resort_name ?? '' },
            { header: 'Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Route', get: (r) => r.ferry_schedule.service_name ?? r.ferry_schedule.ferry_routes?.direction ?? '-' },
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
            { header: 'Route', get: (r) => r.ferry_schedule.service_name ?? r.ferry_schedule.ferry_routes?.direction ?? '-' },
            { header: 'Departure Time', get: (r) => formatTime(r.ferry_schedule.departure_time) },
        ],
    },
    ferry_occupancy: {
        label: 'Ferry Occupancy Report',
        fetchRows: (f) => fetchFerryOccupancy(f),
        getOccupancyPct: (r) => r.occupancyPct,
        columns: [
            { header: 'Date', get: (r) => formatDate(r.travelDate) },
            { header: 'Route', get: (r) => r.schedule.service_name ?? r.schedule.ferry_routes?.direction ?? '-' },
            { header: 'Departure Time', get: (r) => formatTime(r.schedule.departure_time) },
            { header: 'Capacity', get: (r) => r.capacity },
            { header: 'Booked', get: (r) => r.booked },
            { header: 'Occupancy %', get: (r) => `${r.occupancyPct}%` },
        ],
    },
    security_activity: {
        label: 'Security Activity Report',
        fetchRows: (f) => fetchSecurityActionLog(f),
        getStatus: (r) => (r.new_status ? { name: r.new_status.status_name, color: r.new_status.badge_color } : null),
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
        getStatus: STATUS_FROM_BOOKING,
        columns: [
            { header: 'Employee ID', get: (r) => r.users.employee_id },
            { header: 'Name', get: (r) => r.users.full_name },
            { header: 'Booking Date', get: (r) => formatDate(r.travel_date) },
            { header: 'Route', get: (r) => r.ferry_schedule.service_name ?? r.ferry_schedule.ferry_routes?.direction ?? '-' },
            { header: 'Checked-In', get: (r) => (r.checked_in_at ? formatDateTime(r.checked_in_at) : '-') },
            { header: 'Departed', get: (r) => (r.departed_at ? formatDateTime(r.departed_at) : '-') },
            { header: 'Arrived', get: (r) => (r.arrived_at ? formatDateTime(r.arrived_at) : '-') },
            { header: 'Current Status', get: (r) => r.booking_status.status_name },
        ],
    },
};

// ---------------------------------------------------------------------
// Shared "modern executive report" chrome - header/KPI cards/footer/
// print+mobile CSS - used by both genericReportBody() (the 8 Security
// Operations reports) and reportPageBody() (the default Booking
// Report), so every report type gets identical branding/print/mobile
// treatment from one implementation.
// ---------------------------------------------------------------------

/** A short human-readable summary of which filters are actually active - shown in the header so a printed/exported report is self-describing without needing the on-screen filter form. */
function describeAppliedFilters(filters, filterOptions) {
    const parts = [];
    if (filters.dateFrom || filters.dateTo) parts.push(`Date: ${filters.dateFrom ? formatDate(filters.dateFrom) : 'Any'} - ${filters.dateTo ? formatDate(filters.dateTo) : 'Any'}`);
    if (filters.deptFilter) parts.push(`Department: ${filterOptions.departments.find((d) => d.department_id === filters.deptFilter)?.department_name ?? filters.deptFilter}`);
    if (filters.resortFilter) parts.push(`Resort: ${filterOptions.resorts.find((r) => r.resort_id === filters.resortFilter)?.resort_name ?? filters.resortFilter}`);
    if (filters.empFilter) parts.push(`Employee: ${filterOptions.employees?.find((e) => e.user_id === filters.empFilter)?.full_name ?? filters.empFilter}`);
    if (filters.routeFilter) parts.push(`Route: ${filterOptions.routes.find((r) => r.route_id === filters.routeFilter)?.direction ?? filters.routeFilter}`);
    if (filters.statusFilter) parts.push(`Status: ${filterOptions.statuses?.find((s) => s.status_id === filters.statusFilter)?.status_name ?? filters.statusFilter}`);
    if (filters.purpose) parts.push(`Purpose contains: "${filters.purpose}"`);
    return parts.length ? parts.join(' &middot; ') : 'None (all records)';
}

function reportHeaderHtml({ reportLabel, companyName, siteLogo, generatedByName, filters, filterOptions }) {
    return `<div class="report-header mb-3">
    <div class="d-flex flex-wrap justify-content-between align-items-start gap-3">
        <div class="d-flex align-items-center gap-3">
            ${siteLogo ? `<img src="${h(siteLogo)}" alt="" style="height:48px;">` : ''}
            <div>
                <div class="fw-bold fs-5">${h(companyName)}</div>
                <div class="text-muted">${h(reportLabel)}</div>
            </div>
        </div>
        <div class="text-sm-end small text-muted">
            <div>Generated By: <span class="text-body">${h(generatedByName)}</span></div>
            <div>Generated: <span class="text-body">${formatDateTime(new Date().toISOString())}</span></div>
        </div>
    </div>
    <div class="small text-muted mt-2 pt-2 border-top">
        <span class="me-3"><strong>Reporting Period:</strong> ${filters.dateFrom || filters.dateTo ? `${filters.dateFrom ? formatDate(filters.dateFrom) : 'Any'} - ${filters.dateTo ? formatDate(filters.dateTo) : 'Any'}` : 'All time'}</span>
        <span><strong>Applied Filters:</strong> ${raw(describeAppliedFilters(filters, filterOptions))}</span>
    </div>
</div>`;
}

function reportFooterHtml({ generatedByName, totalRecords, companyName }) {
    return `<div class="report-footer mt-3 pt-3 border-top small text-muted d-flex flex-wrap justify-content-between gap-2">
    <div>Generated by ${h(generatedByName)} on ${formatDateTime(new Date().toISOString())}</div>
    <div>Total Records: ${totalRecords}</div>
    <div>${h(companyName)} Ferry Portal &middot; Report v1.0</div>
</div>
<div class="report-confidentiality small text-muted fst-italic mt-1">This report contains confidential operational data intended solely for authorized personnel of ${h(companyName)}. Do not distribute outside the organization without approval.</div>`;
}

/** One pill in the Executive Summary's chip row - a colored dot (the same badge_color as the Status column, via Bootstrap's own --bs-{color} custom properties) carries the status meaning; Total Records/Total Passengers/Average Occupancy (no status color) get a neutral dot. */
function kpiChipHtml({ value, label, percent, color }) {
    return `<span class="report-kpi-chip"><span class="report-kpi-chip-dot" style="background:var(--bs-${color ?? 'secondary'})"></span><strong>${value}</strong> ${h(label)}${percent != null ? `<span class="report-kpi-chip-pct">${percent}%</span>` : ''}</span>`;
}

/**
 * Data-driven Executive Summary: always Total Records (+ Total
 * Passengers when rows carry a seat count), then one chip per DISTINCT
 * status name actually present in this report's rows - never a fixed
 * 12-chip list, so a report whose data structurally excludes most
 * statuses (e.g. the No Show Report is 100% "No Show") doesn't show a
 * wall of zero-value chips. ferry_occupancy has no status concept at
 * all - it gets Average Occupancy instead, computed from its own
 * occupancyPct field rather than fabricating a capacity figure other
 * report shapes don't have.
 */
function reportKpiCardsHtml(rows, def) {
    const chips = [kpiChipHtml({ value: rows.length, label: 'Total Records' })];

    if (def.getSeats) {
        const totalPassengers = rows.reduce((sum, r) => sum + (Number(def.getSeats(r)) || 0), 0);
        chips.push(kpiChipHtml({ value: totalPassengers, label: 'Total Passengers' }));
    }

    if (def.getStatus) {
        const counts = new Map();
        for (const r of rows) {
            const status = def.getStatus(r);
            if (!status?.name) continue;
            const key = status.name;
            if (!counts.has(key)) counts.set(key, { count: 0, color: status.color });
            counts.get(key).count++;
        }
        for (const [name, { count, color }] of counts) {
            const percent = rows.length ? Math.round((count / rows.length) * 100) : 0;
            chips.push(kpiChipHtml({ value: count, label: name, percent, color }));
        }
    }

    if (def.getOccupancyPct && rows.length) {
        const avg = Math.round(rows.reduce((sum, r) => sum + (Number(def.getOccupancyPct(r)) || 0), 0) / rows.length);
        chips.push(kpiChipHtml({ value: `${avg}%`, label: 'Average Occupancy' }));
    }

    return `<div class="report-kpi-row mb-3">${chips.join('')}</div>`;
}

// Column headers that represent a booking/passenger status - rendered
// as a colored badge (via the report def's own getStatus()) instead of
// plain text, wherever the columns array happens to expose one.
const STATUS_COLUMN_HEADERS = new Set(['Status', 'Current Status', 'New Status']);

function reportCellHtml(col, row, def) {
    if (STATUS_COLUMN_HEADERS.has(col.header) && def.getStatus) {
        const status = def.getStatus(row);
        if (status?.name) return `<td data-label="${h(col.header)}"><span class="badge rounded-pill ${statusBadgeClass(status.color)}">${h(status.name)}</span></td>`;
    }
    return `<td data-label="${h(col.header)}">${h(String(col.get(row) ?? ''))}</td>`;
}

const REPORT_PRINT_MOBILE_STYLE = `<style>
@media print {
    .no-print, .sidebar, .topbar, .portal-banner { display: none !important; }
    .main-content { margin-left: 0 !important; }
    @page { size: A4; margin: 15mm; }
    .report-table thead { display: table-header-group; }
    .report-table tr { page-break-inside: avoid; }
}
@media (max-width: 767.98px) {
    .report-table thead { display: none; }
    .report-table, .report-table tbody, .report-table tr, .report-table td { display: block; width: 100%; }
    .report-table tr { margin-bottom: .75rem; border: 1px solid #e2e5ea; border-radius: 8px; padding: .25rem .5rem; }
    .report-table td { display: flex; justify-content: space-between; align-items: center; gap: .5rem; padding: .4rem .25rem; border: none !important; text-align: right; }
    .report-table td::before { content: attr(data-label); font-weight: 600; color: #7c8aa5; text-align: left; }
}
</style>`;

function genericReportBody({ reportType, rows, filters, filterOptions, basePath, companyName, siteLogo, generatedByName }) {
    const def = REPORT_TYPES[reportType];
    const { departments, resorts, routes } = filterOptions;

    const rowsHtml = rows
        .map((r) => html`<tr>${raw(def.columns.map((c) => reportCellHtml(c, r, def)).join(''))}</tr>`)
        .map((r) => r.toString())
        .join('');

    return html`
${raw(reportHeaderHtml({ reportLabel: def.label, companyName, siteLogo, generatedByName, filters, filterOptions }))}
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
${raw(reportKpiCardsHtml(rows, def))}
<div class="card shadow-sm">
    <div class="card-header bg-white">Results: ${rows.length} record(s)</div>
    <div class="table-responsive"><table class="table table-hover mb-0 align-middle small report-table">
        <thead><tr>${raw(def.columns.map((c) => `<th>${h(c.header)}</th>`).join(''))}</tr></thead>
        <tbody>${raw(rowsHtml || `<tr><td colspan="${def.columns.length}" class="text-center text-muted py-4">No results for the selected filters.</td></tr>`)}</tbody>
    </table></div>
</div>
${raw(reportFooterHtml({ generatedByName, totalRecords: rows.length, companyName }))}
${raw(REPORT_PRINT_MOBILE_STYLE)}`;
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

// Same shape as a REPORT_TYPES entry's getStatus/getSeats, so the
// default Booking Report gets identical KPI-card treatment to the 8
// Security Operations reports via the same reportKpiCardsHtml().
const BOOKING_REPORT_DEF = { getStatus: (r) => ({ name: r.booking_status.status_name, color: r.booking_status.badge_color }), getSeats: (r) => r.seats };

function reportPageBody({ rows, filters, filterOptions, scope, basePath, companyName, siteLogo, generatedByName }) {
    const { departments, employees, routes, statuses } = filterOptions;
    const showFullFilters = scope === 'admin';

    const rowsHtml = rows
        .map(
            (r) => html`<tr>
            <td data-label="ID">#${r.booking_id}</td><td data-label="Employee">${r.supplier_reservations ? html`<span class="badge bg-info text-dark">Supplier</span> ${r.supplier_reservations.visitor_name} (${r.supplier_reservations.supplier_company})` : r.users.full_name}</td>
            <td data-label="Department">${r.users.departments?.department_name ?? '-'}</td>
            <td data-label="Date">${formatDate(r.travel_date)}</td><td data-label="Time">${formatTime(r.ferry_schedule.departure_time)}</td>
            <td data-label="Direction">${r.ferry_schedule.service_name ?? r.ferry_schedule.ferry_routes?.direction ?? '-'}</td><td data-label="Purpose">${r.purpose}</td>
            <td data-label="Status"><span class="badge rounded-pill ${statusBadgeClass(r.booking_status.badge_color)}">${h(r.booking_status.status_name)}</span></td><td data-label="Seats">${r.seats}</td>
            ${showFullFilters ? html`<td data-label="Approver">${r.approver?.full_name ?? '-'}</td>` : ''}
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
${raw(reportHeaderHtml({ reportLabel: 'Booking Report', companyName, siteLogo, generatedByName, filters, filterOptions }))}
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
${raw(reportKpiCardsHtml(rows, BOOKING_REPORT_DEF))}
<div class="card shadow-sm">
    <div class="card-header bg-white">Results: ${rows.length} booking(s)</div>
    <div class="table-responsive"><table class="table table-hover mb-0 align-middle report-table">
        <thead><tr><th>ID</th><th>Employee</th><th>Department</th><th>Date</th><th>Time</th><th>Direction</th><th>Purpose</th><th>Status</th><th>Seats</th>${showFullFilters ? html`<th>Approver</th>` : ''}</tr></thead>
        <tbody>${raw(rowsHtml || `<tr><td colspan="${showFullFilters ? 10 : 9}" class="text-center text-muted py-4">No results for the selected filters.</td></tr>`)}</tbody>
    </table></div>
</div>
${raw(reportFooterHtml({ generatedByName, totalRecords: rows.length, companyName }))}
${raw(REPORT_PRINT_MOBILE_STYLE)}`;
}

async function loadFilterOptions() {
    const [departments, resorts, employees, routes, statuses] = await Promise.all([
        getAllDepartments(),
        getAllResorts(),
        db().from('users').select('user_id, full_name').order('full_name').then(unwrap),
        db().from('ferry_routes').select('*').order('route_name').then(unwrap),
        db().from('booking_status').select('*').order('status_id').then(unwrap),
    ]);
    return { departments, resorts, employees, routes, statuses };
}

function toCsv(rows, includeApprover) {
    const header = includeApprover
        ? 'Booking ID,Employee,Employee ID,Department,Travel Date,Time,Direction,Purpose,Status,Seats,Approver\n'
        : 'Booking ID,Employee,Department,Travel Date,Time,Direction,Purpose,Status,Seats\n';
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = rows
        .map((r) => {
            const routeLabel = r.ferry_schedule.service_name ?? r.ferry_schedule.ferry_routes?.direction ?? '-';
            const nameLabel = r.supplier_reservations ? `${r.supplier_reservations.visitor_name} (${r.supplier_reservations.supplier_company}) [Supplier]` : r.users.full_name;
            const fields = includeApprover
                ? [r.booking_id, nameLabel, r.users.employee_id ?? '', r.users.departments?.department_name ?? '', r.travel_date, r.ferry_schedule.departure_time, routeLabel, r.purpose, r.booking_status.status_name, r.seats, r.approver?.full_name ?? '']
                : [r.booking_id, nameLabel, r.users.departments?.department_name ?? '', r.travel_date, r.ferry_schedule.departure_time, routeLabel, r.purpose, r.booking_status.status_name, r.seats];
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

    if (scope === 'admin' && reportType !== 'booking' && REPORT_TYPES[reportType]) {
        const rows = await REPORT_TYPES[reportType].fetchRows(filters);
        if (url.searchParams.get('format') === 'csv') {
            const filename = `${reportType}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
            return csvResponse(genericReportCsv(reportType, rows), filename);
        }
        // Independent of `rows` and of each other - fetched concurrently
        // (also skipped entirely for the CSV branch above, which never
        // needed them).
        const [companyName, siteLogo, filterOptions] = await Promise.all([
            getSetting('company_name', 'Staff Ferry Transfer Portal'),
            getSetting('site_logo', ''),
            loadFilterOptions(),
        ]);
        const body = genericReportBody({ reportType, rows, filters, filterOptions, basePath, companyName, siteLogo, generatedByName: auth.user.full_name });
        return renderShellForRequest({ request, auth, pageTitle: 'Reports', path: basePath, bodyHtml: body });
    }

    const rows = await fetchReportRows(filters);

    if (url.searchParams.get('format') === 'csv') {
        const filename = `${scope === 'admin' ? 'ferry_bookings_report' : 'booking_report'}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
        return csvResponse(toCsv(rows, scope === 'admin'), filename);
    }

    const [companyName, siteLogo, filterOptions] = await Promise.all([
        getSetting('company_name', 'Staff Ferry Transfer Portal'),
        getSetting('site_logo', ''),
        loadFilterOptions(),
    ]);
    const body = reportPageBody({ rows, filters, filterOptions, scope, basePath, companyName, siteLogo, generatedByName: auth.user.full_name });
    return renderShellForRequest({ request, auth, pageTitle: 'Reports', path: basePath, bodyHtml: body });
}
