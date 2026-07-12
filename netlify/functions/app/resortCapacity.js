// Resort Capacity Allocator (CGLM / CMLM) - Phase 1: configuration,
// validation, and audit only. Nothing here is read by book_ferry_seat()
// or the waiting-list promotion path yet (Phase 2, deliberately
// deferred - see 0031_resort_capacity_allocation.sql's header comment)
// - a service with no ferry_resort_capacity rows keeps behaving exactly
// as it does today, a single shared pool.

import { db, unwrap } from './db.js';
import { getActiveResorts } from './refData.js';

const NON_COUNTED_STATUSES = ['Rejected', 'Cancelled', 'Expired'];

async function insertLog(row) {
    unwrap(await db().from('ferry_resort_capacity_log').insert(row));
}

/**
 * The seat limit a Seat Reservation for this schedule+resort must
 * respect - the resort's own Resort Capacity Allocator allocation if
 * one is configured for this schedule AND the reservation is for a
 * specific resort, otherwise the ferry's raw total capacity (today's
 * behavior, unchanged). A "Both Resorts" reservation (resortId null)
 * isn't tied to one resort's own sub-pool, so it keeps checking
 * against the ferry-wide total either way - only a resort-specific
 * reservation on a split-configured service gets the stricter, correct
 * limit instead of silently being allowed to exceed what that resort
 * actually has.
 */
/** Whether this schedule has any Resort Capacity Allocator split configured at all - used to gate the new resort-aware check to split-configured services only, leaving unsplit services' reservation validation exactly as it was before this check existed. */
export async function hasCapacitySplit(scheduleId) {
    const rows = unwrap(await db().from('ferry_resort_capacity').select('allocation_id').eq('schedule_id', scheduleId).limit(1));
    return rows.length > 0;
}

export async function getEffectiveCapacityLimit(scheduleId, resortId) {
    const scheduleRows = unwrap(await db().from('ferry_schedule').select('capacity').eq('schedule_id', scheduleId).limit(1));
    const totalCapacity = scheduleRows[0]?.capacity ?? null;
    if (resortId == null) return totalCapacity;
    const allocationRows = unwrap(await db().from('ferry_resort_capacity').select('allocated_seats').eq('schedule_id', scheduleId).eq('resort_id', resortId).limit(1));
    if (!allocationRows.length) return totalCapacity;
    return allocationRows[0].allocated_seats;
}

export async function getAllocationForService(scheduleId) {
    const rows = unwrap(
        await db().from('ferry_resort_capacity').select('resort_id, allocated_seats, resorts(resort_name)').eq('schedule_id', scheduleId).order('resort_id')
    );
    if (!rows.length) return null;
    const scheduleRows = unwrap(await db().from('ferry_schedule').select('capacity, service_name, service_code').eq('schedule_id', scheduleId).limit(1));
    return {
        totalCapacity: scheduleRows[0]?.capacity ?? null,
        serviceName: scheduleRows[0]?.service_name ?? null,
        serviceCode: scheduleRows[0]?.service_code ?? null,
        rows: rows.map((r) => ({ resortId: r.resort_id, resortName: r.resorts?.resort_name ?? '-', allocatedSeats: r.allocated_seats })),
    };
}

/** The busiest single future date's confirmed-booking seat count for this resort on this schedule - the conservative floor a reduced allocation must never go below, so no already-booked date ever becomes invalid. */
async function maxBookedSeatsForResort(scheduleId, resortId) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('travel_date, seats, booking_status(status_name), users!bookings_user_id_fkey(resort_id)')
            .eq('schedule_id', scheduleId)
            .gte('travel_date', today)
    );
    const byDate = new Map();
    for (const r of rows) {
        if (NON_COUNTED_STATUSES.includes(r.booking_status?.status_name)) continue;
        if (r.users?.resort_id !== resortId) continue;
        byDate.set(r.travel_date, (byDate.get(r.travel_date) ?? 0) + r.seats);
    }
    return byDate.size ? Math.max(...byDate.values()) : 0;
}

/**
 * Today's reserved-seats figure for this resort, via the same
 * resort-aware RPC the read-only usage dashboard uses. A reservation's
 * seat count doesn't vary by date (only which weekdays it applies to
 * does), so checking "today" is a reasonable, honest Phase-1 safety
 * floor rather than an exhaustive scan of every future date this
 * schedule ever runs - this is a config-time safety guard, not the
 * live booking-acceptance path.
 */
