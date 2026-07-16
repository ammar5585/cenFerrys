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

import ExcelJS from 'exceljs';
import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csvResponse, xlsxResponse } from '../response.js';
import { getSetting } from '../settings.js';
import { formatDate, formatTime, formatDateTime } from '../format.js';
import { getAllDepartments, getAllResorts } from '../refData.js';

/**
 * The real geographic route (the route_stops chain, e.g. "CGLM → CMLM
 * → Male → Hulhumale") - batched as one query for every distinct
 * schedule_id in `rows` rather than one query per row. Mutates each
 * row's schedule-like object (whatever `getSchedule` returns) in place
 * so existing `get: (r) => ...` column closures can read it via
 * routeLabel() below without changing their own signatures.
 */
async function attachRouteSnapshots(rows, getSchedule) {
    const scheduleIds = [...new Set(rows.map((r) => getSchedule(r)?.schedule_id).filter(Boolean))];
    if (!scheduleIds.length) return;
    const stops = unwrap(
        await db().from('route_stops').select('schedule_id, stop_name, stop_order').in('schedule_id', scheduleIds).eq('status', 'active').order('stop_order', { ascending: true })
    );
    const namesById = new Map();
    for (const s of stops) {
        if (!namesById.has(s.schedule_id)) namesById.set(s.schedule_id, []);
        namesById.get(s.schedule_id).push(s.stop_name);
    }
    for (const r of rows) {
        const schedule = getSchedule(r);
        if (!schedule) continue;
        const names = namesById.get(schedule.schedule_id);
        schedule.routeSnapshot = names?.length ? names.join(' → ') : null;
    }
}

/**
 * "Route" display precedence: the real route_stops chain wins; the
 * legacy single-leg ferry_routes.direction text is next; service_name
 * (the boat's own name - e.g. "The Atollia" for every schedule in a
 * single-fleet setup) is the last resort, never the first choice - it
 * was being shown under "Route"/"Direction" by mistake, making every
 * row look identical regardless of where the ferry actually travels.
 */
function routeLabel(schedule) {
    return schedule?.routeSnapshot || schedule?.ferry_routes?.direction || schedule?.service_name || '-';
}

