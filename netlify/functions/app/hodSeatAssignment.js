// HOD Reserved Seat Assignment: lets Security (and HR Manager/
// Administrator, as an override) attach a real employee identity to an
// HOD/department seat_reservations row, which previously only ever
// carried a free-text contact_name. Sibling module to security.js
// (shares only db/unwrap/getStatusId) - security.js stays scoped to
// waiting-list FIFO + passenger movement recording, this file owns all
// reservation-availability math, candidate search, and the dedicated
// audit trail.
//
// Capacity correctness: reserved_seats_for_schedule_date() (redefined
// in 0023_hod_seat_assignment.sql) already excludes any seat that has a
// non-cancelled/rejected/expired/no-show booking linked via
// source_reservation_id for the exact travel date - so assigning an
// employee here decrements "reserved" and increments "booked" by
// exactly one seat, with no double-count, and a No-Show frees the seat
// again automatically with zero code here (see recordHodSeatAutoRelease
// below, which only maintains the audit trail for that case).

import { db, unwrap } from './db.js';
import { getStatusId } from './approval.js';
import { createNotification } from './notifications.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOD_BOOKING_PURPOSE = 'HOD Reserved Seat Assignment';
const RESERVABLE_TYPES = ['hod', 'department'];
// Must stay identical to 0023_hod_seat_assignment.sql's exclusion list.
const OCCUPIED_EXCLUDED_STATUSES = ['Rejected', 'Cancelled', 'Expired', 'No Show'];
const REASSIGNABLE_STATUSES = ['Approved', 'Checked-In'];

function weekdayFor(travelDate) {
    return WEEKDAY_ABBR[new Date(`${travelDate}T00:00:00Z`).getUTCDay()];
}

async function countActiveAssignments(reservationId, travelDate) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, booking_status(status_name)')
            .eq('source_reservation_id', reservationId)
            .eq('travel_date', travelDate)
    );
    return rows.filter((r) => !OCCUPIED_EXCLUDED_STATUSES.includes(r.booking_status.status_name)).length;
}

/** True if this employee already holds an active HOD-assigned seat for this exact schedule+date (excludeBookingId lets reassign check without counting the booking about to be replaced). */
async function employeeHasHodAssignment(employeeUserId, scheduleId, travelDate, excludeBookingId = null) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, booking_status(status_name)')
            .eq('user_id', employeeUserId)
            .eq('schedule_id', scheduleId)
            .eq('travel_date', travelDate)
            .not('source_reservation_id', 'is', null)
    );
    return rows.some((r) => r.booking_id !== excludeBookingId && !OCCUPIED_EXCLUDED_STATUSES.includes(r.booking_status.status_name));
}

/**
 * Active HOD/department reservations covering this schedule+date, each
 * annotated with how many of its seats are already assigned (and to
 * whom) versus still available.
 */
export async function getHodReservationsForScheduleDate(scheduleId, travelDate) {
    const weekday = weekdayFor(travelDate);
    const reservations = unwrap(
        await db()
            .from('seat_reservations')
            .select('reservation_id, department_id, resort_id, seats, contact_name, weekdays, departments(department_name), resorts(resort_name)')
            .eq('schedule_id', scheduleId)
            .eq('status', 'active')
            .in('reservation_type', RESERVABLE_TYPES)
            .lte('start_date', travelDate)
            .gte('end_date', travelDate)
    );
    const matching = reservations.filter((r) => r.weekdays.includes(weekday));
    if (!matching.length) return [];

    const reservationIds = matching.map((r) => r.reservation_id);
    const assignments = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, source_reservation_id, user_id, users!bookings_user_id_fkey(full_name, employee_id), booking_status(status_name)')
            .in('source_reservation_id', reservationIds)
            .eq('travel_date', travelDate)
    );

    const byReservation = new Map();
    for (const a of assignments) {
        if (!byReservation.has(a.source_reservation_id)) byReservation.set(a.source_reservation_id, []);
        byReservation.get(a.source_reservation_id).push(a);
    }

    return matching.map((r) => {
        const all = byReservation.get(r.reservation_id) ?? [];
        const active = all.filter((a) => !OCCUPIED_EXCLUDED_STATUSES.includes(a.booking_status.status_name));
        return {
            reservationId: r.reservation_id,
            departmentId: r.department_id,
            departmentName: r.departments?.department_name ?? '-',
            resortId: r.resort_id,
            resortName: r.resorts?.resort_name ?? '-',
            contactName: r.contact_name,
            seatsTotal: r.seats,
            seatsAssigned: active.length,
            seatsAvailable: Math.max(0, r.seats - active.length),
            assignments: active.map((a) => ({
                bookingId: a.booking_id,
                userId: a.user_id,
                fullName: a.users.full_name,
                employeeId: a.users.employee_id,
                statusName: a.booking_status.status_name,
            })),
        };
    });
}