async function reservedSeatsForResortToday(scheduleId, resortId) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = unwrap(await db().rpc('get_remaining_seats_by_resort', { p_schedule_id: scheduleId, p_travel_date: today }));
    return rows.find((r) => r.resort_id === resortId)?.reserved ?? 0;
}

const ALLOCATION_ERROR_MESSAGES = {
    not_found: 'Ferry service not found.',
    invalid_resorts: 'Could not determine the active resorts to allocate between.',
    negative_seats: 'Seat allocations cannot be negative.',
    sum_mismatch: (total) => `The allocated seats must add up to exactly the ferry's total capacity (${total}).`,
    below_booked: (resortName, min) => `Cannot reduce ${resortName}'s allocation below its busiest already-booked date (${min} seat(s) confirmed).`,
    below_reserved: (resortName, min) => `Cannot reduce ${resortName}'s allocation below its currently reserved seats (${min}).`,
    missing_reason: 'Please provide a reason for this change.',
};

/**
 * allocations: [{ resortId, seats }, ...] - must cover every active
 * resort exactly once. Validates sum === total capacity, no negative
 * seats, and (for any resort whose allocation is being reduced) that
 * the new value isn't below that resort's busiest booked date or its
 * current reserved seats. Writes one ferry_resort_capacity_log row
 * (flattened to 2 resort slots, ordered by resort_id) covering both
 * resorts' before/after regardless of which one(s) actually changed.
 */
export async function setAllocation({ scheduleId, allocations, actorUserId, reason }) {
    if (!reason?.trim()) return { ok: false, reason: 'missing_reason' };

    const scheduleRows = unwrap(await db().from('ferry_schedule').select('schedule_id, capacity, service_name').eq('schedule_id', scheduleId).limit(1));
    const schedule = scheduleRows[0];
    if (!schedule) return { ok: false, reason: 'not_found' };

    const resorts = await getActiveResorts();
    if (resorts.length < 1) return { ok: false, reason: 'invalid_resorts' };
    const resortIds = new Set(resorts.map((r) => r.resort_id));

    for (const a of allocations) {
        if (!resortIds.has(a.resortId)) return { ok: false, reason: 'invalid_resorts' };
        if (!Number.isInteger(a.seats) || a.seats < 0) return { ok: false, reason: 'negative_seats' };
    }
    const sum = allocations.reduce((s, a) => s + a.seats, 0);
    if (sum !== schedule.capacity) return { ok: false, reason: 'sum_mismatch', message: ALLOCATION_ERROR_MESSAGES.sum_mismatch(schedule.capacity) };

    const existing = await getAllocationForService(scheduleId);
    const existingByResort = new Map((existing?.rows ?? []).map((r) => [r.resortId, r.allocatedSeats]));

    for (const a of allocations) {
        const previousSeats = existingByResort.get(a.resortId);
        if (previousSeats != null && a.seats < previousSeats) {
            const resortName = resorts.find((r) => r.resort_id === a.resortId)?.resort_name ?? `resort ${a.resortId}`;
            const maxBooked = await maxBookedSeatsForResort(scheduleId, a.resortId);
            if (a.seats < maxBooked) {
                return { ok: false, reason: 'below_booked', message: ALLOCATION_ERROR_MESSAGES.below_booked(resortName, maxBooked) };
            }
            const reservedToday = await reservedSeatsForResortToday(scheduleId, a.resortId);
            if (a.seats < reservedToday) {
                return { ok: false, reason: 'below_reserved', message: ALLOCATION_ERROR_MESSAGES.below_reserved(resortName, reservedToday) };
            }
        }
    }

    for (const a of allocations) {
        unwrap(
            await db()
                .from('ferry_resort_capacity')
                .upsert({ schedule_id: scheduleId, resort_id: a.resortId, allocated_seats: a.seats, updated_by_user_id: actorUserId }, { onConflict: 'schedule_id,resort_id' })
        );
    }

    const sortedResorts = resorts.slice().sort((x, y) => x.resort_id - y.resort_id);
    const [resortA, resortB] = sortedResorts;
    const seatsFor = (resort) => allocations.find((a) => a.resortId === resort?.resort_id)?.seats ?? null;
    const previousSeatsFor = (resort) => existingByResort.get(resort?.resort_id) ?? null;

    await insertLog({
        schedule_id: scheduleId,
        service_name_snapshot: schedule.service_name,
        resort_a_id: resortA?.resort_id ?? null,
        resort_a_name_snapshot: resortA?.resort_name ?? null,
        previous_resort_a_seats: previousSeatsFor(resortA),
        new_resort_a_seats: seatsFor(resortA),
        resort_b_id: resortB?.resort_id ?? null,
        resort_b_name_snapshot: resortB?.resort_name ?? null,
        previous_resort_b_seats: previousSeatsFor(resortB),
        new_resort_b_seats: seatsFor(resortB),
        total_capacity: schedule.capacity,
        action: existing ? 'modified' : 'created',
        actor_user_id: actorUserId,
        reason: reason.trim(),
    });

    return { ok: true };
}

