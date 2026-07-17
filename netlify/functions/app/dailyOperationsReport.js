// Automated Daily Operations Report Email - data aggregation. Almost
// everything here reuses existing functions rather than new queries:
// Ferry/Resort/Seat Allocation Summary all come straight from
// getLiveFerryAvailability() (seatAvailability.js), which already
// computes exactly these fields per ferry for a travel date. Only
// Department Summary and Security Summary are genuinely new (small)
// queries - nothing else in the app already groups by department or
// summarizes security_action_log for a single date.

import { db, unwrap } from './db.js';
import { getLiveFerryAvailability } from './seatAvailability.js';
import { getAllDepartments } from './refData.js';
import { formatDate, formatTime } from './format.js';
import { REPORT_COLORS, hexToArgb, statusColor } from './routes/reports.js';
import ExcelJS from 'exceljs';

const MALDIVES_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Today's date in Maldives local time (UTC+5) - each file in this app computes this independently rather than sharing a helper, matching the established convention (see seatAvailability.js's own todayInMaldives()). */
export function todayInMaldives() {
    return new Date(Date.now() + MALDIVES_OFFSET_MS).toISOString().slice(0, 10);
}

const NON_COUNTED_STATUSES = ['Rejected', 'Cancelled', 'Expired'];

async function getBookingAndPassengerSummary(travelDate) {
    const rows = unwrap(await db().from('bookings').select('seats, booking_status(status_name)').eq('travel_date', travelDate));
    const booking = { total: 0, approved: 0, pending: 0, rejected: 0, cancelled: 0 };
    const passenger = { checkedIn: 0, departed: 0, arrived: 0, noShow: 0, waitingList: 0 };
    for (const r of rows) {
        const name = r.booking_status?.status_name;
        booking.total++;
        if (name === 'Approved' || name === 'Confirmed' || name === 'Completed') booking.approved++;
        else if (name === 'Rejected') booking.rejected++;
        else if (name === 'Cancelled') booking.cancelled++;
        else if (!NON_COUNTED_STATUSES.includes(name)) booking.pending++;

        if (name === 'Checked-In') passenger.checkedIn++;
        else if (name === 'Departed') passenger.departed++;
        else if (name === 'Arrived') passenger.arrived++;
        else if (name === 'No Show') passenger.noShow++;
        else if (name === 'Waiting List') passenger.waitingList++;
    }
    return { booking, passenger };
}

async function getDepartmentSummary(travelDate) {
    const [departments, rows] = await Promise.all([
        getAllDepartments(),
        db()
            .from('bookings')
            .select('seats, users!bookings_user_id_fkey(department_id), booking_status(status_name)')
            .eq('travel_date', travelDate)
            .then(unwrap),
    ]);
    const totalsByDept = new Map();
    for (const r of rows) {
        if (NON_COUNTED_STATUSES.includes(r.booking_status?.status_name)) continue;
        const deptId = r.users?.department_id ?? null;
        totalsByDept.set(deptId, (totalsByDept.get(deptId) ?? 0) + r.seats);
    }
    return departments
        .filter((d) => totalsByDept.has(d.department_id))
        .map((d) => ({ departmentName: d.department_name, totalPassengers: totalsByDept.get(d.department_id) }))
        .sort((a, b) => b.totalPassengers - a.totalPassengers);
}

async function getSecuritySummary(travelDate) {
    // security_action_log.created_at is a genuine UTC instant, not a
    // travel_date column - the "day" boundary here is the Maldives
    // calendar day travelDate falls on, so bookings/actions logged
    // just after midnight UTC (which is 5am Maldives) aren't split
    // across the wrong day.
    const startUtc = new Date(`${travelDate}T00:00:00Z`).getTime() - MALDIVES_OFFSET_MS;
    const endUtc = startUtc + 24 * 60 * 60 * 1000;
    const rows = unwrap(
        await db()
            .from('security_action_log')
            .select('action')
            .gte('created_at', new Date(startUtc).toISOString())
            .lt('created_at', new Date(endUtc).toISOString())
    );
    const summary = { checkedIn: 0, departed: 0, arrived: 0, noShow: 0, waitingListPromotions: 0 };
    for (const r of rows) {
        if (r.action === 'check_in') summary.checkedIn++;
        else if (r.action === 'departed') summary.departed++;
        else if (r.action === 'arrived') summary.arrived++;
        else if (r.action === 'no_show') summary.noShow++;
        else if (r.action === 'promoted') summary.waitingListPromotions++;
    }
    return summary;
}

