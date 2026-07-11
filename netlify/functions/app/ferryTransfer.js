// Emergency Passenger Transfer - Bulk Ferry Reallocation. Moves some or
// all passengers booked on one ferry service+date onto a different
// ferry service+date in a single action (breakdown, cancellation,
// maintenance, weather, or a capacity adjustment). A transferred
// booking keeps its booking_id/status_id/current_approver_id/approval
// history untouched - only schedule_id and direction change - so
// nothing about its approval trail or seat accounting needs to be
// rebuilt; get_remaining_seats() picks up the move automatically on
// both the source and destination schedules.

import { db, unwrap } from './db.js';
import { getRemainingSeats, getRemainingSeatsBatch } from './seats.js';
import { getServiceWithStops, getFerryServices } from './ferryServices.js';
import { createNotification } from './notifications.js';
import { sendTemplatedEmail } from './mailer.js';
import { deferBestEffort } from './deferred.js';
import { formatDate, formatTime } from './format.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Bookings in these statuses have either already been transported or
// were never going anywhere (rejected/cancelled/expired) - moving them
// to a different ferry is meaningless. Everything else (every flavor
// of "pending approval", plus Approved and Waiting List) is eligible.
const NON_TRANSFERABLE_STATUSES = ['Rejected', 'Cancelled', 'Expired', 'Checked-In', 'Departed', 'Arrived', 'Completed', 'No Show'];

export const TRANSFER_OPTIONS = ['all', 'confirmed', 'confirmed_and_waiting', 'selected'];

function weekdayAbbrFor(travelDate) {
    return WEEKDAY_ABBR[new Date(`${travelDate}T00:00:00Z`).getUTCDay()];
}

function labelFor(service) {
    if (!service) return null;
    return service.service_name ? (service.service_code ? `${service.service_name} (${service.service_code})` : service.service_name) : service.routeSnapshot;
}

/**
 * Bookings placed against an HOD/department reserved seat
 * (source_reservation_id set, see 0023_hod_seat_assignment.sql) are
 * always excluded from bulk transfer - the reservation itself still
 * points at the old schedule, so moving just the booking would
 * desynchronize it from its reservation. These must be reassigned
 * manually through the HOD Reserved Seat workflow instead.
 */
async function loadTransferableBookings(scheduleId, travelDate) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select(
                'booking_id, user_id, seats, direction, source_reservation_id, booking_status(status_name), users!bookings_user_id_fkey(full_name, email, employee_id)'
            )
            .eq('schedule_id', scheduleId)
            .eq('travel_date', travelDate)
    );
    const eligible = [];
    let skippedReserved = 0;
    for (const row of rows) {
        const statusName = row.booking_status?.status_name;
        if (NON_TRANSFERABLE_STATUSES.includes(statusName)) continue;
        if (row.source_reservation_id) {
            skippedReserved++;
            continue;
        }
        eligible.push({ ...row, statusName });
    }
    return { eligible, skippedReserved };
}

export async function getSourceSummary({ scheduleId, travelDate }) {
    const service = await getServiceWithStops(scheduleId);
    if (!service) return null;
    const remaining = await getRemainingSeats(scheduleId, travelDate);
    const { eligible, skippedReserved } = await loadTransferableBookings(scheduleId, travelDate);

    const confirmedSeats = eligible.filter((b) => b.statusName === 'Approved').reduce((sum, b) => sum + b.seats, 0);
    const waitingSeats = eligible.filter((b) => b.statusName === 'Waiting List').reduce((sum, b) => sum + b.seats, 0);
    const transferableSeatsTotal = eligible.reduce((sum, b) => sum + b.seats, 0);

    return {
        service,
        label: labelFor(service),
        capacity: remaining.capacity,
        booked: remaining.booked,
        remaining: remaining.remaining,
        transferablePassengers: eligible,
        transferableSeatsTotal,
        confirmedSeats,
        waitingSeats,
        pendingSeats: transferableSeatsTotal - confirmedSeats - waitingSeats,
        skippedReservedCount: skippedReserved,
    };
}

/** Other active services operating on travelDate's weekday - not restricted to the same route/stop chain, since an emergency reallocation may reasonably move passengers onto an entirely different service. */
export async function getCandidateDestinations({ excludeScheduleId, travelDate }) {
    const weekday = weekdayAbbrFor(travelDate);
    const services = await getFerryServices({ statusFilter: 'active' });
    const candidates = services.filter((s) => s.schedule_id !== excludeScheduleId && s.weekdays?.includes(weekday));
    if (!candidates.length) return [];

    const remainingBySchedule = await getRemainingSeatsBatch(candidates.map((s) => s.schedule_id), travelDate);
    return candidates.map((s) => {
        const remaining = remainingBySchedule.get(s.schedule_id) ?? { capacity: s.capacity, booked: 0, remaining: s.capacity };
        return {
            scheduleId: s.schedule_id,
            label: s.service_name ? (s.service_code ? `${s.service_name} (${s.service_code})` : s.service_name) : s.routeSnapshot,
            routeSnapshot: s.routeSnapshot,
            departureTime: s.departure_time,
            capacity: remaining.capacity,
            booked: remaining.booked,
            remaining: remaining.remaining,
        };
    });
}