export async function removeAllocation({ scheduleId, actorUserId, reason }) {
    if (!reason?.trim()) return { ok: false, reason: 'missing_reason' };
    const existing = await getAllocationForService(scheduleId);
    if (!existing) return { ok: false, reason: 'not_found' };

    const scheduleRows = unwrap(await db().from('ferry_schedule').select('service_name, capacity').eq('schedule_id', scheduleId).limit(1));
    const resorts = (await getActiveResorts()).slice().sort((x, y) => x.resort_id - y.resort_id);
    const [resortA, resortB] = resorts;
    const byResort = new Map(existing.rows.map((r) => [r.resortId, r.allocatedSeats]));

    unwrap(await db().from('ferry_resort_capacity').delete().eq('schedule_id', scheduleId));

    await insertLog({
        schedule_id: scheduleId,
        service_name_snapshot: scheduleRows[0]?.service_name ?? existing.serviceName,
        resort_a_id: resortA?.resort_id ?? null,
        resort_a_name_snapshot: resortA?.resort_name ?? null,
        previous_resort_a_seats: byResort.get(resortA?.resort_id) ?? null,
        new_resort_a_seats: null,
        resort_b_id: resortB?.resort_id ?? null,
        resort_b_name_snapshot: resortB?.resort_name ?? null,
        previous_resort_b_seats: byResort.get(resortB?.resort_id) ?? null,
        new_resort_b_seats: null,
        total_capacity: scheduleRows[0]?.capacity ?? existing.totalCapacity,
        action: 'removed',
        actor_user_id: actorUserId,
        reason: reason.trim(),
    });

    return { ok: true };
}

/**
 * Applies the same allocations object (resort seats keyed by resortId)
 * to every schedule in scheduleIds. Each service's own total capacity
 * must already equal the sum of the given allocations, or it's skipped
 * (with a reason) rather than silently rescaled - a bulk apply is
 * meant for services that already share the same total capacity (e.g.
 * "all Morning Ferry Services" at 58 seats each), not an implicit
 * proportional rescale.
 */
export async function bulkApplyAllocation({ scheduleIds, allocations, actorUserId, reason }) {
    let appliedCount = 0;
    const skipped = [];
    for (const scheduleId of scheduleIds) {
        const result = await setAllocation({ scheduleId, allocations, actorUserId, reason });
        if (result.ok) {
            appliedCount++;
        } else {
            skipped.push(`#${scheduleId} (${result.message || ALLOCATION_ERROR_MESSAGES[result.reason] || result.reason})`);
        }
    }
    return { appliedCount, skipped };
}

export async function getUsageForService(scheduleId, travelDate) {
    const rows = unwrap(await db().rpc('get_remaining_seats_by_resort', { p_schedule_id: scheduleId, p_travel_date: travelDate }));
    if (!rows.length) return null;

    const waitingListRows = unwrap(
        await db()
            .from('bookings')
            .select('seats, users!bookings_user_id_fkey(resort_id), booking_status!inner(status_name)')
            .eq('schedule_id', scheduleId)
            .eq('travel_date', travelDate)
            .eq('booking_status.status_name', 'Waiting List')
    );
    const waitingByResort = new Map();
    for (const w of waitingListRows) {
        const resortId = w.users?.resort_id;
        waitingByResort.set(resortId, (waitingByResort.get(resortId) ?? 0) + w.seats);
    }

    return rows.map((r) => ({
        resortId: r.resort_id,
        resortName: r.resort_name,
        allocated: r.allocated,
        booked: r.booked,
        reserved: r.reserved,
        available: r.remaining,
        waitingList: waitingByResort.get(r.resort_id) ?? 0,
        utilizationPercent: r.allocated > 0 ? Math.round(((r.booked + r.reserved) / r.allocated) * 100) : 0,
    }));
}

export { ALLOCATION_ERROR_MESSAGES };
