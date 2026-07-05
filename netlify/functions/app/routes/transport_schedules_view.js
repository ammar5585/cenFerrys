// Port of transport/schedules_view.php - read-only schedule + seat
// utilization view (schedule CRUD stays admin-only).

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw } from '../templates/html.js';
import { getRemainingSeats } from '../seats.js';
import { formatTime } from '../format.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function registerTransportSchedulesViewRoutes(router) {
    router.get('/transport/schedules_view', async (request) => {
        const auth = await requirePermission(request, 'booking.view_transport_schedules', { pageTitle: 'Ferry Schedules' });
        if (auth.response) return auth.response;

        const url = new URL(request.url);
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const weekday = WEEKDAY_ABBR[new Date(`${date}T00:00:00Z`).getUTCDay()];

        const schedules = unwrap(
            await db()
                .from('ferry_schedule')
                .select('schedule_id, departure_time, capacity, notes, weekdays, ferry_routes(direction)')
                .eq('status', 'active')
        );
        const todays = schedules.filter((s) => s.weekdays.includes(weekday)).sort((a, b) => (a.ferry_routes.direction + a.departure_time).localeCompare(b.ferry_routes.direction + b.departure_time));

        const rowsHtml = [];
        for (const s of todays) {
            const { booked, remaining } = await getRemainingSeats(s.schedule_id, date);
            rowsHtml.push(
                html`<tr>
                <td>${s.ferry_routes.direction}</td><td>${formatTime(s.departure_time)}</td><td>${s.capacity}</td><td>${booked}</td>
                <td class="${remaining <= 0 ? 'seat-full' : 'seat-ok'}">${remaining <= 0 ? 'FULL' : remaining}</td>
                <td class="text-muted small">${s.notes ?? ''}</td>
            </tr>`.toString()
            );
        }

        const body = html`
<h5 class="mb-3"><i class="bi bi-calendar3"></i> Ferry Schedules &amp; Seat Utilization</h5>
<form method="get" class="mb-3 row g-2">
    <div class="col-md-3"><input type="date" name="date" class="form-control" value="${date}"></div>
    <div class="col-md-2"><button class="btn btn-outline-primary btn-sm w-100" type="submit">View</button></div>
</form>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Direction</th><th>Departure</th><th>Capacity</th><th>Booked</th><th>Remaining</th><th>Notes</th></tr></thead>
    <tbody>${raw(rowsHtml.join('') || '<tr><td colspan="6" class="text-center text-muted py-4">No schedules operate on this date.</td></tr>')}</tbody>
</table></div></div>`;

        return renderShellForRequest({ request, auth, pageTitle: 'Ferry Schedules', path: '/transport/schedules_view', bodyHtml: body });
    });
}
