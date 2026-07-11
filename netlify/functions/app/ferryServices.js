// Route-Based Ferry Service Management (Phase 1 - data model + Admin
// management only). A "ferry service" is a ferry_schedule row treated
// as a whole continuous route rather than a single leg - route_stops
// hangs off its schedule_id (see 0028_ferry_service_routes.sql for the
// full rationale on why ferry_schedule keeps its identity/PK instead
// of being replaced by a parallel table).
//
// ferry_schedule.departure_time stays in sync with the route's first
// stop's departure_time (kept NOT NULL so every existing consumer -
// dashboards, booking form, security manifest, reports - keeps working
// completely unchanged without any code changes of their own; Phase 1
// is purely additive).

import { db, unwrap } from './db.js';

const STOP_ORDER_ASC = { ascending: true };

function routeSnapshotFromStops(stops) {
    return stops.map((s) => s.stop_name).join(' → ') || '(no stops configured)';
}

async function insertServiceLog(row) {
    unwrap(await db().from('ferry_service_log').insert(row));
}

async function loadStops(scheduleId) {
    return unwrap(await db().from('route_stops').select('*').eq('schedule_id', scheduleId).order('stop_order', STOP_ORDER_ASC));
}

/** Keeps ferry_schedule.departure_time equal to the route's first stop's departure_time, so every pre-existing consumer of that column (sorting/display across the whole app) stays accurate with zero changes of its own. Falls back to '00:00:00' for a service with no stops yet. */
async function syncServiceDepartureTime(scheduleId) {
    const stops = await loadStops(scheduleId);
    const first = stops.find((s) => s.stop_order === 1);
    const departureTime = first?.departure_time ?? '00:00:00';
    unwrap(await db().from('ferry_schedule').update({ departure_time: departureTime }).eq('schedule_id', scheduleId));
}

/** Renumbers a service's stops 1..N from whatever order they're currently in (or a caller-supplied explicit order) - gaps/duplicates are structurally impossible rather than validated after the fact. */
async function renumberStops(scheduleId, orderedStopIds = null) {
    const stops = await loadStops(scheduleId);
    const order = orderedStopIds ?? stops.map((s) => s.stop_id);
    // Two-phase update: UNIQUE(schedule_id, stop_order) would otherwise
    // reject a mid-sequence write when swapping/reordering (e.g. moving
    // stop A from order 4 to where stop B currently sits at order 5
    // briefly needs two rows at order 5 if updated one at a time).
    // Negative placeholders can never collide with a real 1..N target.
    for (let i = 0; i < order.length; i++) {
        unwrap(await db().from('route_stops').update({ stop_order: -(i + 1) }).eq('stop_id', order[i]));
    }
    for (let i = 0; i < order.length; i++) {
        unwrap(await db().from('route_stops').update({ stop_order: i + 1 }).eq('stop_id', order[i]));
    }
}

/** Every stop after the first must depart no earlier than it arrives, and no earlier than the previous stop's departure - keeps the route chronologically sane. Returns an error string, or null if valid. */
function validateStopChronology(stops) {
    for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        if (s.arrival_time && s.departure_time && s.departure_time < s.arrival_time) {
            return `${s.stop_name}: departure time cannot be before arrival time.`;
        }
        if (i > 0) {
            const prev = stops[i - 1];
            const prevDeparture = prev.departure_time;
            if (prevDeparture && s.arrival_time && s.arrival_time < prevDeparture) {
                return `${s.stop_name}: arrival time cannot be before the previous stop's (${prev.stop_name}) departure time.`;
            }
        }
    }
    return null;
}

export async function getFerryServices({ statusFilter } = {}) {
    let query = db()
        .from('ferry_schedule')
        .select('schedule_id, service_name, service_code, departure_time, capacity, weekdays, effective_date, expiry_date, status, created_at')
        .order('schedule_id', { ascending: false });
    if (statusFilter) query = query.eq('status', statusFilter);
    const services = unwrap(await query);
    if (!services.length) return [];

    const scheduleIds = services.map((s) => s.schedule_id);
    const allStops = unwrap(await db().from('route_stops').select('schedule_id, stop_name, stop_order').in('schedule_id', scheduleIds).order('stop_order', STOP_ORDER_ASC));
    const stopsBySchedule = new Map();
    for (const stop of allStops) {
        if (!stopsBySchedule.has(stop.schedule_id)) stopsBySchedule.set(stop.schedule_id, []);
        stopsBySchedule.get(stop.schedule_id).push(stop);
    }

    return services.map((s) => {
        const stops = stopsBySchedule.get(s.schedule_id) ?? [];
        return { ...s, stopCount: stops.length, routeSnapshot: routeSnapshotFromStops(stops) };
    });
}

