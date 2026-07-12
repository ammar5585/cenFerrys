// Live Ferry Seat Availability Dashboard - business logic. Purely
// read-only/computed: no new tables, no stored "current status" -
// every field here is derived live from the same tables every other
// module already reads (ferry_schedule, route_stops, bookings,
// seat_reservations), via get_remaining_seats_batch (the app's one
// capacity source of truth) plus fresh grouping queries for the
// per-status/per-resort breakdown. Nothing here can drift out of sync
// with Booking/Security/Waiting List/HOD/HR Reservation/Ferry Service
// data, since it's the exact same rows, read fresh on every request.

import { db, unwrap } from './db.js';
import { getRemainingSeatsBatch } from './seats.js';
import { getFerryServices, getWholeRouteDirections } from './ferryServices.js';
import { getActiveResorts } from './refData.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MALDIVES_OFFSET_MS = 5 * 60 * 60 * 1000;
const BOARDING_WINDOW_MS = 30 * 60 * 1000;
const DEPARTED_LABEL_WINDOW_MS = 10 * 60 * 1000;
const DELAY_THRESHOLD_MS = 15 * 60 * 1000;

// Bookings in these statuses are excluded from capacity entirely
// (matches get_remaining_seats()'s own exclusion list, 0016_seat_
// reservations.sql) - kept identical here so this dashboard's seat
// math can never disagree with the rest of the app's.
const NON_COUNTED_STATUSES = ['Rejected', 'Cancelled', 'Expired'];
// Matches reserved_seats_for_schedule_date()'s own exclusion list
// (0023_hod_seat_assignment.sql) for deciding whether a booking still
// "occupies" one of its source reservation's seats - a No-Show, unlike
// for general capacity, DOES free its reservation slot back up.
const RESERVATION_ASSIGNMENT_EXCLUDED_STATUSES = ['Rejected', 'Cancelled', 'Expired', 'No Show'];
const PENDING_APPROVAL_STATUSES = [
    'Pending', 'Waiting GM Approval', 'Waiting RM Approval', 'Waiting HR Approval',
    'Pending Department Manager Approval', 'Pending Assistant Manager Approval',
    'Pending Supervisor Approval', 'Pending HR Approval',
];

function weekdayFor(travelDate) {
    return WEEKDAY_ABBR[new Date(`${travelDate}T00:00:00Z`).getUTCDay()];
}

function todayInMaldives() {
    return new Date(Date.now() + MALDIVES_OFFSET_MS).toISOString().slice(0, 10);
}

/** A "HH:MM:SS" wall-clock time on travelDate, interpreted as Maldives local time (UTC+5), converted to a real UTC instant (ms) for comparison against Date.now(). Null if timeStr is null (e.g. the last stop's departure_time, or the first stop's arrival_time). */
function scheduledInstant(travelDate, timeStr) {
    if (!timeStr) return null;
    return Date.parse(`${travelDate}T${timeStr}Z`) - MALDIVES_OFFSET_MS;
}

function seatIndicator(remaining) {
    if (remaining <= 0) return { emoji: '🔴', label: 'Full', class: 'danger' };
    if (remaining <= 4) return { emoji: '🟠', label: 'Nearly Full', class: 'warning' };
    if (remaining <= 10) return { emoji: '🟡', label: 'Limited', class: 'warning-light' };
    return { emoji: '🟢', label: 'Available', class: 'success' };
}

/**
 * A differently-scaled indicator for the booking page (percent-full
 * rather than absolute remaining seats) - the two live side by side
 * since each page's spec published its own thresholds: 0-60% full is
 * green, 61-85% yellow, 86-99% orange, 100%/full is red.
 */
export function utilizationIndicator(capacity, occupiedSeats) {
    const percentFull = capacity > 0 ? Math.round((occupiedSeats / capacity) * 100) : 0;
    let indicator;
    if (percentFull >= 100) indicator = { emoji: '🔴', label: 'Full', class: 'danger' };
    else if (percentFull >= 86) indicator = { emoji: '🟠', label: 'Nearly Full', class: 'warning' };
    else if (percentFull >= 61) indicator = { emoji: '🟡', label: 'Filling Up', class: 'warning-light' };
    else indicator = { emoji: '🟢', label: 'Available', class: 'success' };
    return { ...indicator, percentFull };
}

