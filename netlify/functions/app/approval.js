// Port of the approval routing engine in includes/functions.php:
// find_manager_for_role(), is_manager_available(), route_booking_approval(),
// get_status_id(). Kept as plain Node (not a Postgres RPC) - there is no
// capacity-style race here (each booking only assigns its own approver),
// so this stays easy to diff against the original PHP.

import { db, unwrap, eqOrNull } from './db.js';
import { createNotification } from './notifications.js';
import { ROLE_GM, ROLE_RM, ROLE_HR, APPROVAL_CHAIN } from './session.js';

const EXECUTIVE_ROLES = [ROLE_GM, ROLE_RM, ROLE_HR];

// ---------------------------------------------------------------------
// Department-based approval hierarchy (coexists with the legacy chain
// above - a department only uses this once explicitly opted in via
// department_approval_config.approval_mode). See supabase/migrations/
// 0004_department_approval.sql and the project's plan doc for the full
// design rationale.
// ---------------------------------------------------------------------

/** Ordered department hierarchy: level label, its config-table column, and its booking_status name. */
const DEPARTMENT_LEVELS = [
    { level: 'Department Manager', configColumn: 'manager_user_id', statusName: 'Pending Department Manager Approval' },
    { level: 'Assistant Manager', configColumn: 'assistant_manager_user_id', statusName: 'Pending Assistant Manager Approval' },
    { level: 'Supervisor', configColumn: 'supervisor_user_id', statusName: 'Pending Supervisor Approval' },
];
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
            .update({ status_id: statusId, current_approver_id: approverId, current_approval_assigned_at: new Date().toISOString() })
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

/** Fetches a resort+department's approval config row, or null if none exists (or either id is null/undefined). */
export async function getDepartmentApprovalConfig(resortId, departmentId) {
    if (!resortId || !departmentId) return null;
    const rows = unwrap(
        await db()
            .from('department_approval_config')
            .select('*')
            .eq('resort_id', resortId)
            .eq('department_id', departmentId)
            .limit(1)
    );
    return rows[0] ?? null;
}

/**
 * A candidate approver is viable only if their account is active AND
 * they're not marked unavailable/on-leave/out-of-office. This is
 * stricter than the legacy isManagerAvailable() alone, which never
 * checked account status - the spec explicitly lists "inactive
 * account" and "disabled by administrator" as their own escalation
 * triggers, distinct from availability.
 */
async function isApproverViable(userId) {
    const rows = unwrap(await db().from('users').select('status').eq('user_id', userId).limit(1));
    if (!rows.length || rows[0].status !== 'active') return false;
    return isManagerAvailable(userId);
}

/**
 * Notifies every active user holding an executive role (GM, RM, or HR)
 * that a booking needs their attention - used when a department-
 * hierarchy booking has no viable departmental approver at any tier and
 * lands in an unassigned "awaiting executive override" state, so
 * executives learn about it proactively rather than only via polling
 * the Executive Overview page. Mirrors the "notify all Transport
 * Coordinators on approval" pattern in routes/manager.js.
 */
async function notifyExecutives(bookingId, message) {
    const executives = unwrap(
        await db()
            .from('users')
            .select('user_id, roles!inner(role_name)')
            .eq('status', 'active')
            .in('roles.role_name', EXECUTIVE_ROLES)
    );
    for (const exec of executives) {
        await createNotification(exec.user_id, message, 'booking', bookingId);
    }
}

/**
 * Returns the data needed to describe a booker's approval workflow to
 * them, dynamically - never hardcoded text. `mode` is 'department_hierarchy'
 * or 'legacy'; `executives` is every currently active GM/RM/HR user,
 * ordered to reflect the legacy chain's priority (GM, then RM, then HR),
 * for display in either mode.
 */