export async function performBulkTransfer({ sourceScheduleId, destinationScheduleId, travelDate, transferOption, selectedBookingIds, reason, actorUserId }) {
    if (sourceScheduleId === destinationScheduleId) return { ok: false, reason: 'same_schedule' };
    if (!TRANSFER_OPTIONS.includes(transferOption)) return { ok: false, reason: 'invalid_option' };
    if (!reason?.trim()) return { ok: false, reason: 'missing_reason' };

    const sourceService = await getServiceWithStops(sourceScheduleId);
    const destinationService = await getServiceWithStops(destinationScheduleId);
    if (!sourceService || !destinationService) return { ok: false, reason: 'not_found' };

    const { eligible, skippedReserved } = await loadTransferableBookings(sourceScheduleId, travelDate);

    let toTransfer;
    if (transferOption === 'all') {
        toTransfer = eligible;
    } else if (transferOption === 'confirmed') {
        toTransfer = eligible.filter((b) => b.statusName === 'Approved');
    } else if (transferOption === 'confirmed_and_waiting') {
        toTransfer = eligible.filter((b) => b.statusName === 'Approved' || b.statusName === 'Waiting List');
    } else {
        const selectedSet = new Set(selectedBookingIds ?? []);
        toTransfer = eligible.filter((b) => selectedSet.has(b.booking_id));
    }
    if (!toTransfer.length) return { ok: false, reason: 'no_passengers' };

    // Final validation, right before applying any change: the capacity
    // read above (getCandidateDestinations, if the caller used it) may
    // be stale by the time the admin confirms, so it is re-checked here
    // against the live count.
    const requestedSeats = toTransfer.reduce((sum, b) => sum + b.seats, 0);
    const destinationRemaining = await getRemainingSeats(destinationScheduleId, travelDate);
    if (destinationRemaining.remaining < requestedSeats) {
        return { ok: false, reason: 'insufficient_capacity', availableSeats: destinationRemaining.remaining, requestedSeats };
    }

    const destinationLabel = labelFor(destinationService);
    const sourceLabel = labelFor(sourceService);
    const destinationBoardingStop = destinationService.stops[0];
    const destinationLastStop = destinationService.stops[destinationService.stops.length - 1];

    let waitingListTransferred = 0;
    for (const booking of toTransfer) {
        unwrap(
            await db()
                .from('bookings')
                .update({ schedule_id: destinationScheduleId, direction: destinationLabel })
                .eq('booking_id', booking.booking_id)
        );
        if (booking.statusName === 'Waiting List') waitingListTransferred++;

        const message = `Your ferry booking for ${formatDate(travelDate)} has been transferred to ${destinationLabel}${reason ? ' - ' + reason : ''}.`;
        await createNotification(booking.user_id, message, 'booking', booking.booking_id);
        deferBestEffort(
            sendTemplatedEmail(
                'ferry_transfer',
                booking.users?.email,
                {
                    full_name: booking.users?.full_name ?? '',
                    new_ferry_name: destinationLabel,
                    travel_date: formatDate(travelDate),
                    departure_time: destinationBoardingStop ? formatTime(destinationBoardingStop.departure_time) : '',
                    boarding_location: destinationBoardingStop?.stop_name ?? '',
                    destination: destinationLastStop?.stop_name ?? '',
                    reason: reason || '',
                    booking_id: booking.booking_id,
                },
                { relatedBookingId: booking.booking_id }
            ),
            'sendTemplatedEmail:ferry_transfer'
        );
    }

    unwrap(
        await db().from('ferry_transfer_log').insert({
            source_schedule_id: sourceScheduleId,
            destination_schedule_id: destinationScheduleId,
            source_service_name_snapshot: sourceLabel,
            destination_service_name_snapshot: destinationLabel,
            travel_date: travelDate,
            transfer_option: transferOption,
            passengers_transferred_count: toTransfer.length,
            waiting_list_transferred_count: waitingListTransferred,
            skipped_count: skippedReserved,
            actor_user_id: actorUserId,
            reason,
        })
    );

    return {
        ok: true,
        transferredCount: toTransfer.length,
        transferredSeats: requestedSeats,
        waitingListTransferredCount: waitingListTransferred,
        skippedReservedCount: skippedReserved,
        sourceLabel,
        destinationLabel,
    };
}