/** Assembles every Daily Operations Report section for one travel date. Ferry/Resort/Seat Allocation Summary are all derived from the same getLiveFerryAvailability() call - one query batch, not one per section. */
export async function getDailyOperationsReportData(travelDate) {
    const [cards, { booking, passenger }, departmentSummary, securitySummary] = await Promise.all([
        getLiveFerryAvailability({ travelDate, filters: {} }),
        getBookingAndPassengerSummary(travelDate),
        getDepartmentSummary(travelDate),
        getSecuritySummary(travelDate),
    ]);

    const ferrySummary = cards.map((c) => ({
        ferryName: c.serviceName ?? c.label,
        route: c.routeSnapshot ?? c.label,
        travelDate,
        departureTime: c.departureTime,
        arrivalTime: c.arrivalTime,
        capacity: c.capacity,
        seatsUsed: c.booked,
        availableSeats: c.available,
        occupancyPercent: c.utilization.percentFull,
    }));

    // Resort Summary (CGLM/CMLM totals) - summed across every ferry's
    // per-resort breakdown for the date. Prefers the Resort Capacity
    // Allocator's authoritative split (resortAllocation) when a service
    // has one configured, else the shared-pool breakdown - same
    // precedence the Live Ferry Availability Dashboard already uses.
    const resortTotals = new Map();
    for (const c of cards) {
        if (c.resortAllocation) {
            for (const r of c.resortAllocation) {
                const t = resortTotals.get(r.resort_name) ?? { totalPassengers: 0, totalBookings: 0, availableCapacity: 0 };
                t.totalPassengers += r.booked;
                t.availableCapacity += r.remaining;
                resortTotals.set(r.resort_name, t);
            }
        } else {
            for (const r of c.resortBreakdown) {
                const t = resortTotals.get(r.resortName) ?? { totalPassengers: 0, totalBookings: 0, availableCapacity: 0 };
                t.totalPassengers += r.occupied;
                t.availableCapacity += r.available;
                resortTotals.set(r.resortName, t);
            }
        }
    }
    const resortSummary = [...resortTotals.entries()].map(([resortName, t]) => ({ resortName, ...t }));

    // Seat Allocation Summary - summed across every ferry's
    // passengerBreakdown (built for the Ferry Booking View Toggle's
    // Ferry Details modal - same categories, same VIP/Executive-
    // combined precedent, not re-litigated here).
    const seatAllocationSummary = { staff: 0, hodReserved: 0, hrReserved: 0, supplierVisits: 0, vipExecutiveReserved: 0 };
    for (const c of cards) {
        seatAllocationSummary.staff += c.passengerBreakdown.staff;
        seatAllocationSummary.hodReserved += c.passengerBreakdown.hodReserved;
        seatAllocationSummary.hrReserved += c.passengerBreakdown.hrReserved;
        seatAllocationSummary.supplierVisits += c.passengerBreakdown.supplierVisits;
        seatAllocationSummary.vipExecutiveReserved += c.passengerBreakdown.vipExecutiveReserved;
    }

    return { travelDate, bookingSummary: booking, passengerSummary: passenger, ferrySummary, resortSummary, departmentSummary, securitySummary, seatAllocationSummary };
}