/**
 * Derives an operational status with no stored field at all - purely
 * from scheduled stop times vs the current instant, plus whether
 * Security has actually recorded a departure yet (the one real
 * "did this actually happen" signal available, from bookings.
 * departed_at via recordMovement() in security.js). "Delayed" only
 * fires when the scheduled departure has passed by DELAY_THRESHOLD_MS
 * with nobody yet marked departed - a genuine derived signal, not a
 * fabricated one. "Completed" reuses the same "every non-terminal
 * booking is Arrived" rule as security.js's checkTripCompletion().
 */
function deriveFerryStatus({ travelDate, todayMaldives, firstDepartureInstant, lastArrivalInstant, remaining, anyDeparted, allArrived }) {
    if (remaining <= 0) return 'Full';
    if (travelDate > todayMaldives) return 'Scheduled';
    if (travelDate < todayMaldives) return 'Completed';

    const now = Date.now();
    if (firstDepartureInstant == null) return 'Scheduled';
    if (now < firstDepartureInstant - BOARDING_WINDOW_MS) return 'Scheduled';
    if (now < firstDepartureInstant) return 'Boarding';
    if (!anyDeparted && now > firstDepartureInstant + DELAY_THRESHOLD_MS) return 'Delayed';
    if (lastArrivalInstant != null && now >= lastArrivalInstant) return allArrived ? 'Completed' : 'Arrived';
    if (now < firstDepartureInstant + DEPARTED_LABEL_WINDOW_MS) return 'Departed';
    return 'In Transit';
}

/** Completed / current / upcoming per stop, for the route progress display. "Current" is the stop right after the last one whose scheduled departure has already passed - before any departure at all, that's stop 0 (still boarding there). */
export function computeStopProgress(stops, travelDate, todayMaldives) {
    if (travelDate > todayMaldives) return stops.map((s) => ({ ...s, stopState: 'upcoming' }));
    if (travelDate < todayMaldives) return stops.map((s) => ({ ...s, stopState: 'completed' }));

    const now = Date.now();
    let lastDepartedIndex = -1;
    stops.forEach((s, i) => {
        const dep = scheduledInstant(travelDate, s.departure_time);
        if (dep != null && now >= dep) lastDepartedIndex = i;
    });
    return stops.map((s, i) => {
        if (i <= lastDepartedIndex) return { ...s, stopState: 'completed' };
        if (i === lastDepartedIndex + 1) return { ...s, stopState: 'current' };
        return { ...s, stopState: 'upcoming' };
    });
}

function statusBucketFor(statusName) {
    if (statusName === 'Waiting List') return 'waitingList';
    if (statusName === 'Checked-In') return 'checkedIn';
    if (statusName === 'Departed') return 'departed';
    if (statusName === 'Arrived') return 'arrived';
    if (statusName === 'No Show') return 'noShow';
    if (PENDING_APPROVAL_STATUSES.includes(statusName)) return 'pendingApproval';
    return 'confirmed'; // Approved, Completed
}

/** First-departure/last-arrival instants (and boarding/destination stop names) for one schedule+date - the same shape getLiveFerryAvailability() computes per card, but standalone for a single schedule (the booking page's POST handler only ever deals with 1-2 specific schedules, not the whole active list). */
export async function getStopTimeWindow(scheduleId, travelDate) {
    const stops = unwrap(
        await db().from('route_stops').select('stop_order, stop_name, arrival_time, departure_time').eq('schedule_id', scheduleId).eq('status', 'active').order('stop_order', { ascending: true })
    );
    const first = stops[0] ?? null;
    const last = stops[stops.length - 1] ?? null;
    return {
        boardingStopName: first?.stop_name ?? null,
        destinationStopName: last?.stop_name ?? null,
        firstDepartureInstant: first ? scheduledInstant(travelDate, first.departure_time) : null,
        lastArrivalInstant: last ? scheduledInstant(travelDate, last.arrival_time) : null,
    };
}