export async function getServiceWithStops(scheduleId) {
    const rows = unwrap(await db().from('ferry_schedule').select('*').eq('schedule_id', scheduleId).limit(1));
    const service = rows[0];
    if (!service) return null;
    const stops = await loadStops(scheduleId);
    return { ...service, stops, routeSnapshot: routeSnapshotFromStops(stops) };
}

/**
 * Every active Ferry Service with a configured route (>= 2 stops),
 * bookable as a whole journey (not a sub-segment - segment-level
 * booking is Phase 2, since it needs a real segment-aware capacity
 * model; booking the full route still uses the existing flat per-
 * schedule capacity correctly, since it's still "the whole schedule,
 * booked as a whole"). This is what connects a Ferry Service
 * (admin_ferry_services.js) to the booking flow (staff.js/ajax.js) - a
 * service created there has no ferry_routes row at all (route_id is
 * NULL by design), so it would otherwise never appear as bookable.
 *
 * The bookable label is the service's own name + code (e.g. "The
 * Atollia Evening (SVC-8)") rather than a derived "First Stop to Last
 * Stop" string - for a round-trip route that's the same stop at both
 * ends ("CGLM to CGLM"), which reads as meaningless/confusing to an
 * employee booking a seat. Falls back to the stop-chain string only if
 * the service somehow has no name.
 */
export async function getWholeRouteDirections() {
    const services = unwrap(
        await db()
            .from('ferry_schedule')
            .select('schedule_id, service_name, service_code, capacity, weekdays, status')
            .eq('status', 'active')
    );
    if (!services.length) return [];

    const allStops = unwrap(
        await db()
            .from('route_stops')
            .select('schedule_id, stop_order, stop_name, arrival_time, departure_time, status')
            .in('schedule_id', services.map((s) => s.schedule_id))
            .eq('status', 'active')
            .order('stop_order', STOP_ORDER_ASC)
    );
    const stopsBySchedule = new Map();
    for (const stop of allStops) {
        if (!stopsBySchedule.has(stop.schedule_id)) stopsBySchedule.set(stop.schedule_id, []);
        stopsBySchedule.get(stop.schedule_id).push(stop);
    }

    const results = [];
    for (const service of services) {
        const stops = stopsBySchedule.get(service.schedule_id) ?? [];
        if (stops.length < 2) continue;
        const first = stops[0];
        const last = stops[stops.length - 1];
        const nameAndCode = service.service_name
            ? service.service_code
                ? `${service.service_name} (${service.service_code})`
                : service.service_name
            : `${first.stop_name} to ${last.stop_name}`;
        results.push({
            scheduleId: service.schedule_id,
            direction: nameAndCode,
            boardingStopName: first.stop_name,
            destinationStopName: last.stop_name,
            boardingTime: first.departure_time,
            arrivalTime: last.arrival_time,
            capacity: service.capacity,
            weekdays: service.weekdays,
        });
    }
    return results;
}

/**
 * Individual stop/location names for the "Stop Name" picker, derived
 * from Direction Management (directions.name, e.g. "CGLM to CMLM") -
 * there's no separate "locations" table, and directions are already
 * the app's one admin-curated source of location names, so a stop's
 * name is picked from here rather than free-typed (avoiding
 * inconsistent spelling like "Hulhumale" vs "Hulhumalé" across stops).
 * Every direction name is split on " to " and both halves are kept as
 * candidates, deduplicated and sorted.
 */