export async function getApprovalWorkflowInfo(resortId, departmentId) {
    const config = await getDepartmentApprovalConfig(resortId, departmentId);
    const rolePriority = EXECUTIVE_ROLES;

    const rows = unwrap(
        await db()
            .from('users')
            .select('full_name, roles!inner(role_name)')
            .eq('status', 'active')
            .in('roles.role_name', rolePriority)
    );
    const executives = rows
        .map((u) => ({ fullName: u.full_name, roleName: u.roles.role_name }))
        .sort((a, b) => rolePriority.indexOf(a.roleName) - rolePriority.indexOf(b.roleName));

    const mode = config && config.approval_mode === 'department_hierarchy' ? 'department_hierarchy' : 'legacy';
    return { mode, executives };
}

/**
 * Routes a booking through its department's 3-tier hierarchy (Department
 * Manager -> Assistant Manager -> Supervisor), OR delegates unchanged to
 * the legacy routeBookingApproval() whenever department-hierarchy mode
 * isn't active for this booking - a null config row (department has no
 * config, or departmentId itself is null) is treated identically to an
 * explicit 'legacy' mode, so this is safe even if a department is ever
 * added without a matching department_approval_config row (the pre-seed
 * in the migration is a convenience for the admin UI, not something
 * this function trusts).
 *
 * If no departmental tier has a viable approver, the booking is left
 * pending/unassigned (current_approver_id = null) rather than
 * auto-escalating to HR - only an executive override (GM/RM/HR acting
 * via the Executive Overview page) can act on it from there.
 */
export async function routeDepartmentApproval(bookingId, resortId, departmentId) {
    const config = await getDepartmentApprovalConfig(resortId, departmentId);
    if (!config || config.approval_mode !== 'department_hierarchy') {
        return routeBookingApproval(bookingId);
    }

    let chosenLevel = null;
    let approverId = null;

    for (const { level, configColumn } of DEPARTMENT_LEVELS) {
        const candidateId = config[configColumn];
        if (candidateId && (await isApproverViable(candidateId))) {
            chosenLevel = level;
            approverId = candidateId;
            break;
        }
    }

    let statusName;
    let noDepartmentApproverAvailable = false;
    if (approverId) {
        statusName = DEPARTMENT_LEVELS.find((l) => l.level === chosenLevel).statusName;
    } else {
        // No viable tier at all - stays pending/unassigned rather than
        // auto-escalating to HR. The first tier's status is the natural
        // entry point since nothing was ever actually assigned.
        chosenLevel = null;
        statusName = DEPARTMENT_LEVELS[0].statusName;
        approverId = null;
        noDepartmentApproverAvailable = true;
    }

    const statusId = await getStatusId(statusName);

    unwrap(
        await db()
            .from('bookings')
            .update({ status_id: statusId, current_approver_id: approverId, current_approval_assigned_at: new Date().toISOString() })
            .eq('booking_id', bookingId)
    );

    if (approverId) {
        await createNotification(approverId, `A new ferry booking request is waiting for your approval as ${chosenLevel}.`, 'booking', bookingId);
    } else if (noDepartmentApproverAvailable) {
        await notifyExecutives(
            bookingId,
            'A new ferry booking request has no available department approver and needs an executive override.'
        );
    }

    return { status_id: statusId, approver_id: approverId, level: chosenLevel };
}

/**
 * Advances a booking to the next level in [Department Manager,
 * Assistant Manager, Supervisor, HR] after its current level, or does
 * nothing if already at HR (the terminal level). Used by the SLA
 * escalation Scheduled Function and by manual verification.
 *
 * Uses the same compare-and-swap pattern as the human approve/reject
 * handler in routes/manager.js: the UPDATE is conditioned on the exact
 * status_id/current_approver_id the caller read when it selected this
 * booking as an escalation candidate. If a human (or another escalation
 * pass) already changed the booking in the meantime, the CAS affects 0
 * rows and this returns { escalated: false, reason: 'conflict' } rather
 * than blindly overwriting a decision that already happened - this is
 * not optional hardening, it closes a real silent-data-corruption path
 * (see the project's plan doc, "Corrections from validation" #2).
 *
 * `booking` must have: booking_id, status_id, current_approver_id,
 * department_id, resort_id (the resort+department that is actually
 * routing this booking - the same resort's config must be used, since
 * each resort now has a fully independent hierarchy for the same
 * department).
 */