/**
 * The user's other non-terminal booking (if any) on this travelDate
 * whose own boarding-to-destination window overlaps [firstDepartureInstant,
 * lastArrivalInstant] - a new, additive guard (nothing in the booking
 * flow checked this before). A No-Show booking is excluded - the
 * passenger already missed that sailing, so it no longer represents a
 * real conflicting commitment.
 */
export async function findOverlappingBooking({ userId, travelDate, firstDepartureInstant, lastArrivalInstant }) {
    if (firstDepartureInstant == null || lastArrivalInstant == null) return null;
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, schedule_id, booking_status(status_name)')
            .eq('user_id', userId)
            .eq('travel_date', travelDate)
    );
    const candidates = rows.filter((r) => !RESERVATION_ASSIGNMENT_EXCLUDED_STATUSES.includes(r.booking_status?.status_name));
    for (const b of candidates) {
        const window = await getStopTimeWindow(b.schedule_id, travelDate);
        if (window.firstDepartureInstant == null || window.lastArrivalInstant == null) continue;
        const overlaps = Math.max(window.firstDepartureInstant, firstDepartureInstant) < Math.min(window.lastArrivalInstant, lastArrivalInstant);
        if (overlaps) return b;
    }
    return null;
}

/**
 * Every active, bookable (>= 2 configured stops - matches
 * getWholeRouteDirections()'s own bookability bar, so "Book Now" here
 * always lands on a real, selectable option on the booking page)
 * ferry service running on travelDate's weekday and within its
 * effective/expiry window, with live seat, status-breakdown,
 * per-resort, and route-progress data attached.
 */