/** Simple inline-styled HTML email body - email clients don't support external stylesheets, so this is deliberately plain inline HTML, not the Reports page's full enterprise CSS. */
export function dailyOperationsEmailHtml(data, { companyName }) {
    const th = 'padding:6px 10px;text-align:left;font-size:11px;color:#475569;border-bottom:1px solid #E2E8F0;';
    const td = 'padding:6px 10px;font-size:12px;border-bottom:1px solid #E2E8F0;';
    const section = (title, rows) => `<h3 style="font-size:14px;color:#0F172A;margin:20px 0 8px;">${title}</h3><table style="border-collapse:collapse;width:100%;">${rows}</table>`;
    const kpiRow = (label, value) => `<tr><td style="${td}">${label}</td><td style="${td}text-align:right;font-weight:600;">${value}</td></tr>`;

    const bookingRows = [
        kpiRow('Total Bookings', data.bookingSummary.total),
        kpiRow('Approved', data.bookingSummary.approved),
        kpiRow('Pending', data.bookingSummary.pending),
        kpiRow('Rejected', data.bookingSummary.rejected),
        kpiRow('Cancelled', data.bookingSummary.cancelled),
    ].join('');

    const passengerRows = [
        kpiRow('Checked-In', data.passengerSummary.checkedIn),
        kpiRow('Departed', data.passengerSummary.departed),
        kpiRow('Arrived', data.passengerSummary.arrived),
        kpiRow('No Shows', data.passengerSummary.noShow),
        kpiRow('Waiting List', data.passengerSummary.waitingList),
    ].join('');

    const ferryHeader = `<tr><th style="${th}">Ferry</th><th style="${th}">Route</th><th style="${th}">Departure</th><th style="${th}">Arrival</th><th style="${th}">Used/Capacity</th><th style="${th}">Occupancy</th></tr>`;
    const ferryRows = data.ferrySummary
        .map(
            (f) =>
                `<tr><td style="${td}">${f.ferryName}</td><td style="${td}">${f.route}</td><td style="${td}">${formatTime(f.departureTime)}</td><td style="${td}">${f.arrivalTime ? formatTime(f.arrivalTime) : '-'}</td><td style="${td}">${f.seatsUsed}/${f.capacity}</td><td style="${td}">${f.occupancyPercent}%</td></tr>`
        )
        .join('');

    const resortHeader = `<tr><th style="${th}">Resort</th><th style="${th}">Total Passengers</th><th style="${th}">Available Capacity</th></tr>`;
    const resortRows = data.resortSummary.map((r) => `<tr><td style="${td}">${r.resortName}</td><td style="${td}">${r.totalPassengers}</td><td style="${td}">${r.availableCapacity}</td></tr>`).join('');

    const deptHeader = `<tr><th style="${th}">Department</th><th style="${th}">Total Passengers</th></tr>`;
    const deptRows = data.departmentSummary.map((d) => `<tr><td style="${td}">${d.departmentName}</td><td style="${td}">${d.totalPassengers}</td></tr>`).join('');

    const securityRows = [
        kpiRow('Checked-In', data.securitySummary.checkedIn),
        kpiRow('Departed', data.securitySummary.departed),
        kpiRow('Arrived', data.securitySummary.arrived),
        kpiRow('No Shows', data.securitySummary.noShow),
        kpiRow('Waiting List Promotions', data.securitySummary.waitingListPromotions),
    ].join('');

    const seatRows = [
        kpiRow('Staff Seats', data.seatAllocationSummary.staff),
        kpiRow('HOD Reserved Seats', data.seatAllocationSummary.hodReserved),
        kpiRow('HR Reserved Seats', data.seatAllocationSummary.hrReserved),
        kpiRow('VIP/Executive Seats', data.seatAllocationSummary.vipExecutiveReserved),
        kpiRow('Supplier Visit Seats', data.seatAllocationSummary.supplierVisits),
    ].join('');

    return `<div style="font-family:Arial,Helvetica,sans-serif;color:#0F172A;max-width:700px;">
<h2 style="font-size:18px;margin-bottom:0;">${companyName} - Daily Operations Report</h2>
<p style="color:#475569;font-size:12px;margin-top:4px;">${formatDate(data.travelDate)}</p>
${section('Booking Summary', bookingRows)}
${section('Passenger Summary', passengerRows)}
${section('Ferry Summary', ferryHeader + ferryRows)}
${section('Resort Summary', resortHeader + resortRows)}
${data.departmentSummary.length ? section('Department Summary', deptHeader + deptRows) : ''}
${section('Security Summary', securityRows)}
${section('Seat Allocation Summary', seatRows)}
<p style="color:#94A3B8;font-size:9px;margin-top:24px;">Automatically Generated Report &middot; ${companyName} Staff Transfer Portal &middot; Confidential - Internal Use Only</p>
</div>`;
}

