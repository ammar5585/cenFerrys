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
import { getStatusId, routeBookingApproval } from './approval.js';
import { createNotification } from './notifications.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOD_BOOKING_PURPOSE = 'HOD Reserved Seat Assignment';
const RESERVABLE_TYPES = ['hod', 'department'];
// Must stay identical to 0023_hod_seat_assignment.sql's exclusion list.
const OCCUPIED_EXCLUDED_STATUSES = ['Rejected', 'Cancelled', 'Expired', 'No Show'];
const REASSIGNABLE_STATUSES = ['Approved', 'Checked-In'];
// The HOD Reserved Seat Request self-service flow always routes through
// the legacy GM -> RM -> HR chain (never the department hierarchy - an
// HOD approving their own request, or routing it to their own
// department's tiers, doesn't make sense), so these are the only
// pre-departure statuses a self-requested booking can ever be in.
export const HOD_SELF_CANCELLABLE_STATUSES = ['Pending', 'Waiting GM Approval', 'Waiting RM Approval', 'Waiting HR Approval', 'Approved', 'Checked-In'];

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
            .select('reservation_id, schedule_id, department_id, resort_id, reservation_type, status, seats, start_date, end_date, departments(department_name), ferry_schedule(service_name, ferry_routes(direction))')
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
            direction: reservation.ferry_schedule?.service_name ?? reservation.ferry_schedule?.ferry_routes?.direction ?? null,
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

    const scheduleRows = unwrap(await db().from('ferry_schedule').select('schedule_id, service_name, ferry_routes(direction)').eq('schedule_id', scheduleId).limit(1));
    if (!scheduleRows.length) return { ok: false, reason: 'invalid_schedule' };
    const direction = scheduleRows[0].service_name ?? scheduleRows[0].ferry_routes?.direction ?? null;

    // Prevent an exact duplicate of this same resort+schedule+
    // department+date - other departments (or a department-less
    // resort-wide row) are still free to coexist for this schedule/date.
    const dup = unwrap(
        await db()
            .from('seat_reservations')
            .select('reservation_id')
            .eq('reservation_type', 'hod')
            .eq('status', 'active')
            .eq('schedule_id', scheduleId)
            .eq('resort_id', resortId)
            .eq('department_id', departmentId)
            .lte('start_date', travelDate)
            .gte('end_date', travelDate)
    );
    if (dup.length) return { ok: false, reason: 'duplicate_reservation' };

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
                    'departments(department_name), ferry_schedule(service_name, ferry_routes(direction))'
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
    const direction = reservation.ferry_schedule?.service_name ?? reservation.ferry_schedule?.ferry_routes?.direction ?? null;
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
    const direction = reservation.ferry_schedule?.service_name ?? reservation.ferry_schedule?.ferry_routes?.direction ?? null;
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
        direction: reservation?.ferry_schedule?.service_name ?? reservation?.ferry_schedule?.ferry_routes?.direction ?? null,
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
        direction: reservation?.ferry_schedule?.service_name ?? reservation?.ferry_schedule?.ferry_routes?.direction ?? null,
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

// =====================================================================
// HOD Self-Service Reserved Seat Request: lets an HOD request ONLY for
// themselves - distinct from everything above, which is Security/HR/
// Administrator assigning a NAMED employee (any department member) to
// a reservation. Self-service NEVER creates its own reservation row -
// it only consumes whatever active HOD reservation(s) Admin/HR/
// Security already created via the Seat Reservations "New Reservation"
// form or Security's own quick-create, for this exact resort+schedule+
// date. Going forward there should be exactly one such row per
// (resort, schedule, date), but some resorts already have several
// pre-existing department-specific HOD rows (one per department,
// created before this self-service feature existed) - rather than
// break that, every active 'hod' row for this resort+schedule+date is
// summed together as the resort's total HOD allocation, and a request
// is placed against whichever row still has room.
// =====================================================================

/** Every active HOD Reserved Seat row for this resort+schedule+date - department_id is irrelevant to the lookup (Security may optionally set one purely to scope its own named-employee search; the allocation itself has no department dimension for self-service purposes). Empty array if Admin/HR haven't configured any yet - self-service never creates one itself. */
async function findHodPoolRows({ resortId, scheduleId, travelDate }) {
    const weekday = weekdayFor(travelDate);
    const rows = unwrap(
        await db()
            .from('seat_reservations')
            .select('reservation_id, seats, weekdays, resort_id')
            .eq('schedule_id', scheduleId)
            .eq('reservation_type', 'hod')
            .eq('status', 'active')
            .lte('start_date', travelDate)
            .gte('end_date', travelDate)
            .order('reservation_id', { ascending: true })
    );
    // resort_id NULL means "Both Resorts" (the Administrator Bulk
    // Reservation feature's "Both Resorts" option) - .eq('resort_id',
    // resortId) above would never match it (SQL equality never matches
    // NULL), making a Both-Resorts HOD allocation invisible to every
    // single resort's own HOD Reserved Seat Request page. Filtered in JS
    // instead so it counts toward every resort's pool, same as it's
    // meant to.
    return rows.filter((r) => (r.resort_id === resortId || r.resort_id === null) && r.weekdays.includes(weekday));
}