export async function getLiveFerryAvailability({ travelDate, filters = {} }) {
    const todayMaldives = todayInMaldives();
    const weekday = weekdayFor(travelDate);

    const [allServices, bookableDirections, resorts] = await Promise.all([
        getFerryServices({ statusFilter: 'active' }),
        getWholeRouteDirections(),
        getActiveResorts(),
    ]);
    const labelByScheduleId = new Map(bookableDirections.map((d) => [d.scheduleId, d.direction]));

    const services = allServices.filter(
        (s) =>
            labelByScheduleId.has(s.schedule_id) &&
            s.weekdays?.includes(weekday) &&
            (!s.effective_date || s.effective_date <= travelDate) &&
            (!s.expiry_date || s.expiry_date >= travelDate)
    );
    if (!services.length) return [];

    const scheduleIds = services.map((s) => s.schedule_id);

    const [remainingBySchedule, stopsRows, bookingRows, reservationRows, splitScheduleRows] = await Promise.all([
        getRemainingSeatsBatch(scheduleIds, travelDate),
        db().from('route_stops').select('schedule_id, stop_order, stop_name, arrival_time, departure_time').in('schedule_id', scheduleIds).eq('status', 'active').order('stop_order', { ascending: true }).then(unwrap),
        db().from('bookings').select('schedule_id, seats, source_reservation_id, booking_status(status_name), users!bookings_user_id_fkey(resort_id)').eq('travel_date', travelDate).in('schedule_id', scheduleIds).then(unwrap),
        db().from('seat_reservations').select('reservation_id, schedule_id, seats, resort_id, weekdays').eq('status', 'active').in('schedule_id', scheduleIds).lte('start_date', travelDate).gte('end_date', travelDate).then(unwrap),
        // Which of these schedules have a Resort Capacity Allocator split
        // configured (0031_resort_capacity_allocation.sql) - a single
        // batched existence check rather than one call per schedule.
        db().from('ferry_resort_capacity').select('schedule_id').in('schedule_id', scheduleIds).then(unwrap),
    ]);
    const splitScheduleIds = new Set(splitScheduleRows.map((r) => r.schedule_id));
    // One RPC call per split-configured schedule (typically a small
    // subset, if any) - the Resort Capacity Allocator's own RPC
    // (get_remaining_seats_by_resort), reused as-is rather than
    // duplicating its booked/reserved-per-resort logic here.
    const resortAllocationByScheduleId = new Map(
        await Promise.all(
            [...splitScheduleIds].map(async (scheduleId) => [
                scheduleId,
                unwrap(await db().rpc('get_remaining_seats_by_resort', { p_schedule_id: scheduleId, p_travel_date: travelDate })),
            ])
        )
    );

    const stopsBySchedule = new Map();
    for (const s of stopsRows) {
        if (!stopsBySchedule.has(s.schedule_id)) stopsBySchedule.set(s.schedule_id, []);
        stopsBySchedule.get(s.schedule_id).push(s);
    }
    const bookingsBySchedule = new Map();
    for (const b of bookingRows) {
        if (!bookingsBySchedule.has(b.schedule_id)) bookingsBySchedule.set(b.schedule_id, []);
        bookingsBySchedule.get(b.schedule_id).push(b);
    }
    const reservationsBySchedule = new Map();
    for (const r of reservationRows) {
        if (!r.weekdays.includes(weekday)) continue;
        if (!reservationsBySchedule.has(r.schedule_id)) reservationsBySchedule.set(r.schedule_id, []);
        reservationsBySchedule.get(r.schedule_id).push(r);
    }

    const cards = services.map((service) => {
        const stops = (stopsBySchedule.get(service.schedule_id) ?? []).slice().sort((a, b) => a.stop_order - b.stop_order);
        const firstStop = stops[0] ?? null;
        const lastStop = stops[stops.length - 1] ?? null;
        const remainingRow = remainingBySchedule.get(service.schedule_id) ?? { capacity: service.capacity, booked: 0, reserved: 0, remaining: service.capacity };

        const bookings = bookingsBySchedule.get(service.schedule_id) ?? [];
        const statusSeats = { pendingApproval: 0, confirmed: 0, waitingList: 0, checkedIn: 0, departed: 0, arrived: 0, noShow: 0 };
        const resortOccupied = new Map();
        const assignedByReservation = new Map();
        for (const b of bookings) {
            const statusName = b.booking_status?.status_name;
            if (!NON_COUNTED_STATUSES.includes(statusName)) {
                statusSeats[statusBucketFor(statusName)] += b.seats;
                const resortId = b.users?.resort_id ?? null;
                if (resortId != null) resortOccupied.set(resortId, (resortOccupied.get(resortId) ?? 0) + b.seats);
            }
            if (b.source_reservation_id && !RESERVATION_ASSIGNMENT_EXCLUDED_STATUSES.includes(statusName)) {
                assignedByReservation.set(b.source_reservation_id, (assignedByReservation.get(b.source_reservation_id) ?? 0) + b.seats);
            }
        }

        // Mirrors reserved_seats_for_schedule_date() exactly (0023_hod_
        // seat_assignment.sql): a reservation's seats still counted as
        // "reserved" (not yet a real booking) is its total minus however
        // many of its seats already have a live booking against them for
        // this date - otherwise this dashboard's reserved figure would
        // double-count seats that are already reflected in `booked`,
        // disagreeing with the same get_remaining_seats_batch() total
        // shown one field above it.
        const reservations = reservationsBySchedule.get(service.schedule_id) ?? [];
        const resortReserved = new Map();
        for (const r of reservations) {
            const effectiveSeats = Math.max(0, r.seats - (assignedByReservation.get(r.reservation_id) ?? 0));
            resortReserved.set(r.resort_id, (resortReserved.get(r.resort_id) ?? 0) + effectiveSeats);
        }

        const allArrived = remainingRow.booked > 0 && statusSeats.arrived === remainingRow.booked;
        const anyDeparted = statusSeats.departed > 0 || statusSeats.arrived > 0;
        const firstDepartureInstant = firstStop ? scheduledInstant(travelDate, firstStop.departure_time) : null;
        const lastArrivalInstant = lastStop ? scheduledInstant(travelDate, lastStop.arrival_time) : null;

        const ferryStatus = deriveFerryStatus({ travelDate, todayMaldives, firstDepartureInstant, lastArrivalInstant, remaining: remainingRow.remaining, anyDeparted, allArrived });

        // resort_id NULL on a reservation means "Both Resorts" (the Bulk
        // Reservation feature's own explicit option) - it counts toward
        // every resort's "reserved" figure, same fix as findHodPoolRows().
        // Total capacity and remaining seats are a single shared pool for
        // the whole ferry (nothing in this app partitions seats by
        // resort ahead of time), so those two figures are identical for
        // every resort - only reserved/occupied genuinely differ.
        const resortBreakdown = resorts.map((resort) => ({
            resortId: resort.resort_id,
            resortName: resort.resort_name,
            total: remainingRow.capacity,
            available: remainingRow.remaining,
            reserved: (resortReserved.get(resort.resort_id) ?? 0) + (resortReserved.get(null) ?? 0),
            occupied: resortOccupied.get(resort.resort_id) ?? 0,
        }));

        return {
            scheduleId: service.schedule_id,
            label: labelByScheduleId.get(service.schedule_id),
            serviceName: service.service_name,
            serviceCode: service.service_code,
            routeSnapshot: service.routeSnapshot,
            capacity: remainingRow.capacity,
            available: remainingRow.remaining,
            booked: remainingRow.booked,
            reserved: remainingRow.reserved,
            departureTime: firstStop?.departure_time ?? service.departure_time,
            arrivalTime: lastStop?.arrival_time ?? null,
            boardingStopName: firstStop?.stop_name ?? null,
            destinationStopName: lastStop?.stop_name ?? null,
            ferryStatus,
            bookingStatus: remainingRow.remaining <= 0 ? 'Full' : 'Open',
            indicator: seatIndicator(remainingRow.remaining),
            utilization: utilizationIndicator(remainingRow.capacity, remainingRow.booked + remainingRow.reserved),
            // "Direct" vs "Via N stop(s)" - this app has no vessel/boat-type
            // data anywhere, so that part of a commercial ferry app's
            // "Ferry Type" is intentionally not fabricated here.
            tripType: stops.length <= 2 ? 'Direct' : `Via ${stops.length - 2} stop(s)`,
            journeyDurationMinutes: firstDepartureInstant != null && lastArrivalInstant != null ? Math.round((lastArrivalInstant - firstDepartureInstant) / 60000) : null,
            stopProgress: computeStopProgress(stops, travelDate, todayMaldives),
            statusSeats,
            resortBreakdown,
            // Only present once an Administrator has configured a split
            // via the Resort Capacity Allocator (0031_resort_capacity_
            // allocation.sql) - null for every other service, which keeps
            // showing only the shared-pool resortBreakdown above exactly
            // as before this field was added.
            resortAllocation: resortAllocationByScheduleId.get(service.schedule_id) ?? null,
        };
    });

    return applyFilters(cards, filters);
}