/**
 * Active employees within the reservation's own department, JS-filtered
 * by free-text (never interpolated into a PostgREST filter string),
 * each annotated with the two validation signals the spec calls for:
 * a hard block (already holds an HOD-assigned seat for this schedule/
 * date) and a soft warning (holds any booking at all for it).
 */
export async function searchHodSeatCandidates({ reservationId, travelDate, needle }) {
    const resRows = unwrap(
        await db().from('seat_reservations').select('department_id, schedule_id').eq('reservation_id', reservationId).limit(1)
    );
    const reservation = resRows[0];
    // A 'hod'/'department' reservation with no department set (a
    // pre-existing gap in the reservation-create form, not enforced
    // there) has no department-scoped candidate pool to search - rather
    // than send department_id: null into a PostgREST .eq() filter
    // (which errors, since it tries to parse "null" as an integer
    // literal instead of emitting IS NULL), just report no candidates.
    if (!reservation || reservation.department_id == null) return [];

    const candidates = unwrap(
        await db()
            .from('users')
            .select('user_id, employee_id, full_name, designation, resort_id')
            .eq('status', 'active')
            .eq('department_id', reservation.department_id)
            .order('full_name')
    );
    if (!candidates.length) return [];

    const needleLower = (needle || '').trim().toLowerCase();
    const filtered = needleLower
        ? candidates.filter((c) => c.employee_id.toLowerCase().includes(needleLower) || c.full_name.toLowerCase().includes(needleLower))
        : candidates;
    if (!filtered.length) return [];

    const candidateIds = filtered.map((c) => c.user_id);
    const existingBookings = unwrap(
        await db()
            .from('bookings')
            .select('user_id, source_reservation_id, booking_status(status_name)')
            .eq('schedule_id', reservation.schedule_id)
            .eq('travel_date', travelDate)
            .in('user_id', candidateIds)
    );
    const activeBookings = existingBookings.filter((b) => !OCCUPIED_EXCLUDED_STATUSES.includes(b.booking_status.status_name));
    const assignedElsewhereIds = new Set(activeBookings.filter((b) => b.source_reservation_id).map((b) => b.user_id));
    const anyBookingIds = new Set(activeBookings.map((b) => b.user_id));

    return filtered.map((c) => ({
        ...c,
        alreadyAssignedElsewhere: assignedElsewhereIds.has(c.user_id),
        hasExistingBooking: anyBookingIds.has(c.user_id),
    }));
}

/** True if any non-cancelled/rejected/expired/no-show booking is linked to this reservation, on any date within its range. */
async function reservationHasAnyActiveAssignment(reservationId) {
    const rows = unwrap(
        await db().from('bookings').select('booking_id, booking_status(status_name)').eq('source_reservation_id', reservationId)
    );
    return rows.some((r) => !OCCUPIED_EXCLUDED_STATUSES.includes(r.booking_status.status_name));
}

/**
 * Sets or fixes an HOD/department reservation's department - either
 * because the create form allowed leaving it blank, or because Security
 * picked the wrong one and needs to correct it. Changing an
 * already-set department is only allowed while no one is currently
 * assigned to any seat on this reservation (any date in its range) -
 * once someone is attached, it locks again, matching "Security cannot
 * change department seat allocations" for a reservation that's
 * actually in use.
 */