/** True if this employee already holds an active HOD-assigned seat ANYWHERE on this date - across every ferry schedule that day, not just one - since an HOD may only request one reserved seat per day. */
async function employeeHasHodAssignmentOnDate(userId, travelDate, excludeBookingId = null) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, schedule_id, booking_status(status_name), ferry_schedule(service_name, ferry_routes(direction))')
            .eq('user_id', userId)
            .eq('travel_date', travelDate)
            .not('source_reservation_id', 'is', null)
    );
    return rows.find((r) => r.booking_id !== excludeBookingId && !OCCUPIED_EXCLUDED_STATUSES.includes(r.booking_status.status_name)) ?? null;
}

/** Read-only status for the HOD Reserved Seat Request page: the resort's total/assigned/available for this schedule+date, summed across every active HOD row that already exists (0/0/0 if Admin/HR haven't configured any yet - self-service never creates one), plus the caller's own current booking for this DATE (any schedule - one reserved seat per day, not per schedule), so the page can show a Request or Cancel button and explain when the existing booking is for a different departure. */
export async function getOwnHodSeatStatus({ resortId, scheduleId, travelDate, userId }) {
    const poolRows = await findHodPoolRows({ resortId, scheduleId, travelDate });
    const perRowAssigned = await Promise.all(poolRows.map((r) => countActiveAssignments(r.reservation_id, travelDate)));
    const seatsTotal = poolRows.reduce((sum, r) => sum + r.seats, 0);
    const seatsAssigned = perRowAssigned.reduce((sum, c) => sum + c, 0);

    const myActive = await employeeHasHodAssignmentOnDate(userId, travelDate);

    return {
        seatsTotal,
        seatsAssigned,
        seatsAvailable: Math.max(0, seatsTotal - seatsAssigned),
        poolConfigured: poolRows.length > 0,
        myBookingId: myActive?.booking_id ?? null,
        myStatus: myActive?.booking_status?.status_name ?? null,
        myScheduleDirection: myActive && myActive.schedule_id !== scheduleId ? (myActive.ferry_schedule?.service_name ?? myActive.ferry_schedule?.ferry_routes?.direction ?? null) : null,
    };
}

/**
 * The HOD's own self-request - always books the requester themselves
 * against the resort-wide pool, never another employee and never a
 * department-scoped reservation. Re-validates everything server-side
 * (resort match, schedule validity, no existing HOD seat anywhere on
 * this date - one per day, not per schedule - remaining capacity)
 * rather than trusting the page's own status check.
 *
 * Not auto-approved: the booking is inserted Pending and immediately
 * routed through the legacy GM -> RM -> HR chain (routeBookingApproval),
 * same as it would notify/assign for any other booking - an HOD
 * reserving a seat for themselves still needs GM/RM/HR sign-off, it
 * just skips the department-hierarchy tiers (which would otherwise ask
 * the HOD to approve their own request). The seat is still held in the
 * pool immediately (every pre-departure status counts toward
 * countActiveAssignments()), so approval delay never risks losing the
 * reservation to someone else.
 */