function applyFilters(cards, filters) {
    let result = cards;
    const { q, resortName, status, departureTime, boardingLocation, destination } = filters;
    if (q) {
        const needle = q.trim().toLowerCase();
        result = result.filter(
            (c) =>
                c.serviceName?.toLowerCase().includes(needle) ||
                c.serviceCode?.toLowerCase().includes(needle) ||
                c.routeSnapshot?.toLowerCase().includes(needle) ||
                c.label?.toLowerCase().includes(needle)
        );
    }
    // "Resort" filter: does this ferry's route actually stop at the
    // chosen resort at all - a route that never touches CGLM shouldn't
    // show up when a CGLM-based user filters by their own resort. Every
    // service in current production data stops at both, but this stays
    // correct if a CMLM-only or CGLM-only route is ever configured.
    if (resortName) {
        result = result.filter((c) => c.routeSnapshot?.includes(resortName));
    }
    if (status) {
        result = result.filter((c) => c.ferryStatus === status);
    }
    if (departureTime) {
        result = result.filter((c) => c.departureTime === departureTime);
    }
    if (boardingLocation) {
        result = result.filter((c) => c.boardingStopName === boardingLocation);
    }
    if (destination) {
        result = result.filter((c) => c.destinationStopName === destination);
    }
    return result;
}
