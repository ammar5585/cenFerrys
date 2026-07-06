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

        // Direction names are admin-managed (Direction Management), not a
        // fixed set - an unrecognized value just matches zero routes below
        // and falls through to the existing "no such route" empty result,
        // same as this file's other invalid-input handling.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !direction) {
            return jsonResponse({ success: false, schedules: [] });
        }

        // Any unexpected failure below (a transient DB/RPC error, etc.) must
        // still come back as valid JSON - letting it bubble up to the
        // catch-all handler would return an HTML error page instead, which
        // breaks the client's response.json() call and shows a useless
        // "unable to load" message with no indication of what went wrong.
        try {
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
            const matching = schedules.filter((s) => Array.isArray(s.weekdays) && s.weekdays.includes(weekday));

            const result = [];
            for (const s of matching) {
                const { capacity, booked, reserved, remaining } = await getRemainingSeats(s.schedule_id, date);
                result.push({
                    schedule_id: s.schedule_id,
                    time_label: formatTime(s.departure_time),
                    capacity,
                    booked,
                    reserved,
                    remaining,
                });
            }

            return jsonResponse({ success: true, schedules: result });
        } catch (err) {
            return jsonResponse({ success: false, message: `Could not load ferry schedules: ${err.message}`, schedules: [] });
        }
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
