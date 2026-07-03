// Thin wrappers around the Postgres RPCs in
// supabase/migrations/0003_functions.sql. book_ferry_seat is the
// capacity-safe booking insert (row-locked, race-safe); get_remaining_seats
// is the read-only single source of truth for the same exclusion logic,
// used for the live seat-availability UI.

import { db, unwrap } from './db.js';

export async function getRemainingSeats(scheduleId, travelDate) {
    const rows = unwrap(
        await db().rpc('get_remaining_seats', {
            p_schedule_id: scheduleId,
            p_travel_date: travelDate,
        })
    );
    return rows[0] ?? { capacity: 0, booked: 0, remaining: 0 };
}

/**
 * Throws an Error with message 'CAPACITY_EXCEEDED' or
 * 'SCHEDULE_NOT_FOUND' (matching the RPC's RAISE EXCEPTION) if the
 * booking can't be placed; otherwise returns the inserted booking row.
 */
export async function bookFerrySeat({ userId, scheduleId, travelDate, direction, purpose, remarks, seats }) {
    const { data, error } = await db().rpc('book_ferry_seat', {
        p_user_id: userId,
        p_schedule_id: scheduleId,
        p_travel_date: travelDate,
        p_direction: direction,
        p_purpose: purpose,
        p_remarks: remarks,
        p_seats: seats,
    });
    if (error) {
        // Postgres RAISE EXCEPTION messages surface in error.message.
        if (error.message?.includes('CAPACITY_EXCEEDED')) throw new Error('CAPACITY_EXCEEDED');
        if (error.message?.includes('SCHEDULE_NOT_FOUND')) throw new Error('SCHEDULE_NOT_FOUND');
        throw new Error(error.message);
    }
    return Array.isArray(data) ? data[0] : data;
}
