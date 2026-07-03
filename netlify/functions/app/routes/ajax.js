// Port of ajax/get_schedule_seats.php and ajax/mark_notifications_read.php.

import { db, unwrap } from '../db.js';
import { getRemainingSeats } from '../seats.js';
import { formatTime } from '../format.js';
import { getSession } from '../session.js';
import { verifyCsrf } from '../csrf.js';
import { markAllNotificationsRead } from '../notifications.js';
import { jsonResponse } from '../response.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function registerAjaxRoutes(router) {
    // GET - read-only, no CSRF check needed (mirrors the PHP version).
    router.get('/ajax/get_schedule_seats', async (request) => {
        const { user } = await getSession(request);
        if (!user) return jsonResponse({ success: false, message: 'Not authenticated', schedules: [] }, { status: 401 });

        const url = new URL(request.url);
        const date = url.searchParams.get('date') || '';
        const direction = url.searchParams.get('direction') || '';

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['Resort to City', 'City to Resort'].includes(direction)) {
            return jsonResponse({ success: false, schedules: [] });
        }

        const weekday = WEEKDAY_ABBR[new Date(`${date}T00:00:00Z`).getUTCDay()];

        const routeRows = unwrap(
            await db().from('ferry_routes').select('route_id').eq('direction', direction).limit(1)
        );
        if (!routeRows.length) return jsonResponse({ success: true, schedules: [] });

        const schedules = unwrap(
            await db()
                .from('ferry_schedule')
                .select('schedule_id, departure_time, capacity, weekdays')
                .eq('route_id', routeRows[0].route_id)
                .eq('status', 'active')
                .order('departure_time', { ascending: true })
        );
        const matching = schedules.filter((s) => s.weekdays.includes(weekday));

        const result = [];
        for (const s of matching) {
            const { capacity, booked, remaining } = await getRemainingSeats(s.schedule_id, date);
            result.push({
                schedule_id: s.schedule_id,
                time_label: formatTime(s.departure_time),
                capacity,
                booked,
                remaining,
            });
        }

        return jsonResponse({ success: true, schedules: result });
    });

    // POST - mutates state, so CSRF-checked (matches main.js's postJSON, which
    // sends csrf_token in the URL-encoded body, not a header).
    router.post('/ajax/mark_notifications_read', async (request) => {
        const { user } = await getSession(request);
        if (!user) return jsonResponse({ success: false }, { status: 401 });

        const form = await request.formData();
        const submitted = form.get('csrf_token');
        if (!verifyCsrf(user.csrf, submitted)) {
            return jsonResponse({ success: false, message: 'Invalid request' }, { status: 403 });
        }

        await markAllNotificationsRead(user.user_id);
        return jsonResponse({ success: true });
    });
}