export async function setHodReservationDepartment({ reservationId, departmentId, setByUserId }) {
    const rows = unwrap(
        await db().from('seat_reservations').select('reservation_id, department_id, reservation_type').eq('reservation_id', reservationId).limit(1)
    );
    const reservation = rows[0];
    if (!reservation || !RESERVABLE_TYPES.includes(reservation.reservation_type)) return { ok: false, reason: 'reservation_not_available' };

    if (reservation.department_id != null) {
        if (await reservationHasAnyActiveAssignment(reservationId)) return { ok: false, reason: 'seats_already_assigned' };
    }

    const deptRows = unwrap(await db().from('departments').select('department_id').eq('department_id', departmentId).limit(1));
    if (!deptRows.length) return { ok: false, reason: 'invalid_department' };

    unwrap(await db().from('seat_reservations').update({ department_id: departmentId }).eq('reservation_id', reservationId));
    return { ok: true };
}

/**
 * Deletes (soft - sets status to 'cancelled', matching how every other
 * reservation removal in this app already works, never a hard SQL
 * DELETE) an HOD reservation. Authorization is entirely the caller's
 * responsibility (not checked here) - used both by Security's manifest
 * page (Administrator-only there) and the HOD self-service page
 * (own-department-only there), each passing its own `reason` for the
 * audit trail. Only while no one is currently assigned - the same "seat
 * must be empty" guard used for changing a department, so an active
 * assignment can't be silently orphaned.
 */
export async function deleteHodReservation({ reservationId, deletedByUserId, reason = 'Deleted by Administrator from the Security manifest page' }) {
    const rows = unwrap(
        await db()
            .from('seat_reservations')
            .select('reservation_id, schedule_id, department_id, resort_id, reservation_type, status, seats, start_date, end_date, departments(department_name), ferry_schedule(ferry_routes(direction))')
            .eq('reservation_id', reservationId)
            .limit(1)
    );
    const reservation = rows[0];
    if (!reservation || reservation.status !== 'active') return { ok: false, reason: 'reservation_not_available' };
    if (await reservationHasAnyActiveAssignment(reservationId)) return { ok: false, reason: 'seats_already_assigned' };

    unwrap(await db().from('seat_reservations').update({ status: 'cancelled' }).eq('reservation_id', reservationId));

    unwrap(
        await db().from('seat_reservation_log').insert({
            reservation_id: reservationId,
            schedule_id: reservation.schedule_id,
            direction: reservation.ferry_schedule?.ferry_routes?.direction ?? null,
            resort_id: reservation.resort_id,
            reservation_type: reservation.reservation_type,
            department_name_snapshot: reservation.departments?.department_name ?? null,
            seats: reservation.seats,
            start_date: reservation.start_date,
            end_date: reservation.end_date,
            action: 'cancelled',
            actor_user_id: deletedByUserId,
            reason,
        })
    );

    return { ok: true };
}

/**
 * Creates a new HOD-type reserved-seat block directly from Security's
 * manifest page - a deliberate exception to "Security cannot create
 * reserved seat allocations" (confirmed explicitly with the user),
 * scoped to a single day (the schedule/date already being viewed)
 * rather than an open-ended range, so it can't accidentally reserve
 * seats on dates nobody looked at. Logged to seat_reservation_log
 * (action: 'created') so it shows up in the same audit trail as every
 * other reservation, regardless of who created it.
 */
