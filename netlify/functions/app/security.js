// Security Operations Module business logic: waiting-list FIFO lookup
// and promotion, passenger movement recording (check-in/departed/
// no-show/arrived), and ferry-trip completion detection. Mirrors
// approval.js's role as the module's business-logic file - route
// handlers in routes/security.js stay thin and call into this.

import { db, unwrap } from './db.js';
import { getStatusId } from './approval.js';
import { getRemainingSeats } from './seats.js';
import { createNotification } from './notifications.js';
import { ROLE_SECURITY } from './session.js';

/** Every active Security user - used to notify when a seat frees up or a trip completes. */
async function getActiveSecurityUsers() {
    return unwrap(
        await db()
            .from('users')
            .select('user_id, roles!inner(role_name)')
            .eq('status', 'active')
            .eq('roles.role_name', ROLE_SECURITY)
    );
}

/**
 * Waiting-list bookings for a specific trip (same schedule + travel
 * date - the spec's exact promotion-eligibility filter), FIFO order.
 * A trip's resort is implicit in the booker's own resort_id, not a
 * column on the schedule itself (ferry_schedule has no resort scoping
 * today - see the plan doc), so resort just comes along for display.
 */
export async function getWaitingList(scheduleId, travelDate) {
    const waitingListStatusId = await getStatusId('Waiting List');
    return unwrap(
        await db()
            .from('bookings')
            .select(
                'booking_id, user_id, seats, purpose, remarks, created_at, users!bookings_user_id_fkey(full_name, employee_id, department_id, resort_id, departments(department_name), resorts(resort_name))'
            )
            .eq('schedule_id', scheduleId)
            .eq('travel_date', travelDate)
            .eq('status_id', waitingListStatusId)
            .order('created_at', { ascending: true })
    );
}

/**
 * Promotes one waiting-list booking to Approved - shared by both the
 * FIFO "Promote Next" action (method: 'automatic', no explicit pick)
 * and the Admin/HR manual override (method: 'manual', caller picked a
 * specific bookingId, possibly not the first in line). Re-checks a seat
 * is actually free first: the waiting list can go stale between when
 * Security viewed it and when they click Promote.
 */
export async function promoteWaitingListBooking(bookingId, { promotedByUserId, method, reason, originalBookingId }) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('user_id, schedule_id, travel_date, status_id, users!bookings_user_id_fkey(department_id, resort_id)')
            .eq('booking_id', bookingId)
            .limit(1)
    );
    const booking = rows[0];
    if (!booking) return { promoted: false, reason: 'not_found' };

    const waitingListStatusId = await getStatusId('Waiting List');
    if (booking.status_id !== waitingListStatusId) {
        return { promoted: false, reason: 'not_on_waiting_list' };
    }

    const { remaining } = await getRemainingSeats(booking.schedule_id, booking.travel_date);
    if (remaining <= 0) {
        return { promoted: false, reason: 'no_seat_available' };
    }

    const approvedId = await getStatusId('Approved');
    unwrap(await db().from('bookings').update({ status_id: approvedId }).eq('booking_id', bookingId));

    unwrap(
        await db().from('security_action_log').insert({
            booking_id: bookingId,
            action: 'promoted',
            previous_status_id: waitingListStatusId,
            new_status_id: approvedId,
            security_officer_id: promotedByUserId,
            resort_id: booking.users?.resort_id ?? null,
            department_id: booking.users?.department_id ?? null,
            schedule_id: booking.schedule_id,
            original_booking_id: originalBookingId ?? null,
            promotion_method: method,
            promotion_reason: reason ?? null,
        })
    );

    await createNotification(
        booking.user_id,
        'A seat has become available - your waitlisted ferry booking has been approved.',
        'booking',
        bookingId
    );

    return { promoted: true };
}

/**
 * If a schedule+date now has both a freed seat and a non-empty waiting
 * list, notify every active Security user with the exact prompt the
 * spec asks for - promotion itself is a deliberate Security/Admin/HR
 * action (Promote Next / Skip / View Waiting List), never automatic.
 */