export async function requestOwnHodSeat({ resortId, scheduleId, travelDate, userId, remarks }) {
    const employeeRows = unwrap(await db().from('users').select('user_id, full_name, employee_id, department_id, resort_id, status').eq('user_id', userId).limit(1));
    const employee = employeeRows[0];
    if (!employee || employee.status !== 'active' || employee.resort_id !== resortId) return { ok: false, reason: 'invalid_resort' };

    const scheduleRows = unwrap(await db().from('ferry_schedule').select('schedule_id, status, weekdays, service_name, ferry_routes(direction)').eq('schedule_id', scheduleId).limit(1));
    const schedule = scheduleRows[0];
    if (!schedule || schedule.status !== 'active' || !schedule.weekdays.includes(weekdayFor(travelDate))) return { ok: false, reason: 'invalid_schedule' };

    if (await employeeHasHodAssignmentOnDate(userId, travelDate)) return { ok: false, reason: 'already_requested' };

    // Never creates a reservation - Admin/HR/Security must configure at
    // least one HOD allocation first (Seat Reservations page or the
    // manifest's quick-create), matching "the HOD Self-Service module
    // shall... not create a new HOD Reservation record." If several
    // rows already exist for this resort+schedule+date (the legacy
    // one-per-department pattern), place the request against whichever
    // one still has room rather than requiring a single row.
    const poolRows = await findHodPoolRows({ resortId, scheduleId, travelDate });
    if (!poolRows.length) return { ok: false, reason: 'no_pool_configured' };
    let targetRow = null;
    for (const row of poolRows) {
        const assigned = await countActiveAssignments(row.reservation_id, travelDate);
        if (assigned < row.seats) {
            targetRow = row;
            break;
        }
    }
    if (!targetRow) return { ok: false, reason: 'seat_unavailable' };

    const pendingId = await getStatusId('Pending');
    const direction = schedule.service_name ?? schedule.ferry_routes?.direction ?? null;
    const inserted = unwrap(
        await db()
            .from('bookings')
            .insert({
                user_id: userId,
                schedule_id: scheduleId,
                travel_date: travelDate,
                direction,
                purpose: HOD_BOOKING_PURPOSE,
                remarks: remarks || null,
                seats: 1,
                status_id: pendingId,
                booking_method: 'hod_seat_assignment',
                source_reservation_id: targetRow.reservation_id,
            })
            .select('*')
    );
    const booking = inserted[0];

    await routeBookingApproval(booking.booking_id);
    await createNotification(userId, 'Your HOD reserved seat request has been submitted and is awaiting GM/RM/HR approval.', 'booking', booking.booking_id);

    await insertHodAssignmentLog({
        reservation_id: targetRow.reservation_id,
        schedule_id: scheduleId,
        direction,
        travel_date: travelDate,
        resort_id: resortId,
        department_id: employee.department_id,
        department_name_snapshot: null,
        booking_id: booking.booking_id,
        action: 'assigned',
        employee_assigned_user_id: employee.user_id,
        employee_assigned_name_snapshot: employee.full_name,
        employee_assigned_id_snapshot: employee.employee_id,
        assigned_by_user_id: userId,
        remarks: remarks || 'Self-requested via HOD Reserved Seat Request - awaiting GM/RM/HR approval',
    });

    return { ok: true, booking };
}

/** The HOD cancelling their own request - refuses any booking that isn't theirs, and allows it any time before departure, whether still awaiting GM/RM/HR approval or already Approved. */
export async function cancelOwnHodSeatRequest({ bookingId, userId, remarks }) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, user_id, schedule_id, travel_date, source_reservation_id, users!bookings_user_id_fkey(full_name, employee_id), booking_status(status_name)')
            .eq('booking_id', bookingId)
            .limit(1)
    );
    const booking = rows[0];
    if (!booking || booking.user_id !== userId || !booking.source_reservation_id) return { ok: false, reason: 'not_hod_assignment' };
    if (!HOD_SELF_CANCELLABLE_STATUSES.includes(booking.booking_status.status_name)) return { ok: false, reason: 'too_late_to_release' };

    const reservation = await loadReservationForWrite(booking.source_reservation_id);

    const cancelledId = await getStatusId('Cancelled');
    unwrap(await db().from('bookings').update({ status_id: cancelledId }).eq('booking_id', bookingId));

    await insertHodAssignmentLog({
        reservation_id: booking.source_reservation_id,
        schedule_id: booking.schedule_id,
        direction: reservation?.ferry_schedule?.service_name ?? reservation?.ferry_schedule?.ferry_routes?.direction ?? null,
        travel_date: booking.travel_date,
        resort_id: reservation?.resort_id ?? null,
        department_id: reservation?.department_id ?? null,
        department_name_snapshot: null,
        booking_id: bookingId,
        action: 'released',
        employee_removed_user_id: booking.user_id,
        employee_removed_name_snapshot: booking.users.full_name,
        employee_removed_id_snapshot: booking.users.employee_id,
        assigned_by_user_id: userId,
        remarks: remarks || 'Cancelled by HOD (self-service)',
    });

    return { ok: true };
}

/** All of this user's own HOD Reserved Seat Request bookings, most recent travel date first - covers both "status of requests" and "booking history" in one list, since self-service HOD bookings are the only kind an HOD makes through this feature. */
export async function listOwnHodSeatRequests(userId) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, travel_date, direction, created_at, source_reservation_id, booking_status(status_name, badge_color), ferry_schedule(departure_time, service_name, ferry_routes(route_name, direction))')
            .eq('user_id', userId)
            .eq('booking_method', 'hod_seat_assignment')
            .order('travel_date', { ascending: false })
            .limit(100)
    );
    if (!rows.length) return [];

    const reservationIds = [...new Set(rows.map((r) => r.source_reservation_id).filter(Boolean))];
    const reservations = reservationIds.length
        ? unwrap(await db().from('seat_reservations').select('reservation_id, resorts(resort_name)').in('reservation_id', reservationIds))
        : [];
    const resortNameByReservation = new Map(reservations.map((r) => [r.reservation_id, r.resorts?.resort_name ?? '-']));

    return rows.map((r) => ({ ...r, resortName: resortNameByReservation.get(r.source_reservation_id) ?? '-' }));
}