export async function createHodReservation({ scheduleId, travelDate, departmentId, resortId, seats, createdByUserId }) {
    if (!Number.isInteger(seats) || seats < 1) return { ok: false, reason: 'invalid_seats' };

    const deptRows = unwrap(await db().from('departments').select('department_id, department_name').eq('department_id', departmentId).limit(1));
    if (!deptRows.length) return { ok: false, reason: 'invalid_department' };

    const resortRows = unwrap(await db().from('resorts').select('resort_id, resort_name').eq('resort_id', resortId).limit(1));
    if (!resortRows.length) return { ok: false, reason: 'invalid_resort' };

    const scheduleRows = unwrap(await db().from('ferry_schedule').select('schedule_id, ferry_routes(direction)').eq('schedule_id', scheduleId).limit(1));
    if (!scheduleRows.length) return { ok: false, reason: 'invalid_schedule' };
    const direction = scheduleRows[0].ferry_routes?.direction ?? null;

    const inserted = unwrap(
        await db()
            .from('seat_reservations')
            .insert({
                schedule_id: scheduleId,
                department_id: departmentId,
                resort_id: resortId,
                reservation_type: 'hod',
                seats,
                start_date: travelDate,
                end_date: travelDate,
                weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                reason: 'HOD Seats (created from Security manifest)',
                status: 'active',
                created_by_user_id: createdByUserId,
            })
            .select('*')
    );
    const reservation = inserted[0];

    unwrap(
        await db().from('seat_reservation_log').insert({
            reservation_id: reservation.reservation_id,
            schedule_id: scheduleId,
            direction,
            resort_id: resortId,
            reservation_type: 'hod',
            department_name_snapshot: deptRows[0].department_name,
            seats,
            start_date: travelDate,
            end_date: travelDate,
            action: 'created',
            actor_user_id: createdByUserId,
            reason: 'Created by Security from the manifest page',
        })
    );

    return { ok: true, reservation };
}

/** Loads a reservation with the joins every write path below needs (schedule/direction/department name). */
async function loadReservationForWrite(reservationId) {
    const rows = unwrap(
        await db()
            .from('seat_reservations')
            .select(
                'reservation_id, schedule_id, department_id, resort_id, reservation_type, seats, status, start_date, end_date, weekdays, ' +
                    'departments(department_name), ferry_schedule(ferry_routes(direction))'
            )
            .eq('reservation_id', reservationId)
            .limit(1)
    );
    return rows[0] ?? null;
}

/** Re-validates a candidate employee server-side - never trust client-submitted state. */
async function loadValidEmployee(employeeUserId, requiredDepartmentId) {
    const rows = unwrap(
        await db().from('users').select('user_id, full_name, employee_id, department_id, status').eq('user_id', employeeUserId).limit(1)
    );
    const employee = rows[0];
    if (!employee || employee.status !== 'active' || employee.department_id !== requiredDepartmentId) return null;
    return employee;
}

async function insertHodAssignmentLog(row) {
    unwrap(await db().from('hod_seat_assignment_log').insert(row));
}

/**
 * Assigns a named employee to one of a reservation's remaining
 * available seats for a specific travel date.
 */
export async function assignEmployeeToHodSeat({ reservationId, travelDate, employeeUserId, assignedByUserId, remarks }) {
    const reservation = await loadReservationForWrite(reservationId);
    if (!reservation || reservation.status !== 'active' || !RESERVABLE_TYPES.includes(reservation.reservation_type)) {
        return { ok: false, reason: 'reservation_not_available' };
    }
    if (travelDate < reservation.start_date || travelDate > reservation.end_date || !reservation.weekdays.includes(weekdayFor(travelDate))) {
        return { ok: false, reason: 'reservation_not_available' };
    }

    const employee = await loadValidEmployee(employeeUserId, reservation.department_id);
    if (!employee) return { ok: false, reason: 'employee_not_in_department' };

    const assignedCount = await countActiveAssignments(reservationId, travelDate);
    if (assignedCount >= reservation.seats) return { ok: false, reason: 'seat_unavailable' };

    if (await employeeHasHodAssignment(employeeUserId, reservation.schedule_id, travelDate)) {
        return { ok: false, reason: 'already_assigned' };
    }

    const approvedId = await getStatusId('Approved');
    const direction = reservation.ferry_schedule?.ferry_routes?.direction ?? null;
    const inserted = unwrap(
        await db()
            .from('bookings')
            .insert({
                user_id: employeeUserId,
                schedule_id: reservation.schedule_id,
                travel_date: travelDate,
                direction,
                purpose: HOD_BOOKING_PURPOSE,
                remarks: remarks || null,
                seats: 1,
                status_id: approvedId,
                booking_method: 'hod_seat_assignment',
                source_reservation_id: reservationId,
            })
            .select('*')
    );
    const booking = inserted[0];

    await insertHodAssignmentLog({
        reservation_id: reservationId,
        schedule_id: reservation.schedule_id,
        direction,
        travel_date: travelDate,
        resort_id: reservation.resort_id,
        department_id: reservation.department_id,
        department_name_snapshot: reservation.departments?.department_name ?? null,
        booking_id: booking.booking_id,
        action: 'assigned',
        employee_assigned_user_id: employee.user_id,
        employee_assigned_name_snapshot: employee.full_name,
        employee_assigned_id_snapshot: employee.employee_id,
        assigned_by_user_id: assignedByUserId,
        remarks: remarks || null,
    });

    await createNotification(employeeUserId, 'You have been assigned a reserved seat for your upcoming ferry trip.', 'booking', booking.booking_id);

    return { ok: true, booking };
}

