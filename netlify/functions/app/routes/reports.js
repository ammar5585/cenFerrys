// Port of admin/reports.php and manager/reports.php - filterable booking
// reports with CSV export. "Export to PDF" is the browser's print
// dialog (same as the PHP version); "Export to Excel" is the same CSV,
// which Excel opens natively.

import { db, unwrap } from '../db.js';
import { requireRole } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csvResponse } from '../response.js';
import { formatDate, formatTime } from '../format.js';
import { ROLE_ADMIN, ROLE_GM, ROLE_RM, ROLE_HR } from '../session.js';

async function fetchReportRows({ dateFrom, dateTo, deptFilter, empFilter, routeFilter, statusFilter, purpose }) {
    let query = db()
        .from('bookings')
        .select(
            'booking_id, travel_date, purpose, seats, users!bookings_user_id_fkey(user_id, full_name, department_id, departments(department_name)), ferry_schedule(departure_time, route_id, ferry_routes(route_id, direction)), booking_status(status_name), current_approver_id, approver:current_approver_id(full_name)'
        )
        .order('travel_date', { ascending: false });
    if (dateFrom) query = query.gte('travel_date', dateFrom);
    if (dateTo) query = query.lte('travel_date', dateTo);
    if (statusFilter) query = query.eq('status_id', statusFilter);
    let rows = unwrap(await query);

    if (deptFilter) rows = rows.filter((r) => r.users.department_id === deptFilter);
    if (empFilter) rows = rows.filter((r) => r.users.user_id === empFilter);
    if (routeFilter) rows = rows.filter((r) => r.ferry_schedule.ferry_routes.route_id === routeFilter);
    if (purpose) rows = rows.filter((r) => r.purpose.toLowerCase().includes(purpose.toLowerCase()));

    return rows;
}

function reportPageBody({ rows, filters, filterOptions, scope, basePath }) {
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
<h5 class="mb-3"><i class="bi bi-graph-up"></i> Booking Reports</h5>
<div class="card shadow-sm mb-3 no-print"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-2"><input type="date" name="date_from" class="form-control" value="${filters.dateFrom}"></div>
        <div class="col-md-2"><input type="date" name="date_to" class="form-control" value="${filters.dateTo}"></div>
        <div class="col-md-2"><select name="department" class="form-select"><option value="0">All Departments</option>${raw(departments.map((d) => `<option value="${d.department_id}" ${filters.deptFilter == d.department_id ? 'selected' : ''}>${h(d.department_name)}</option>`).join(''))}</select></div>
        ${showFullFilters
            ? html`
        <div class="col-md-2"><select name="employee" class="form-select"><option value="0">All Employees</option>${raw(employees.map((e) => `<option value="${e.user_id}" ${filters.empFilter == e.user_id ? 'selected' : ''}>${h(e.full_name)}</option>`).join(''))}</select></div>
        <div class="col-md-2"><select name="route" class="form-select"><option value="0">All Routes</option>${raw(routes.map((rt) => `<option value="${rt.route_id}" ${filters.routeFilter == rt.route_id ? 'selected' : ''}>${h(rt.direction)}</option>`).join(''))}</select></div>
        <div class="col-md-2"><select name="status" class="form-select"><option value="0">All Status</option>${raw(statuses.map((s) => `<option value="${s.status_id}" ${filters.statusFilter == s.status_id ? 'selected' : ''}>${h(s.status_name)}</option>`).join(''))}</select></div>
        <div class="col-md-3"><input type="text" name="purpose" class="form-control" placeholder="Purpose contains..." value="${filters.purpose}"></div>`
            : ''}
        <div class="col-md-9 d-flex align-items-end gap-2">
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
<style>@media print { .no-print, .sidebar, .topbar { display: none !important; } .main-content { margin-left: 0 !important; } }</style>`;
}

async function loadFilterOptions() {
    return {
        departments: unwrap(await db().from('departments').select('*').order('department_name')),
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
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        return handleReport(request, auth, 'admin', '/admin/reports');
    });

    router.get('/manager/reports', async (request) => {
        const auth = await requireRole(request, [ROLE_GM, ROLE_RM, ROLE_HR]);
        if (auth.response) return auth.response;
        return handleReport(request, auth, 'manager', '/manager/reports');
    });
}

async function handleReport(request, auth, scope, basePath) {
    const url = new URL(request.url);
    const filters = {
        dateFrom: url.searchParams.get('date_from') || '',
        dateTo: url.searchParams.get('date_to') || '',
        deptFilter: Number(url.searchParams.get('department') || 0),
        empFilter: scope === 'admin' ? Number(url.searchParams.get('employee') || 0) : 0,
        routeFilter: scope === 'admin' ? Number(url.searchParams.get('route') || 0) : 0,
        statusFilter: scope === 'admin' ? Number(url.searchParams.get('status') || 0) : 0,
        purpose: scope === 'admin' ? url.searchParams.get('purpose') || '' : '',
    };
    filters.queryString = new URLSearchParams({
        date_from: filters.dateFrom,
        date_to: filters.dateTo,
        department: String(filters.deptFilter),
        ...(scope === 'admin' ? { employee: String(filters.empFilter), route: String(filters.routeFilter), status: String(filters.statusFilter), purpose: filters.purpose } : {}),
    }).toString();

    const rows = await fetchReportRows(filters);

    if (url.searchParams.get('format') === 'csv') {
        const filename = `${scope === 'admin' ? 'ferry_bookings_report' : 'booking_report'}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
        return csvResponse(toCsv(rows, scope === 'admin'), filename);
    }

    const filterOptions = await loadFilterOptions();
    const body = reportPageBody({ rows, filters, filterOptions, scope, basePath });
    return renderShellForRequest({ request, auth, pageTitle: 'Reports', path: basePath, bodyHtml: body });
}