export async function escalateApproval(booking, reason) {
    const config = await getDepartmentApprovalConfig(booking.resort_id, booking.department_id);
    if (!config) return { escalated: false, reason: 'no_config' };

    const statusRows = unwrap(
        await db().from('booking_status').select('status_name').eq('status_id', booking.status_id).limit(1)
    );
    const currentStatusName = statusRows[0]?.status_name;

    const currentLevelIndex = DEPARTMENT_LEVELS.findIndex((l) => l.statusName === currentStatusName);
    if (currentLevelIndex === -1) {
        // Already at HR (terminal) or not a department-hierarchy status at all - nothing further to escalate to.
        return { escalated: false, reason: 'terminal_level' };
    }
    const departingLevel = DEPARTMENT_LEVELS[currentLevelIndex].level;

    let nextLevel = null;
    let nextApproverId = null;
    for (const { level, configColumn } of DEPARTMENT_LEVELS.slice(currentLevelIndex + 1)) {
        const candidateId = config[configColumn];
        if (candidateId && (await isApproverViable(candidateId))) {
            nextLevel = level;
            nextApproverId = candidateId;
            break;
        }
    }

    // No further viable tier - stays pending/unassigned rather than
    // auto-escalating to HR. Keep the CURRENT status name unchanged: the
    // booking doesn't "become" a level it never reached, it just loses
    // its assignee.
    const noFurtherTierAvailable = !nextApproverId;
    const nextStatusName = noFurtherTierAvailable ? currentStatusName : DEPARTMENT_LEVELS.find((l) => l.level === nextLevel).statusName;
    const nextStatusId = await getStatusId(nextStatusName);
    if (noFurtherTierAvailable) {
        nextLevel = null;
        nextApproverId = null;
    }

    // A booking already sitting unassigned (current_approver_id null,
    // possible if find_sla_overdue_bookings() re-selects it on a later
    // run) needs an IS NULL check, not .eq(col, null) - see eqOrNull().
    const query = eqOrNull(
        db()
            .from('bookings')
            .update({
                status_id: nextStatusId,
                current_approver_id: nextApproverId,
                current_approval_assigned_at: new Date().toISOString(),
            })
            .eq('booking_id', booking.booking_id)
            .eq('status_id', booking.status_id),
        'current_approver_id',
        booking.current_approver_id
    );

    const { data: updatedRows, error } = await query.select('booking_id');
    if (error) throw new Error(error.message);

    if (!updatedRows.length) {
        // Someone already acted on this booking since it was selected as an escalation candidate - skip, don't overwrite.
        return { escalated: false, reason: 'conflict' };
    }

    unwrap(
        await db().from('booking_approvals').insert({
            booking_id: booking.booking_id,
            approver_id: booking.current_approver_id, // the departing approver - see file header comment on this convention
            role_at_approval: 'System (Auto-Escalation)',
            action: 'escalated',
            approval_level: departingLevel,
            department_id: booking.department_id,
            resort_id: booking.resort_id,
            original_approver_id: booking.current_approver_id,
            escalated_to_approver_id: nextApproverId,
            escalation_reason: noFurtherTierAvailable ? `${reason} (no further department approver available)` : reason,
        })
    );

    if (nextApproverId) {
        await createNotification(
            nextApproverId,
            `A ferry booking request has been escalated to you (${nextLevel} level) for approval.`,
            'booking',
            booking.booking_id
        );
    } else if (noFurtherTierAvailable) {
        await notifyExecutives(
            booking.booking_id,
            'A ferry booking request has no available department approver and needs an executive override.'
        );
    }

    return { escalated: true, level: nextLevel, approver_id: nextApproverId };
}