/**
 * Replaces the employee on an existing HOD-assigned booking with a
 * different one, only while it's still before departure. Cancels the
 * old booking and inserts a new one (rather than mutating user_id in
 * place) so the audit trail cleanly captures both identities and any
 * check-in state doesn't wrongly carry over to the new occupant.
 */
export async function reassignEmployeeToHodSeat({ bookingId, newEmployeeUserId, assignedByUserId, remarks }) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select(
                'booking_id, user_id, schedule_id, travel_date, source_reservation_id, ' +
                    'users!bookings_user_id_fkey(full_name, employee_id), booking_status(status_name)'
            )
            .eq('booking_id', bookingId)
            .limit(1)
    );
    const oldBooking = rows[0];
    if (!oldBooking || !oldBooking.source_reservation_id) return { ok: false, reason: 'not_hod_assignment' };
    if (!REASSIGNABLE_STATUSES.includes(oldBooking.booking_status.status_name)) return { ok: false, reason: 'too_late_to_reassign' };

    const reservation = await loadReservationForWrite(oldBooking.source_reservation_id);
    if (!reservation) return { ok: false, reason: 'reservation_not_available' };

    const newEmployee = await loadValidEmployee(newEmployeeUserId, reservation.department_id);
    if (!newEmployee) return { ok: false, reason: 'employee_not_in_department' };

    if (await employeeHasHodAssignment(newEmployeeUserId, oldBooking.schedule_id, oldBooking.travel_date, bookingId)) {
        return { ok: false, reason: 'already_assigned' };
    }

    const cancelledId = await getStatusId('Cancelled');
    unwrap(await db().from('bookings').update({ status_id: cancelledId }).eq('booking_id', bookingId));

    const approvedId = await getStatusId('Approved');
    const direction = reservation.ferry_schedule?.ferry_routes?.direction ?? null;
    const inserted = unwrap(
        await db()
            .from('bookings')
            .insert({
                user_id: newEmployeeUserId,
                schedule_id: oldBooking.schedule_id,
                travel_date: oldBooking.travel_date,
                direction,
                purpose: HOD_BOOKING_PURPOSE,
                remarks: remarks || null,
                seats: 1,
                status_id: approvedId,
                booking_method: 'hod_seat_assignment',
                source_reservation_id: reservation.reservation_id,
            })
            .select('*')
    );
    const newBooking = inserted[0];

    await insertHodAssignmentLog({
        reservation_id: reservation.reservation_id,
        schedule_id: oldBooking.schedule_id,
        direction,
        travel_date: oldBooking.travel_date,
        resort_id: reservation.resort_id,
        department_id: reservation.department_id,
        department_name_snapshot: reservation.departments?.department_name ?? null,
        booking_id: newBooking.booking_id,
        action: 'reassigned',
        employee_assigned_user_id: newEmployee.user_id,
        employee_assigned_name_snapshot: newEmployee.full_name,
        employee_assigned_id_snapshot: newEmployee.employee_id,
        employee_removed_user_id: oldBooking.user_id,
        employee_removed_name_snapshot: oldBooking.users.full_name,
        employee_removed_id_snapshot: oldBooking.users.employee_id,
        assigned_by_user_id: assignedByUserId,
        remarks: remarks || null,
    });

    await createNotification(oldBooking.user_id, 'Your reserved seat assignment has been reassigned to another employee.', 'booking', bookingId);
    await createNotification(newEmployeeUserId, 'You have been assigned a reserved seat for your upcoming ferry trip.', 'booking', newBooking.booking_id);

    return { ok: true, booking: newBooking };
}

