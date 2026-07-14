// Automatic Ferry Booking Cut-Off - business logic. Reuses
// seatAvailability.js's getStopTimeWindow() for the real first-departure
// instant rather than recomputing it, so this can never disagree with
// the rest of the app about when a ferry actually leaves. Enforcement
// lives at the two call sites that create a real self-service-style
// booking (routes/staff.js, routes/admin_bookings.js's HR Manual
// Booking non-override path) - see 0033_booking_cutoff.sql's header for
// why every other passenger-affecting flow stays exempt automatically.

import { db, unwrap } from './db.js';
import { getStopTimeWindow } from './seatAvailability.js';
import { getSetting } from './settings.js';

/**
 * { closed, cutoffInstant, departureInstant, minutes } for one
 * schedule+date. Server time only (Date.now()) - never a client-
 * submitted value, matching the spec's "calculated using the server
 * time" requirement. `closed` is false (never blocks) when the schedule
 * has no first-departure stop configured at all - nothing to cut off
 * against.
 */
export async function getBookingCutoffInfo(scheduleId, travelDate) {
    const [{ firstDepartureInstant }, scheduleRows] = await Promise.all([
        getStopTimeWindow(scheduleId, travelDate),
        db().from('ferry_schedule').select('booking_cutoff_minutes').eq('schedule_id', scheduleId).limit(1),
    ]);
    const schedule = unwrap(scheduleRows)[0] ?? null;
    if (firstDepartureInstant == null) {
        return { closed: false, cutoffInstant: null, departureInstant: null, minutes: null };
    }

    const minutes = schedule?.booking_cutoff_minutes ?? Number(await getSetting('default_booking_cutoff_minutes', 120));
    const cutoffInstant = firstDepartureInstant - minutes * 60 * 1000;
    return { closed: Date.now() >= cutoffInstant, cutoffInstant, departureInstant: firstDepartureInstant, minutes };
}

/** One booking_cutoff_log row - mirrors every other *_log insert helper's shape in this codebase. */
export async function recordCutoffAction({ scheduleId, serviceName, travelDate, employeeUserId, employeeName, cutoffInstant, departureInstant, action, performedByUserId, reason }) {
    unwrap(
        await db()
            .from('booking_cutoff_log')
            .insert({
                schedule_id: scheduleId,
                service_name_snapshot: serviceName ?? null,
                travel_date: travelDate,
                employee_user_id: employeeUserId ?? null,
                employee_name_snapshot: employeeName ?? null,
                cutoff_instant: cutoffInstant != null ? new Date(cutoffInstant).toISOString() : null,
                departure_time_snapshot: departureInstant != null ? new Date(departureInstant).toISOString() : null,
                action,
                performed_by_user_id: performedByUserId ?? null,
                reason: reason ?? null,
            })
    );
}