export async function notifySecurityIfWaitingList(scheduleId, travelDate) {
    const waitingList = await getWaitingList(scheduleId, travelDate);
    if (!waitingList.length) return;

    const { remaining } = await getRemainingSeats(scheduleId, travelDate);
    if (remaining <= 0) return;

    const securityUsers = await getActiveSecurityUsers();
    for (const s of securityUsers) {
        await createNotification(
            s.user_id,
            'One seat has become available. Promote the next waiting list passenger?',
            'booking'
        );
    }
}

const MOVEMENT_STATUS_NAME = {
    check_in: 'Checked-In',
    departed: 'Departed',
    no_show: 'No Show',
    arrived: 'Arrived',
};

const MOVEMENT_TIMESTAMP_COLUMN = {
    check_in: 'checked_in_at',
    departed: 'departed_at',
    arrived: 'arrived_at',
};

const MOVEMENT_NOTIFICATION = {
    check_in: 'You have been checked in for your ferry.',
    departed: 'Your ferry has departed.',
    no_show: 'You were marked as a no-show for your ferry booking - your seat has been released.',
    arrived: 'Your ferry has arrived.',
};

/**
 * Records one passenger-movement action (check-in/departed/no-show/
 * arrived): updates the booking's status (+ timestamp column where one
 * exists), writes the structured security_action_log row, notifies the
 * passenger, and - for No Show specifically - checks whether a waiting
 * list can now be prompted for promotion (a released seat is
 * immediately available per the spec's business rules).
 */
export async function recordMovement(bookingId, action, { officerId, remarks }) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('user_id, schedule_id, travel_date, status_id, users!bookings_user_id_fkey(department_id, resort_id)')
            .eq('booking_id', bookingId)
            .limit(1)
    );
    const booking = rows[0];
    if (!booking) return { updated: false, reason: 'not_found' };

    const newStatusName = MOVEMENT_STATUS_NAME[action];
    if (!newStatusName) return { updated: false, reason: 'invalid_action' };

    const newStatusId = await getStatusId(newStatusName);
    const update = { status_id: newStatusId };
    const timestampColumn = MOVEMENT_TIMESTAMP_COLUMN[action];
    if (timestampColumn) update[timestampColumn] = new Date().toISOString();

    unwrap(await db().from('bookings').update(update).eq('booking_id', bookingId));

    unwrap(
        await db().from('security_action_log').insert({
            booking_id: bookingId,
            action,
            previous_status_id: booking.status_id,
            new_status_id: newStatusId,
            security_officer_id: officerId,
            remarks: remarks || null,
            resort_id: booking.users?.resort_id ?? null,
            department_id: booking.users?.department_id ?? null,
            schedule_id: booking.schedule_id,
        })
    );

    await createNotification(booking.user_id, MOVEMENT_NOTIFICATION[action], 'booking', bookingId);

    if (action === 'no_show') {
        await notifySecurityIfWaitingList(booking.schedule_id, booking.travel_date);
    }
    if (action === 'arrived') {
        await checkTripCompletion(booking.schedule_id, booking.travel_date);
    }

    return { updated: true };
}

/**
 * A ferry trip (schedule + travel date) is "Completed" once every
 * non-cancelled/non-no-show/non-rejected booking on it has actually
 * been marked Arrived - computed on the fly (there's no separate
 * "trip" row to update; every field needed to derive this already
 * exists on bookings/booking_status). Fires a one-time notification to
 * Security and Transport Coordinators when that becomes true.
 */
export async function checkTripCompletion(scheduleId, travelDate) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, booking_status(status_name)')
            .eq('schedule_id', scheduleId)
            .eq('travel_date', travelDate)
    );
    const relevant = rows.filter((b) => !['Cancelled', 'Rejected', 'Expired', 'No Show'].includes(b.booking_status.status_name));
    if (!relevant.length) return { completed: false };

    const allArrived = relevant.every((b) => b.booking_status.status_name === 'Arrived');
    if (!allArrived) return { completed: false };

    const recipients = [
        ...(await getActiveSecurityUsers()),
        ...unwrap(
            await db()
                .from('users')
                .select('user_id, roles!inner(role_name)')
                .eq('status', 'active')
                .eq('roles.role_name', 'Transport Coordinator')
        ),
    ];
    for (const r of recipients) {
        await createNotification(r.user_id, 'A ferry trip has completed - every passenger has arrived.', 'booking');
    }
    return { completed: true };
}