/** Manually frees an assigned HOD seat before check-in/departure (proactive, distinct from the automatic No-Show release). */
export async function releaseHodSeatAssignment({ bookingId, releasedByUserId, remarks }) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select(
                'booking_id, user_id, schedule_id, travel_date, source_reservation_id, ' +
                    'users!bookings_user_id_fkey(full_name, employee_id), booking_status(status_name)'
            )
            .eq('booking_id', bookingId)
            .limit(1)
    );
    const booking = rows[0];
    if (!booking || !booking.source_reservation_id) return { ok: false, reason: 'not_hod_assignment' };
    if (!REASSIGNABLE_STATUSES.includes(booking.booking_status.status_name)) return { ok: false, reason: 'too_late_to_release' };

    const reservation = await loadReservationForWrite(booking.source_reservation_id);

    const cancelledId = await getStatusId('Cancelled');
    unwrap(await db().from('bookings').update({ status_id: cancelledId }).eq('booking_id', bookingId));

    await insertHodAssignmentLog({
        reservation_id: booking.source_reservation_id,
        schedule_id: booking.schedule_id,
        direction: reservation?.ferry_schedule?.ferry_routes?.direction ?? null,
        travel_date: booking.travel_date,
        resort_id: reservation?.resort_id ?? null,
        department_id: reservation?.department_id ?? null,
        department_name_snapshot: reservation?.departments?.department_name ?? null,
        booking_id: bookingId,
        action: 'released',
        employee_removed_user_id: booking.user_id,
        employee_removed_name_snapshot: booking.users.full_name,
        employee_removed_id_snapshot: booking.users.employee_id,
        assigned_by_user_id: releasedByUserId,
        remarks: remarks || null,
    });

    await createNotification(booking.user_id, 'Your reserved seat assignment has been released.', 'booking', bookingId);

    return { ok: true };
}

/**
 * Called from security.js's recordMovement() when a passenger on an
 * HOD-assigned booking is marked No Show. The seat freeing itself
 * already happens for free (the SQL fix excludes 'No Show' bookings
 * from the reserved count) - this purely keeps the dedicated audit
 * trail complete. `booking` must include source_reservation_id,
 * schedule_id, travel_date, user_id, and users.full_name/employee_id.
 */
export async function recordHodSeatAutoRelease(bookingId, booking) {
    if (!booking.source_reservation_id) return;

    const reservation = await loadReservationForWrite(booking.source_reservation_id);

    await insertHodAssignmentLog({
        reservation_id: booking.source_reservation_id,
        schedule_id: booking.schedule_id,
        direction: reservation?.ferry_schedule?.ferry_routes?.direction ?? null,
        travel_date: booking.travel_date,
        resort_id: reservation?.resort_id ?? null,
        department_id: reservation?.department_id ?? null,
        department_name_snapshot: reservation?.departments?.department_name ?? null,
        booking_id: bookingId,
        action: 'auto_released_no_show',
        employee_removed_user_id: booking.user_id,
        employee_removed_name_snapshot: booking.users?.full_name ?? null,
        employee_removed_id_snapshot: booking.users?.employee_id ?? null,
        assigned_by_user_id: null,
        remarks: 'Seat automatically released - employee marked No Show.',
    });
}