export async function getStopNameOptions() {
    const rows = unwrap(await db().from('directions').select('name').eq('status', 'active'));
    const names = new Set();
    for (const row of rows) {
        for (const part of row.name.split(' to ')) {
            const trimmed = part.trim();
            if (trimmed) names.add(trimmed);
        }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

/** Non-blocking duplicate-service check: other ACTIVE services with the same stop-name chain and an overlapping effective/expiry range. Returns a warning string, or null. */
export async function findSimilarActiveServiceWarning(scheduleId) {
    const service = await getServiceWithStops(scheduleId);
    if (!service || !service.stops.length) return null;

    const others = unwrap(
        await db()
            .from('ferry_schedule')
            .select('schedule_id, service_name, effective_date, expiry_date')
            .eq('status', 'active')
            .neq('schedule_id', scheduleId)
    );
    if (!others.length) return null;

    const otherStops = unwrap(await db().from('route_stops').select('schedule_id, stop_name, stop_order').in('schedule_id', others.map((o) => o.schedule_id)).order('stop_order', STOP_ORDER_ASC));
    const stopsByOther = new Map();
    for (const stop of otherStops) {
        if (!stopsByOther.has(stop.schedule_id)) stopsByOther.set(stop.schedule_id, []);
        stopsByOther.get(stop.schedule_id).push(stop);
    }

    const matches = others.filter((o) => {
        const chain = routeSnapshotFromStops(stopsByOther.get(o.schedule_id) ?? []);
        if (chain !== service.routeSnapshot) return false;
        const oStart = o.effective_date ?? '0001-01-01';
        const oEnd = o.expiry_date ?? '9999-12-31';
        const sStart = service.effective_date ?? '0001-01-01';
        const sEnd = service.expiry_date ?? '9999-12-31';
        return oStart <= sEnd && oEnd >= sStart;
    });

    if (!matches.length) return null;
    return `Note: this same route (${service.routeSnapshot}) is also configured on "${matches[0].service_name}" with an overlapping effective date range.`;
}

export async function createFerryService({ serviceName, serviceCode, weekdays, capacity, effectiveDate, expiryDate, createdByUserId }) {
    if (!serviceName?.trim()) return { ok: false, reason: 'invalid_name' };
    if (!serviceCode?.trim()) return { ok: false, reason: 'invalid_code' };
    if (!Number.isInteger(capacity) || capacity < 1) return { ok: false, reason: 'invalid_capacity' };
    if (!weekdays?.length) return { ok: false, reason: 'invalid_weekdays' };
    if (!effectiveDate) return { ok: false, reason: 'invalid_effective_date' };
    if (expiryDate && expiryDate < effectiveDate) return { ok: false, reason: 'invalid_expiry_date' };

    const existingCode = unwrap(await db().from('ferry_schedule').select('schedule_id').eq('service_code', serviceCode.trim()).limit(1));
    if (existingCode.length) return { ok: false, reason: 'duplicate_code' };

    const inserted = unwrap(
        await db()
            .from('ferry_schedule')
            .insert({
                route_id: null,
                departure_time: '00:00:00',
                capacity,
                weekdays,
                status: 'active',
                service_name: serviceName.trim(),
                service_code: serviceCode.trim(),
                effective_date: effectiveDate,
                expiry_date: expiryDate || null,
            })
            .select('*')
    );
    const service = inserted[0];

    await insertServiceLog({
        schedule_id: service.schedule_id,
        service_name_snapshot: service.service_name,
        service_code_snapshot: service.service_code,
        route_snapshot: '(no stops configured)',
        action: 'created',
        actor_user_id: createdByUserId,
        reason: null,
    });

    return { ok: true, service };
}

export async function updateFerryService({ scheduleId, serviceName, serviceCode, weekdays, capacity, effectiveDate, expiryDate, actorUserId, reason }) {
    const existing = await getServiceWithStops(scheduleId);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (!serviceName?.trim()) return { ok: false, reason: 'invalid_name' };
    if (!serviceCode?.trim()) return { ok: false, reason: 'invalid_code' };
    if (!Number.isInteger(capacity) || capacity < 1) return { ok: false, reason: 'invalid_capacity' };
    if (!weekdays?.length) return { ok: false, reason: 'invalid_weekdays' };
    if (!effectiveDate) return { ok: false, reason: 'invalid_effective_date' };
    if (expiryDate && expiryDate < effectiveDate) return { ok: false, reason: 'invalid_expiry_date' };

    const trimmedCode = serviceCode.trim();
    if (trimmedCode !== existing.service_code) {
        const existingCode = unwrap(await db().from('ferry_schedule').select('schedule_id').eq('service_code', trimmedCode).neq('schedule_id', scheduleId).limit(1));
        if (existingCode.length) return { ok: false, reason: 'duplicate_code' };
    }

    unwrap(
        await db()
            .from('ferry_schedule')
            .update({ service_name: serviceName.trim(), service_code: trimmedCode, capacity, weekdays, effective_date: effectiveDate, expiry_date: expiryDate || null })
            .eq('schedule_id', scheduleId)
    );

    await insertServiceLog({
        schedule_id: scheduleId,
        service_name_snapshot: serviceName.trim(),
        service_code_snapshot: trimmedCode,
        route_snapshot: existing.routeSnapshot,
        action: 'modified',
        actor_user_id: actorUserId,
        reason: reason || null,
    });

    return { ok: true };
}

export async function setFerryServiceStatus({ scheduleId, status, actorUserId, reason }) {
    if (!['active', 'inactive'].includes(status)) return { ok: false, reason: 'invalid_status' };
    const existing = await getServiceWithStops(scheduleId);
    if (!existing) return { ok: false, reason: 'not_found' };

    unwrap(await db().from('ferry_schedule').update({ status }).eq('schedule_id', scheduleId));

    await insertServiceLog({
        schedule_id: scheduleId,
        service_name_snapshot: existing.service_name,
        service_code_snapshot: existing.service_code,
        route_snapshot: existing.routeSnapshot,
        action: status === 'active' ? 'activated' : 'deactivated',
        actor_user_id: actorUserId,
        reason: reason || null,
    });

    return { ok: true };
}

/** Bulk activate/deactivate/archive - "archive" and "deactivate" both just set status='inactive' (nothing today distinguishes temporarily-off from retired); the log action records which button was actually clicked. */
export async function bulkSetServiceStatus({ scheduleIds, status, action, actorUserId, reason }) {
    let updatedCount = 0;
    for (const scheduleId of scheduleIds) {
        const result = await setFerryServiceStatus({ scheduleId, status, actorUserId, reason });
        if (result.ok) {
            updatedCount++;
            if (action === 'archived') {
                // setFerryServiceStatus already logged 'deactivated' - archive
                // additionally logs its own distinct action so the audit
                // trail can tell "paused" apart from "retired".
                const existing = await getServiceWithStops(scheduleId);
                await insertServiceLog({
                    schedule_id: scheduleId,
                    service_name_snapshot: existing.service_name,
                    service_code_snapshot: existing.service_code,
                    route_snapshot: existing.routeSnapshot,
                    action: 'archived',
                    actor_user_id: actorUserId,
                    reason: reason || null,
                });
            }
        }
    }
    return { updatedCount };
}

export async function duplicateFerryService({ scheduleId, newServiceName, newServiceCode, actorUserId }) {
    const existing = await getServiceWithStops(scheduleId);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (!newServiceName?.trim()) return { ok: false, reason: 'invalid_name' };
    if (!newServiceCode?.trim()) return { ok: false, reason: 'invalid_code' };

    const existingCode = unwrap(await db().from('ferry_schedule').select('schedule_id').eq('service_code', newServiceCode.trim()).limit(1));
    if (existingCode.length) return { ok: false, reason: 'duplicate_code' };

    const inserted = unwrap(
        await db()
            .from('ferry_schedule')
            .insert({
                route_id: null,
                departure_time: existing.departure_time,
                capacity: existing.capacity,
                weekdays: existing.weekdays,
                status: 'active',
                service_name: newServiceName.trim(),
                service_code: newServiceCode.trim(),
                effective_date: existing.effective_date,
                expiry_date: existing.expiry_date,
            })
            .select('*')
    );
    const newService = inserted[0];

    if (existing.stops.length) {
        unwrap(
            await db()
                .from('route_stops')
                .insert(
                    existing.stops.map((s) => ({
                        schedule_id: newService.schedule_id,
                        stop_order: s.stop_order,
                        stop_name: s.stop_name,
                        arrival_time: s.arrival_time,
                        departure_time: s.departure_time,
                        boarding_allowed: s.boarding_allowed,
                        dropoff_allowed: s.dropoff_allowed,
                        status: s.status,
                    }))
                )
        );
    }

    await insertServiceLog({
        schedule_id: newService.schedule_id,
        service_name_snapshot: newService.service_name,
        service_code_snapshot: newService.service_code,
        route_snapshot: existing.routeSnapshot,
        action: 'duplicated',
        actor_user_id: actorUserId,
        reason: `Duplicated from "${existing.service_name}" (${existing.service_code})`,
    });

    return { ok: true, service: newService };
}

export async function addRouteStop({ scheduleId, stopName, arrivalTime, departureTime, boardingAllowed, dropoffAllowed, actorUserId }) {
    const service = await getServiceWithStops(scheduleId);
    if (!service) return { ok: false, reason: 'not_found' };
    if (!stopName?.trim()) return { ok: false, reason: 'invalid_stop_name' };

    // The current last stop's departure_time being NULL means "End of
    // Route" - appending a new stop after it would silently leave that
    // invariant broken (a stop with no departure, halfway through the
    // route) and, worse, defeats validateStopChronology entirely (a
    // NULL previous-departure is treated as "nothing to compare
    // against", so an out-of-order new stop would sail through
    // unchecked). The admin must give the current last stop a real
    // departure time first - which naturally means it's no longer final.
    const currentLast = service.stops[service.stops.length - 1];
    if (currentLast && !currentLast.departure_time) {
        return {
            ok: false,
            reason: 'invalid_chronology',
            message: `"${currentLast.stop_name}" is currently the end of the route (no departure time). Set a departure time for it before adding a stop after it.`,
        };
    }

    const nextOrder = (service.stops[service.stops.length - 1]?.stop_order ?? 0) + 1;
    const candidateStops = [...service.stops, { stop_order: nextOrder, stop_name: stopName.trim(), arrival_time: arrivalTime || null, departure_time: departureTime || null }];
    const chronologyError = validateStopChronology(candidateStops);
    if (chronologyError) return { ok: false, reason: 'invalid_chronology', message: chronologyError };

    const inserted = unwrap(
        await db()
            .from('route_stops')
            .insert({
                schedule_id: scheduleId,
                stop_order: nextOrder,
                stop_name: stopName.trim(),
                arrival_time: arrivalTime || null,
                departure_time: departureTime || null,
                boarding_allowed: boardingAllowed !== false,
                dropoff_allowed: dropoffAllowed !== false,
            })
            .select('*')
    );
    const stop = inserted[0];

    await syncServiceDepartureTime(scheduleId);

    await insertServiceLog({
        schedule_id: scheduleId,
        service_name_snapshot: service.service_name,
        service_code_snapshot: service.service_code,
        route_snapshot: routeSnapshotFromStops(candidateStops),
        stop_id: stop.stop_id,
        stop_name_snapshot: stop.stop_name,
        new_arrival_time: stop.arrival_time,
        new_departure_time: stop.departure_time,
        action: 'stop_added',
        actor_user_id: actorUserId,
    });

    return { ok: true, stop };
}

export async function updateRouteStop({ stopId, stopName, arrivalTime, departureTime, boardingAllowed, dropoffAllowed, status, actorUserId, reason }) {
    const rows = unwrap(await db().from('route_stops').select('*').eq('stop_id', stopId).limit(1));
    const existingStop = rows[0];
    if (!existingStop) return { ok: false, reason: 'not_found' };
    const service = await getServiceWithStops(existingStop.schedule_id);

    const candidateStops = service.stops.map((s) =>
        s.stop_id === stopId
            ? { ...s, stop_name: stopName?.trim() || s.stop_name, arrival_time: arrivalTime ?? null, departure_time: departureTime ?? null }
            : s
    );

    // Same invariant as addRouteStop: a NULL departure_time means "End
    // of Route" and must only ever be true for the actual last stop -
    // otherwise a later stop's arrival has nothing to validate against.
    const isLastStop = existingStop.stop_order === service.stops[service.stops.length - 1].stop_order;
    if (!isLastStop && !departureTime) {
        return { ok: false, reason: 'invalid_chronology', message: `"${existingStop.stop_name}" is not the last stop on this route, so it must have a departure time.` };
    }

    const chronologyError = validateStopChronology(candidateStops);
    if (chronologyError) return { ok: false, reason: 'invalid_chronology', message: chronologyError };

    unwrap(
        await db()
            .from('route_stops')
            .update({
                stop_name: stopName?.trim() || existingStop.stop_name,
                arrival_time: arrivalTime ?? null,
                departure_time: departureTime ?? null,
                boarding_allowed: boardingAllowed !== false,
                dropoff_allowed: dropoffAllowed !== false,
                status: status && ['active', 'inactive'].includes(status) ? status : existingStop.status,
            })
            .eq('stop_id', stopId)
    );

    await syncServiceDepartureTime(existingStop.schedule_id);

    await insertServiceLog({
        schedule_id: existingStop.schedule_id,
        service_name_snapshot: service.service_name,
        service_code_snapshot: service.service_code,
        route_snapshot: routeSnapshotFromStops(candidateStops),
        stop_id: stopId,
        stop_name_snapshot: stopName?.trim() || existingStop.stop_name,
        previous_arrival_time: existingStop.arrival_time,
        new_arrival_time: arrivalTime ?? null,
        previous_departure_time: existingStop.departure_time,
        new_departure_time: departureTime ?? null,
        action: 'modified',
        actor_user_id: actorUserId,
        reason: reason || null,
    });

    return { ok: true };
}

export async function removeRouteStop({ stopId, actorUserId, reason }) {
    const rows = unwrap(await db().from('route_stops').select('*').eq('stop_id', stopId).limit(1));
    const stop = rows[0];
    if (!stop) return { ok: false, reason: 'not_found' };
    const service = await getServiceWithStops(stop.schedule_id);

    // Bookings don't reference stops yet (that lands in Phase 2 with
    // boarding_stop_id/destination_stop_id) - there is nothing to guard
    // against deleting a stop with active bookings until then.
    unwrap(await db().from('route_stops').delete().eq('stop_id', stopId));
    await renumberStops(stop.schedule_id);
    await syncServiceDepartureTime(stop.schedule_id);

    const remainingStops = (await loadStops(stop.schedule_id));
    await insertServiceLog({
        schedule_id: stop.schedule_id,
        service_name_snapshot: service.service_name,
        service_code_snapshot: service.service_code,
        route_snapshot: routeSnapshotFromStops(remainingStops),
        stop_id: stopId,
        stop_name_snapshot: stop.stop_name,
        previous_arrival_time: stop.arrival_time,
        previous_departure_time: stop.departure_time,
        action: 'stop_removed',
        actor_user_id: actorUserId,
        reason: reason || null,
    });

    return { ok: true };
}

/** Moves one stop up or down one position, then renumbers everything 1..N. */
export async function moveRouteStop({ stopId, direction, actorUserId }) {
    const rows = unwrap(await db().from('route_stops').select('*').eq('stop_id', stopId).limit(1));
    const stop = rows[0];
    if (!stop) return { ok: false, reason: 'not_found' };
    const stops = await loadStops(stop.schedule_id);
    const index = stops.findIndex((s) => s.stop_id === stopId);
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= stops.length) return { ok: false, reason: 'cannot_move' };

    const orderedIds = stops.map((s) => s.stop_id);
    [orderedIds[index], orderedIds[swapIndex]] = [orderedIds[swapIndex], orderedIds[index]];
    await renumberStops(stop.schedule_id, orderedIds);
    await syncServiceDepartureTime(stop.schedule_id);

    const service = await getServiceWithStops(stop.schedule_id);
    await insertServiceLog({
        schedule_id: stop.schedule_id,
        service_name_snapshot: service.service_name,
        service_code_snapshot: service.service_code,
        route_snapshot: service.routeSnapshot,
        stop_id: stopId,
        stop_name_snapshot: stop.stop_name,
        action: 'stop_reordered',
        actor_user_id: actorUserId,
    });

    return { ok: true };
}