async function fetchReportRows({ dateFrom, dateTo, deptFilter, resortFilter, empFilter, routeFilter, statusFilter, purpose }) {
    let query = db()
        .from('bookings')
        .select(
            'booking_id, travel_date, purpose, seats, users!bookings_user_id_fkey(user_id, full_name, department_id, resort_id, departments(department_name), resorts(resort_name)), ferry_schedule(schedule_id, departure_time, route_id, service_name, ferry_routes(route_id, direction)), booking_status(status_name, badge_color), current_approver_id, approver:current_approver_id(full_name), ' +
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

    await attachRouteSnapshots(rows, (r) => r.ferry_schedule);
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
            'booking_id, travel_date, seats, checked_in_at, departed_at, arrived_at, users!bookings_user_id_fkey(full_name, employee_id, department_id, resort_id, departments(department_name), resorts(resort_name)), ferry_schedule(schedule_id, departure_time, route_id, service_name, ferry_routes(route_id, direction)), booking_status!inner(status_name, badge_color)'
        )
        .in('booking_status.status_name', statusNames)
        .order('travel_date', { ascending: false });
    if (dateFrom) query = query.gte('travel_date', dateFrom);
    if (dateTo) query = query.lte('travel_date', dateTo);
    let rows = unwrap(await query);
    if (deptFilter) rows = rows.filter((r) => r.users.department_id === deptFilter);
    if (resortFilter) rows = rows.filter((r) => r.users.resort_id === resortFilter);
    if (routeFilter) rows = rows.filter((r) => r.ferry_schedule.ferry_routes?.route_id === routeFilter);
    await attachRouteSnapshots(rows, (r) => r.ferry_schedule);
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
    await attachRouteSnapshots(schedules, (s) => s);

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
            { header: 'Route', get: (r) => routeLabel(r.ferry_schedule) },
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
            { header: 'Route', get: (r) => routeLabel(r.ferry_schedule) },
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
            { header: 'Route', get: (r) => routeLabel(r.ferry_schedule) },
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
            { header: 'Route', get: (r) => routeLabel(r.ferry_schedule) },
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
            { header: 'Route', get: (r) => routeLabel(r.ferry_schedule) },
            { header: 'Departure Time', get: (r) => formatTime(r.ferry_schedule.departure_time) },
        ],
    },
    ferry_occupancy: {
        label: 'Ferry Occupancy Report',
        fetchRows: (f) => fetchFerryOccupancy(f),
        getOccupancyPct: (r) => r.occupancyPct,
        columns: [
            { header: 'Date', get: (r) => formatDate(r.travelDate) },
            { header: 'Route', get: (r) => routeLabel(r.schedule) },
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
            { header: 'Route', get: (r) => routeLabel(r.ferry_schedule) },
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

// Enterprise design tokens (colors, spacing, radius) - scoped to the
// report-* classes below only, so this never touches .stat-card/.card
// etc. used elsewhere in the app (Admin Dashboard, Security Dashboard,
// Supplier Reservations already rely on today's .stat-card look).
const REPORT_COLORS = {
    primary: '#0F172A', secondary: '#475569', bg: '#F8FAFC', border: '#E2E8F0',
};
// Keyed by status *name* (not the DB's generic badge_color, which only
// has ~6 buckets and can't tell Pending's amber from Waiting List's
// yellow apart) - exact hex values from the design spec. Anything not
// listed (Confirmed/Completed/Expired, etc.) falls back to secondary.
const STATUS_COLORS = {
    Approved: '#16A34A', Pending: '#F59E0B', Rejected: '#DC2626', Cancelled: '#64748B',
    'Checked-In': '#2563EB', Departed: '#2563EB', Arrived: '#16A34A', 'No Show': '#9333EA',
    'Waiting List': '#EAB308',
};
function statusColor(name) {
    return STATUS_COLORS[name] ?? REPORT_COLORS.secondary;
}
/** A soft-tint pill (light background of the status color, solid-color text/border) - the "professional colored badge" look, replacing plain status text everywhere in reports. */
function statusBadgeHtml(name) {
    const color = statusColor(name);
    return `<span class="report-status-badge" style="background:${color}1a;color:${color};border-color:${color}40;">${h(name)}</span>`;
}

/** A short human-readable summary of which filters are actually active - shown in the header so a printed/exported report is self-describing without needing the on-screen filter form. */
function describeAppliedFilters(filters, filterOptions) {
    const parts = [];
    if (filters.dateFrom || filters.dateTo) parts.push(`Date: ${filters.dateFrom ? formatDate(filters.dateFrom) : 'Any'} - ${filters.dateTo ? formatDate(filters.dateTo) : 'Any'}`);
    if (filters.deptFilter) parts.push(`Department: ${h(filterOptions.departments.find((d) => d.department_id === filters.deptFilter)?.department_name ?? filters.deptFilter)}`);
    if (filters.resortFilter) parts.push(`Resort: ${h(filterOptions.resorts.find((r) => r.resort_id === filters.resortFilter)?.resort_name ?? filters.resortFilter)}`);
    if (filters.empFilter) parts.push(`Employee: ${h(filterOptions.employees?.find((e) => e.user_id === filters.empFilter)?.full_name ?? filters.empFilter)}`);
    if (filters.routeFilter) parts.push(`Route: ${h(filterOptions.routes.find((r) => r.route_id === filters.routeFilter)?.direction ?? filters.routeFilter)}`);
    if (filters.statusFilter) parts.push(`Status: ${h(filterOptions.statuses?.find((s) => s.status_id === filters.statusFilter)?.status_name ?? filters.statusFilter)}`);
    if (filters.purpose) parts.push(`Purpose contains: "${h(filters.purpose)}"`);
    return parts.length ? parts.join(' &middot; ') : 'None (all records)';
}

/** Presentational only, recomputed on every render (not stored) - a stable-looking reference so a printed/exported report can be pointed to in conversation ("see RPT-BOOKING-20260716-1044"). */
function generateReportId(reportType) {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    return `RPT-${reportType.toUpperCase().replace(/_/g, '-')}-${stamp}`;
}

function reportHeaderHtml({ reportType, reportLabel, companyName, siteLogo, generatedByName, filters, filterOptions }) {
    const infoRows = [
        ['Reporting Period', filters.dateFrom || filters.dateTo ? `${filters.dateFrom ? formatDate(filters.dateFrom) : 'Any'} - ${filters.dateTo ? formatDate(filters.dateTo) : 'Any'}` : 'All time'],
        filters.deptFilter ? ['Department', h(filterOptions.departments.find((d) => d.department_id === filters.deptFilter)?.department_name ?? filters.deptFilter)] : null,
        filters.resortFilter ? ['Resort', h(filterOptions.resorts.find((r) => r.resort_id === filters.resortFilter)?.resort_name ?? filters.resortFilter)] : null,
        filters.routeFilter ? ['Route', h(filterOptions.routes.find((r) => r.route_id === filters.routeFilter)?.direction ?? filters.routeFilter)] : null,
        filters.statusFilter ? ['Status', h(filterOptions.statuses?.find((s) => s.status_id === filters.statusFilter)?.status_name ?? filters.statusFilter)] : null,
        ['Applied Filters', describeAppliedFilters(filters, filterOptions)],
    ].filter(Boolean);

    return `<div class="report-header mb-3">
    <div class="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-3">
        <div class="d-flex align-items-center gap-3">
            ${siteLogo ? `<img src="${h(siteLogo)}" alt="" style="height:48px;">` : ''}
            <div>
                <div class="report-title">${h(companyName)}</div>
                <div class="report-subtitle">${h(reportLabel)}</div>
            </div>
        </div>
        <div class="report-header-meta text-sm-end">
            <div>Generated By: <strong>${h(generatedByName)}</strong></div>
            <div>Generated: <strong>${formatDateTime(new Date().toISOString())}</strong></div>
            <div>Report ID: <strong>${h(generateReportId(reportType))}</strong></div>
        </div>
    </div>
    <div class="report-info-card">
        ${infoRows.map(([label, value]) => `<div class="report-info-item"><span class="report-info-label">${h(label)}</span><span class="report-info-value">${raw(String(value))}</span></div>`).join('')}
    </div>
</div>`;
}

function emptyStateHtml(colspan) {
    return `<tr><td colspan="${colspan}"><div class="report-empty-state"><i class="bi bi-inbox"></i>No records found for the selected filters.</div></td></tr>`;
}

function reportFooterHtml({ generatedByName, totalRecords, companyName }) {
    return `<div class="report-footer">
    <div>${h(companyName)} Staff Transfer Portal <span class="report-footer-sep">&middot;</span> Confidential &bull; Internal Use Only</div>
    <div>Automatically Generated Report <span class="report-footer-sep">&middot;</span> Generated by ${h(generatedByName)} on ${formatDateTime(new Date().toISOString())} <span class="report-footer-sep">&middot;</span> Total Records: ${totalRecords}</div>
    <div class="report-page-number"></div>
</div>`;
}

/** One pill in the Executive Summary's chip row - a colored dot (the same exact hex as the Status column's badge, via STATUS_COLORS) carries the status meaning; Total Records/Total Passengers/Average Occupancy (no status color) get a neutral dot. */
function kpiChipHtml({ value, label, percent, color }) {
    return `<span class="report-kpi-chip"><span class="report-kpi-chip-dot" style="background:${color ?? REPORT_COLORS.secondary}"></span><strong>${value}</strong> ${h(label)}${percent != null ? `<span class="report-kpi-chip-pct">${percent}%</span>` : ''}</span>`;
}

/**
 * Data-driven Executive Summary, as plain data - always Total Records
 * (+ Total Passengers when rows carry a seat count), then one entry
 * per DISTINCT status name actually present in this report's rows -
 * never a fixed 12-entry list, so a report whose data structurally
 * excludes most statuses (e.g. the No Show Report is 100% "No Show")
 * doesn't show a wall of zero-value entries. ferry_occupancy has no
 * status concept at all - it gets Average Occupancy instead, computed
 * from its own occupancyPct field rather than fabricating a capacity
 * figure other report shapes don't have. Shared by both the HTML chip
 * row and the Excel Summary sheet, so the two can never disagree.
 */
function computeKpiSummary(rows, def) {
    const entries = [{ label: 'Total Records', value: rows.length }];

    if (def.getSeats) {
        const totalPassengers = rows.reduce((sum, r) => sum + (Number(def.getSeats(r)) || 0), 0);
        entries.push({ label: 'Total Passengers', value: totalPassengers });
    }

    if (def.getStatus) {
        const counts = new Map();
        for (const r of rows) {
            const status = def.getStatus(r);
            if (!status?.name) continue;
            counts.set(status.name, (counts.get(status.name) ?? 0) + 1);
        }
        for (const [name, count] of counts) {
            const percent = rows.length ? Math.round((count / rows.length) * 100) : 0;
            entries.push({ label: name, value: count, percent, color: statusColor(name) });
        }
    }

    if (def.getOccupancyPct && rows.length) {
        const avg = Math.round(rows.reduce((sum, r) => sum + (Number(def.getOccupancyPct(r)) || 0), 0) / rows.length);
        entries.push({ label: 'Average Occupancy', value: `${avg}%` });
    }

    return entries;
}

function reportKpiCardsHtml(rows, def) {
    const chips = computeKpiSummary(rows, def).map((e) => kpiChipHtml({ value: e.value, label: e.label, percent: e.percent, color: e.color }));
    return `<div class="report-kpi-row mb-3">${chips.join('')}</div>`;
}

// Column headers that represent a booking/passenger status - rendered
// as a colored badge (via the report def's own getStatus()) instead of
// plain text, wherever the columns array happens to expose one.
const STATUS_COLUMN_HEADERS = new Set(['Status', 'Current Status', 'New Status']);

function reportCellHtml(col, row, def) {
    if (STATUS_COLUMN_HEADERS.has(col.header) && def.getStatus) {
        const status = def.getStatus(row);
        if (status?.name) return `<td data-label="${h(col.header)}">${statusBadgeHtml(status.name)}</td>`;
    }
    return `<td data-label="${h(col.header)}">${h(String(col.get(row) ?? ''))}</td>`;
}

const REPORT_PRINT_MOBILE_STYLE = `<style>
/* ---- Enterprise report chrome - typography scale, Information Card, table ---- */
.report-title { font-size: 22px; font-weight: 700; color: ${REPORT_COLORS.primary}; line-height: 1.2; }
.report-subtitle { font-size: 16px; color: ${REPORT_COLORS.secondary}; }
.report-header-meta { font-size: 11px; color: ${REPORT_COLORS.secondary}; line-height: 1.6; }
.report-info-card {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 24px;
    background: ${REPORT_COLORS.bg}; border: 1px solid ${REPORT_COLORS.border}; border-radius: 12px; padding: 16px;
}
.report-info-item { display: flex; flex-direction: column; gap: 2px; }
.report-info-label { font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: ${REPORT_COLORS.secondary}; }
.report-info-value { font-size: 11px; color: ${REPORT_COLORS.primary}; }
.report-status-badge {
    display: inline-block; font-size: 11px; font-weight: 600; padding: .2rem .6rem;
    border-radius: 999px; border: 1px solid transparent;
}
.report-footer {
    margin-top: 18px; padding-top: 12px; border-top: 1px solid ${REPORT_COLORS.border};
    font-size: 9px; color: ${REPORT_COLORS.secondary}; display: flex; flex-direction: column; gap: 2px;
}
.report-footer-sep { opacity: .5; }
[data-bs-theme="dark"] .report-info-card { background: #1e2530; border-color: #2c3543; }
[data-bs-theme="dark"] .report-info-value { color: #eef2f7; }
[data-bs-theme="dark"] .report-footer { border-color: #2c3543; }

.report-table thead th { position: sticky; top: 0; background: ${REPORT_COLORS.bg}; font-size: 10px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; color: ${REPORT_COLORS.secondary}; z-index: 1; }
.report-table td, .report-table th { padding: 10px !important; font-size: 11px; }
.report-table tbody tr:nth-child(even) { background: color-mix(in srgb, ${REPORT_COLORS.bg} 60%, transparent); }
[data-bs-theme="dark"] .report-table thead th { background: #1b2434; }
[data-bs-theme="dark"] .report-table tbody tr:nth-child(even) { background: rgba(255,255,255,.03); }

.report-empty-state { text-align: center; padding: 3rem 1rem; color: ${REPORT_COLORS.secondary}; }
.report-empty-state i { font-size: 2.25rem; opacity: .35; display: block; margin-bottom: .75rem; }

@media print {
    .no-print, .sidebar, .topbar, .portal-banner { display: none !important; }
    .main-content { margin-left: 0 !important; }
    @page { size: A4; margin: 15mm; }
    .report-table thead th { position: static; }
    .report-table thead { display: table-header-group; }
    .report-table tr { page-break-inside: avoid; }
    .report-header, .report-footer { page-break-inside: avoid; }
    .report-page-number::before { content: "Page " counter(page) " of " counter(pages); }
}
@media (max-width: 767.98px) {
    .report-table thead { display: none; }
    .report-table, .report-table tbody, .report-table tr, .report-table td { display: block; width: 100%; }
    .report-table tr { margin-bottom: .75rem; border: 1px solid ${REPORT_COLORS.border}; border-radius: 8px; padding: .25rem .5rem; }
    .report-table td { display: flex; justify-content: space-between; align-items: center; gap: .5rem; padding: .4rem .25rem !important; border: none !important; text-align: right; }
    .report-table td::before { content: attr(data-label); font-weight: 600; color: ${REPORT_COLORS.secondary}; text-align: left; }
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
${raw(reportHeaderHtml({ reportType, reportLabel: def.label, companyName, siteLogo, generatedByName, filters, filterOptions }))}
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
            <a class="btn btn-outline-success btn-sm" href="${basePath}?${filters.queryString}&report_type=${reportType}&format=xlsx"><i class="bi bi-file-earmark-excel"></i> Export Excel (.xlsx)</a>
            <a class="btn btn-outline-secondary btn-sm" href="${basePath}?${filters.queryString}&report_type=${reportType}&format=csv"><i class="bi bi-filetype-csv"></i> Export CSV</a>
            <button type="button" class="btn btn-outline-secondary btn-sm" onclick="window.print()"><i class="bi bi-file-earmark-pdf"></i> Export PDF (Print)</button>
        </div>
    </form>
</div></div>
${raw(reportKpiCardsHtml(rows, def))}
<div class="card shadow-sm">
    <div class="card-header bg-white">Results: ${rows.length} record(s)</div>
    <div class="table-responsive"><table class="table table-hover mb-0 align-middle small report-table">
        <thead><tr>${raw(def.columns.map((c) => `<th>${h(c.header)}</th>`).join(''))}</tr></thead>
        <tbody>${raw(rowsHtml || emptyStateHtml(def.columns.length))}</tbody>
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
            <td data-label="Direction">${routeLabel(r.ferry_schedule)}</td><td data-label="Purpose">${r.purpose}</td>
            <td data-label="Status">${raw(statusBadgeHtml(r.booking_status.status_name))}</td><td data-label="Seats">${r.seats}</td>
            ${showFullFilters ? html`<td data-label="Approver">${r.approver?.full_name ?? '-'}</td>` : ''}
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
${raw(reportHeaderHtml({ reportType: 'booking', reportLabel: 'Booking Report', companyName, siteLogo, generatedByName, filters, filterOptions }))}
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
            <a class="btn btn-outline-success btn-sm" href="${basePath}?${filters.queryString}&format=xlsx"><i class="bi bi-file-earmark-excel"></i> Export Excel (.xlsx)</a>
            <a class="btn btn-outline-secondary btn-sm" href="${basePath}?${filters.queryString}&format=csv"><i class="bi bi-filetype-csv"></i> Export CSV</a>
            <button type="button" class="btn btn-outline-secondary btn-sm" onclick="window.print()"><i class="bi bi-file-earmark-pdf"></i> Export PDF (Print)</button>
        </div>
    </form>
</div></div>
${raw(reportKpiCardsHtml(rows, BOOKING_REPORT_DEF))}
<div class="card shadow-sm">
    <div class="card-header bg-white">Results: ${rows.length} booking(s)</div>
    <div class="table-responsive"><table class="table table-hover mb-0 align-middle report-table">
        <thead><tr><th>ID</th><th>Employee</th><th>Department</th><th>Date</th><th>Time</th><th>Direction</th><th>Purpose</th><th>Status</th><th>Seats</th>${showFullFilters ? html`<th>Approver</th>` : ''}</tr></thead>
        <tbody>${raw(rowsHtml || emptyStateHtml(showFullFilters ? 10 : 9))}</tbody>
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
            const routeText = routeLabel(r.ferry_schedule);
            const nameLabel = r.supplier_reservations ? `${r.supplier_reservations.visitor_name} (${r.supplier_reservations.supplier_company}) [Supplier]` : r.users.full_name;
            const fields = includeApprover
                ? [r.booking_id, nameLabel, r.users.employee_id ?? '', r.users.departments?.department_name ?? '', r.travel_date, r.ferry_schedule.departure_time, routeText, r.purpose, r.booking_status.status_name, r.seats, r.approver?.full_name ?? '']
                : [r.booking_id, nameLabel, r.users.departments?.department_name ?? '', r.travel_date, r.ferry_schedule.departure_time, routeText, r.purpose, r.booking_status.status_name, r.seats];
            return fields.map(escape).join(',');
        })
        .join('\n');
    return header + body;
}

/** The default Booking Report's column list, as a { header, get } array matching REPORT_TYPES' shape - lets buildReportWorkbook() serve both report families with one implementation, without touching reportPageBody()'s own hand-written HTML row template. */
function bookingReportColumns(includeApprover) {
    const cols = [
        { header: 'ID', get: (r) => `#${r.booking_id}` },
        { header: 'Employee', get: (r) => (r.supplier_reservations ? `${r.supplier_reservations.visitor_name} (${r.supplier_reservations.supplier_company}) [Supplier]` : r.users.full_name) },
        { header: 'Department', get: (r) => r.users.departments?.department_name ?? '-' },
        { header: 'Date', get: (r) => formatDate(r.travel_date) },
        { header: 'Time', get: (r) => formatTime(r.ferry_schedule.departure_time) },
        { header: 'Direction', get: (r) => routeLabel(r.ferry_schedule) },
        { header: 'Purpose', get: (r) => r.purpose },
        { header: 'Status', get: (r) => r.booking_status.status_name },
        { header: 'Seats', get: (r) => r.seats },
    ];
    if (includeApprover) cols.push({ header: 'Approver', get: (r) => r.approver?.full_name ?? '-' });
    return cols;
}