/** One Excel workbook, one sheet per section - same styling constants as reports.js's buildReportWorkbook() (imported, not duplicated). */
export async function buildDailyOperationsWorkbook(data, { companyName, generatedByName }) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = generatedByName;
    workbook.company = companyName;
    workbook.title = 'Daily Operations Report';
    workbook.created = new Date();

    function addTable(sheetName, columns, rows) {
        const sheet = workbook.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
        sheet.columns = columns.map((c) => ({ header: c.header, width: Math.max(14, c.header.length + 4) }));
        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(REPORT_COLORS.primary) } };
        });
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
        for (const row of rows) sheet.addRow(columns.map((c) => c.get(row)));
        return sheet;
    }

    addTable(
        'Ferry Summary',
        [
            { header: 'Ferry Name', get: (r) => r.ferryName },
            { header: 'Route', get: (r) => r.route },
            { header: 'Travel Date', get: (r) => formatDate(r.travelDate) },
            { header: 'Departure Time', get: (r) => formatTime(r.departureTime) },
            { header: 'Arrival Time', get: (r) => (r.arrivalTime ? formatTime(r.arrivalTime) : '-') },
            { header: 'Capacity', get: (r) => r.capacity },
            { header: 'Seats Used', get: (r) => r.seatsUsed },
            { header: 'Available Seats', get: (r) => r.availableSeats },
            { header: 'Occupancy %', get: (r) => r.occupancyPercent / 100 },
        ],
        data.ferrySummary
    );
    workbook.getWorksheet('Ferry Summary').getColumn(9).numFmt = '0%';

    addTable(
        'Resort Summary',
        [
            { header: 'Resort', get: (r) => r.resortName },
            { header: 'Total Passengers', get: (r) => r.totalPassengers },
            { header: 'Available Capacity', get: (r) => r.availableCapacity },
        ],
        data.resortSummary
    );

    addTable(
        'Department Summary',
        [
            { header: 'Department', get: (r) => r.departmentName },
            { header: 'Total Passengers', get: (r) => r.totalPassengers },
        ],
        data.departmentSummary
    );

    const summarySheet = addTable(
        'Summary',
        [
            { header: 'Metric', get: (r) => r.label },
            { header: 'Value', get: (r) => r.value },
        ],
        [
            { label: 'Total Bookings', value: data.bookingSummary.total },
            { label: 'Approved', value: data.bookingSummary.approved },
            { label: 'Pending', value: data.bookingSummary.pending },
            { label: 'Rejected', value: data.bookingSummary.rejected },
            { label: 'Cancelled', value: data.bookingSummary.cancelled },
            { label: 'Checked-In (Passengers)', value: data.passengerSummary.checkedIn },
            { label: 'Departed (Passengers)', value: data.passengerSummary.departed },
            { label: 'Arrived (Passengers)', value: data.passengerSummary.arrived },
            { label: 'No Shows (Passengers)', value: data.passengerSummary.noShow },
            { label: 'Waiting List (Passengers)', value: data.passengerSummary.waitingList },
            { label: 'Security - Checked-In', value: data.securitySummary.checkedIn },
            { label: 'Security - Departed', value: data.securitySummary.departed },
            { label: 'Security - Arrived', value: data.securitySummary.arrived },
            { label: 'Security - No Shows', value: data.securitySummary.noShow },
            { label: 'Security - Waiting List Promotions', value: data.securitySummary.waitingListPromotions },
            { label: 'Staff Seats', value: data.seatAllocationSummary.staff },
            { label: 'HOD Reserved Seats', value: data.seatAllocationSummary.hodReserved },
            { label: 'HR Reserved Seats', value: data.seatAllocationSummary.hrReserved },
            { label: 'VIP/Executive Seats', value: data.seatAllocationSummary.vipExecutiveReserved },
            { label: 'Supplier Visit Seats', value: data.seatAllocationSummary.supplierVisits },
        ]
    );
    workbook.worksheets.unshift(workbook.worksheets.splice(workbook.worksheets.indexOf(summarySheet), 1)[0]);

    return workbook.xlsx.writeBuffer();
}
