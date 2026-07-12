// Port of ajax/get_schedule_seats.php and ajax/mark_notifications_read.php.

import { db, unwrap } from '../db.js';
import { getRemainingSeatsBatch } from '../seats.js';
import { formatTime } from '../format.js';
import { getSession } from '../session.js';
import { verifyCsrf } from '../csrf.js';
import { markAllNotificationsRead } from '../notifications.js';
import { jsonResponse, htmlResponse } from '../response.js';
import { getWholeRouteDirections } from '../ferryServices.js';
import { getLiveFerryAvailability } from '../seatAvailability.js';
import { bookingCardsFragment, getReturnCandidateCards } from './staff.js';

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

            // Two sources merged: legacy ferry_routes-linked schedules (the
            // original single-leg model - still supported for any schedule
            // that hasn't been given route_stops), and Ferry Services
            // (admin_ferry_services.js) matched by their whole configured
            // route ("First Stop to Last Stop") - a service has no
            // ferry_routes row at all (route_id is NULL by design), so it
            // would never surface here otherwise.
            const routeRows = unwrap(await db().from('ferry_routes').select('route_id').eq('direction', direction).limit(1));
            const legacySchedules = routeRows.length
                ? unwrap(
                      await db()
                          .from('ferry_schedule')
                          .select('schedule_id, departure_time, capacity, weekdays')
                          .eq('route_id', routeRows[0].route_id)
                          .eq('status', 'active')
                          .order('departure_time', { ascending: true })
                  )
                : [];

            const wholeRouteDirections = await getWholeRouteDirections();
            const serviceMatches = wholeRouteDirections.filter((d) => d.direction === direction);

            const byScheduleId = new Map();
            for (const s of legacySchedules) {
                if (Array.isArray(s.weekdays) && s.weekdays.includes(weekday)) {
                    byScheduleId.set(s.schedule_id, { schedule_id: s.schedule_id, capacity: s.capacity, departure_time: s.departure_time, arrival_time: null });
                }
            }
            for (const d of serviceMatches) {
                if (Array.isArray(d.weekdays) && d.weekdays.includes(weekday)) {
                    // A route-stops match is the richer source (has a real
                    // arrival time) - it wins over a legacy entry for the
                    // same schedule_id, if somehow both matched.
                    byScheduleId.set(d.scheduleId, { schedule_id: d.scheduleId, capacity: d.capacity, departure_time: d.boardingTime, arrival_time: d.arrivalTime });
                }
            }
            const matching = [...byScheduleId.values()].sort((a, b) => (a.departure_time > b.departure_time ? 1 : -1));

            // One batched RPC call instead of one per schedule - see
            // getRemainingSeatsBatch()'s header comment.
            const seatInfoById = await getRemainingSeatsBatch(matching.map((s) => s.schedule_id), date);
            const result = matching.map((s) => {
                const info = seatInfoById.get(s.schedule_id) ?? { capacity: s.capacity, booked: 0, reserved: 0, remaining: s.capacity };
                return {
                    schedule_id: s.schedule_id,
                    time_label: formatTime(s.departure_time),
                    arrival_label: s.arrival_time ? formatTime(s.arrival_time) : '',
                    capacity: info.capacity,
                    booked: info.booked,
                    reserved: info.reserved,
                    remaining: info.remaining,
                };
            });

            return jsonResponse({ success: true, schedules: result });
        } catch (err) {
            return jsonResponse({ success: false, message: `Could not load ferry schedules: ${err.message}`, schedules: [] });
        }
    });

    // GET - returns a rendered HTML fragment (this app has no client-side
    // templating anywhere - see routes/seat_availability.js's own
    // fragment endpoint for the established precedent), used both for
    // the New Ferry Booking page's initial render's polling refresh and
    // for loading return-ferry candidates once an outbound is picked.
    router.get('/ajax/booking_cards', async (request) => {
        const { user } = await getSession(request);
        if (!user) return htmlResponse('<div class="col-12 text-danger small">Your session has expired. Please <a href="/auth/login">log in again</a>.</div>', { status: 401 });

        const url = new URL(request.url);
        const travelDate = url.searchParams.get('date') || '';
        const leg = url.searchParams.get('leg') === 'return' ? 'return' : 'outbound';
        const filters = {
            q: url.searchParams.get('q') || '',
            resortName: url.searchParams.get('resort') || '',
            boardingLocation: url.searchParams.get('boarding') || '',
            destination: url.searchParams.get('destination') || '',
        };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) return htmlResponse('<div class="col-12 text-muted small">Please choose a valid travel date.</div>');

        try {
            if (leg === 'return') {
                const outboundScheduleId = Number(url.searchParams.get('outbound_schedule_id') || 0);
                if (!outboundScheduleId) return htmlResponse('<div class="col-12 text-muted small">Select an outbound ferry first.</div>');
                const cards = await getReturnCandidateCards({ outboundScheduleId, travelDate, filters });
                return htmlResponse(bookingCardsFragment(cards, 'return'));
            }
            const cards = await getLiveFerryAvailability({ travelDate, filters });
            return htmlResponse(bookingCardsFragment(cards, 'outbound'));
        } catch (err) {
            console.error('booking_cards fragment failed:', err?.message || err);
            return htmlResponse(`<div class="col-12 text-danger small">Could not load ferry schedules. <a href="#" class="retry-schedules retry-return">Retry</a></div>`);
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