function hexToArgb(hex) {
    return 'FF' + hex.replace('#', '').toUpperCase();
}

/**
 * A real, styled .xlsx workbook (exceljs) - Summary sheet (report info
 * + Executive Summary breakdown) + Data sheet - reusing the exact same
 * `rows`/`columns`/`def` every other export (HTML, CSV) already uses,
 * so this can never calculate or display anything differently. Native
 * Excel features applied: frozen header row, autofilter, cell borders,
 * alternating row fill, status color-coding, landscape + fit-to-width
 * print setup, and a real print header/footer with Excel's own page-
 * number codes (&P of &N) - genuinely functional in Excel's print
 * preview, unlike the CSS approximation used for browser print/PDF.
 */
async function buildReportWorkbook({ reportType, reportLabel, companyName, generatedByName, filters, filterOptions, columns, rows, def }) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = generatedByName;
    workbook.company = companyName;
    workbook.title = reportLabel;
    workbook.subject = `${companyName} - ${reportLabel}`;
    workbook.created = new Date();

    const pageHeaderFooter = {
        oddHeader: `&L&8${companyName} - ${reportLabel}&R&8Generated ${formatDateTime(new Date().toISOString())}`,
        oddFooter: `&L&8Confidential - Internal Use Only&C&8Page &P of &N&R&8${generateReportId(reportType)}`,
    };

    // ---- Summary sheet: report info + Executive Summary ----
    const summary = workbook.addWorksheet('Summary', {
        pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 } },
        headerFooter: pageHeaderFooter,
    });
    summary.columns = [{ width: 26 }, { width: 46 }, { width: 14 }];
    summary.mergeCells('A1:C1');
    summary.getCell('A1').value = `${companyName} - ${reportLabel}`;
    summary.getCell('A1').font = { size: 16, bold: true, color: { argb: hexToArgb(REPORT_COLORS.primary) } };
    summary.getRow(1).height = 26;

    let r = 3;
    const infoLines = [
        ['Report ID', generateReportId(reportType)],
        ['Generated By', generatedByName],
        ['Generated Date & Time', formatDateTime(new Date().toISOString())],
        ['Reporting Period', filters.dateFrom || filters.dateTo ? `${filters.dateFrom ? formatDate(filters.dateFrom) : 'Any'} - ${filters.dateTo ? formatDate(filters.dateTo) : 'Any'}` : 'All time'],
        ['Applied Filters', describeAppliedFilters(filters, filterOptions).replace(/&middot;/g, '|').replace(/<[^>]+>/g, '')],
    ];
    for (const [label, value] of infoLines) {
        summary.getCell(`A${r}`).value = label;
        summary.getCell(`A${r}`).font = { bold: true, size: 10, color: { argb: hexToArgb(REPORT_COLORS.secondary) } };
        summary.getCell(`B${r}`).value = value;
        r++;
    }
    r += 1;
    summary.getCell(`A${r}`).value = 'Executive Summary';
    summary.getCell(`A${r}`).font = { size: 13, bold: true, color: { argb: hexToArgb(REPORT_COLORS.primary) } };
    r += 1;
    const kpiHeaderRow = summary.getRow(r);
    kpiHeaderRow.values = ['Metric', 'Value', 'Percentage'];
    kpiHeaderRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    kpiHeaderRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(REPORT_COLORS.primary) } }; });
    r += 1;
    for (const kpi of computeKpiSummary(rows, def)) {
        const row = summary.getRow(r);
        row.getCell(1).value = kpi.label;
        row.getCell(2).value = kpi.value;
        if (kpi.percent != null) {
            row.getCell(3).value = kpi.percent / 100;
            row.getCell(3).numFmt = '0%';
        }
        if (kpi.color) row.getCell(1).font = { bold: true, color: { argb: hexToArgb(kpi.color) } };
        r++;
    }

    // ---- Data sheet: the same rows/columns as the HTML table/CSV ----
    const data = workbook.addWorksheet('Data', {
        views: [{ state: 'frozen', ySplit: 1 }],
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
        headerFooter: pageHeaderFooter,
    });
    data.columns = columns.map((c) => ({ header: c.header, width: Math.max(12, Math.min(40, c.header.length + 6)) }));
    const headerRow = data.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(REPORT_COLORS.primary) } }; });
    data.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

    const statusColumnIndexes = [];
    columns.forEach((c, i) => {
        if (STATUS_COLUMN_HEADERS.has(c.header) && def.getStatus) statusColumnIndexes.push(i + 1);
    });
    const thinBorder = { style: 'thin', color: { argb: hexToArgb(REPORT_COLORS.border) } };
    rows.forEach((rowData, i) => {
        const excelRow = data.addRow(columns.map((c, colIdx) => (statusColumnIndexes.includes(colIdx + 1) ? (def.getStatus(rowData)?.name ?? '') : (c.get(rowData) ?? ''))));
        if (i % 2 === 1) excelRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(REPORT_COLORS.bg) } }; });
        excelRow.eachCell((cell) => { cell.border = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder }; });
        for (const colIdx of statusColumnIndexes) {
            const cell = excelRow.getCell(colIdx);
            cell.font = { bold: true, color: { argb: hexToArgb(statusColor(String(cell.value))) } };
        }
    });

    return workbook.xlsx.writeBuffer();
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

    const format = url.searchParams.get('format');

    if (scope === 'admin' && reportType !== 'booking' && REPORT_TYPES[reportType]) {
        const def = REPORT_TYPES[reportType];
        const rows = await def.fetchRows(filters);
        if (format === 'csv') {
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
        if (format === 'xlsx') {
            const buffer = await buildReportWorkbook({ reportType, reportLabel: def.label, companyName, generatedByName: auth.user.full_name, filters, filterOptions, columns: def.columns, rows, def });
            const filename = `${reportType}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.xlsx`;
            return xlsxResponse(buffer, filename);
        }
        const body = genericReportBody({ reportType, rows, filters, filterOptions, basePath, companyName, siteLogo, generatedByName: auth.user.full_name });
        return renderShellForRequest({ request, auth, pageTitle: 'Reports', path: basePath, bodyHtml: body });
    }

    const rows = await fetchReportRows(filters);

    if (format === 'csv') {
        const filename = `${scope === 'admin' ? 'ferry_bookings_report' : 'booking_report'}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
        return csvResponse(toCsv(rows, scope === 'admin'), filename);
    }

    const [companyName, siteLogo, filterOptions] = await Promise.all([
        getSetting('company_name', 'Staff Ferry Transfer Portal'),
        getSetting('site_logo', ''),
        loadFilterOptions(),
    ]);

    if (format === 'xlsx') {
        const columns = bookingReportColumns(scope === 'admin');
        const buffer = await buildReportWorkbook({ reportType: 'booking', reportLabel: 'Booking Report', companyName, generatedByName: auth.user.full_name, filters, filterOptions, columns, rows, def: BOOKING_REPORT_DEF });
        const filename = `${scope === 'admin' ? 'ferry_bookings_report' : 'booking_report'}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.xlsx`;
        return xlsxResponse(buffer, filename);
    }

    const body = reportPageBody({ rows, filters, filterOptions, scope, basePath, companyName, siteLogo, generatedByName: auth.user.full_name });
    return renderShellForRequest({ request, auth, pageTitle: 'Reports', path: basePath, bodyHtml: body });
}
