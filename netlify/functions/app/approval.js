// Port of the approval routing engine in includes/functions.php:
// find_manager_for_role(), is_manager_available(), route_booking_approval(),
// get_status_id(). Kept as plain Node (not a Postgres RPC) - there is no
// capacity-style race here (each booking only assigns its own approver),
// so this stays easy to diff against the original PHP.

import { db, unwrap } from './db.js';
import { createNotification } from './notifications.js';
import { ROLE_GM, ROLE_RM, ROLE_HR, APPROVAL_CHAIN } from './session.js';

const statusIdCache = new Map();
const roleIdCache = new Map();

export async function getStatusId(statusName) {
    if (statusIdCache.has(statusName)) return statusIdCache.get(statusName);
    const rows = unwrap(
        await db().from('booking_status').select('status_id').eq('status_name', statusName).limit(1)
    );
    const id = rows.length ? rows[0].status_id : null;
    statusIdCache.set(statusName, id);
    return id;
}

async function getRoleId(roleName) {
    if (roleIdCache.has(roleName)) return roleIdCache.get(roleName);
    const rows = unwrap(await db().from('roles').select('role_id').eq('role_name', roleName).limit(1));
    const id = rows.length ? rows[0].role_id : null;
    roleIdCache.set(roleName, id);
    return id;
}

/**
 * First active user of the given role, preferring one marked
 * 'available', falling back to the lowest user_id active user of that
 * role even if unavailable - exact port of the PHP SQL's
 * `ORDER BY (ma.status='available') DESC, u.user_id ASC LIMIT 1`.
 */
export async function findManagerForRole(roleName) {
    const roleId = await getRoleId(roleName);
    if (!roleId) return null;

    const users = unwrap(
        await db()
            .from('users')
            .select('user_id, full_name')
            .eq('role_id', roleId)
            .eq('status', 'active')
            .order('user_id', { ascending: true })
    );
    if (!users.length) return null;

    const availabilityRows = unwrap(
        await db()
            .from('manager_availability')
            .select('user_id, status')
            .in('user_id', users.map((u) => u.user_id))
    );
    const availabilityByUser = new Map(availabilityRows.map((a) => [a.user_id, a.status]));

    const available = users.find((u) => availabilityByUser.get(u.user_id) === 'available');
    return available || users[0];
}

/** No row in manager_availability means never explicitly marked unavailable -> treat as available. */
export async function isManagerAvailable(userId) {
    const rows = unwrap(
        await db().from('manager_availability').select('status').eq('user_id', userId).limit(1)
    );
    if (!rows.length) return true;
    return rows[0].status === 'available';
}

const STATUS_BY_ROLE = {
    [ROLE_GM]: 'Waiting GM Approval',
    [ROLE_RM]: 'Waiting RM Approval',
    [ROLE_HR]: 'Waiting HR Approval',
};

/**
 * Routes a booking to the next approver: GM -> RM -> HR, picking the
 * first role in the chain with an available manager. Falls back to HR
 * Manager (available or not) if nobody in the chain is available, so a
 * booking is never left with no one responsible for it.
 */
export async function routeBookingApproval(bookingId) {
    let chosenRole = null;
    let manager = null;

    for (const roleName of APPROVAL_CHAIN) {
        const candidate = await findManagerForRole(roleName);
        if (candidate && (await isManagerAvailable(candidate.user_id))) {
            chosenRole = roleName;
            manager = candidate;
            break;
        }
    }

    if (!manager) {
        chosenRole = ROLE_HR;
        manager = await findManagerForRole(ROLE_HR);
    }

    const statusName = STATUS_BY_ROLE[chosenRole] ?? 'Waiting HR Approval';
    const statusId = await getStatusId(statusName);
    const approverId = manager?.user_id ?? null;

    unwrap(
        await db()
            .from('bookings')
            .update({ status_id: statusId, current_approver_id: approverId })
            .eq('booking_id', bookingId)
    );

    if (approverId) {
        await createNotification(
            approverId,
            'A new ferry booking request is waiting for your approval.',
            'booking',
            bookingId
        );
    }

    return { status_id: statusId, approver_id: approverId, role: chosenRole };
}
