// Port of the approval routing engine in includes/functions.php:
// find_manager_for_role(), is_manager_available(), route_booking_approval(),
// get_status_id(). Kept as plain Node (not a Postgres RPC) - there is no
// capacity-style race here (each booking only assigns its own approver),
// so this stays easy to diff against the original PHP.

import crypto from 'node:crypto';
import { db, unwrap, eqOrNull } from './db.js';
import { createNotification } from './notifications.js';
import { ROLE_GM, ROLE_RM, ROLE_HR, APPROVAL_CHAIN } from './session.js';
import { sendTemplatedEmail } from './mailer.js';
import { deferBestEffort } from './deferred.js';
import { getSetting } from './settings.js';
import { formatDate, formatTime, formatDateTime } from './format.js';
import { logActivity } from './activity.js';

/** Maps a booking's "waiting/pending" status_name to a human hierarchy-level label for the audit trail - shared by every approve/reject entry point (the authenticated /manager/approvals list and the token-gated /approval page alike). */
const LEVEL_BY_STATUS_NAME = {
    'Waiting GM Approval': 'General Manager',
    'Waiting RM Approval': 'Resident Manager',
    'Waiting HR Approval': 'HR Manager',
    'Pending Department Manager Approval': 'Primary Approver (In Charge / Head of Department)',
    'Pending Assistant Manager Approval': 'Secondary Approver (Assistant In Charge / Assistant Manager)',
    'Pending HR Approval': 'HR',
};

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
    { level: 'Primary Approver (In Charge / Head of Department)', configColumn: 'manager_user_id', statusName: 'Pending Department Manager Approval' },
    { level: 'Secondary Approver (Assistant In Charge / Assistant Manager)', configColumn: 'assistant_manager_user_id', statusName: 'Pending Assistant Manager Approval' },
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

/** A fresh token per (re-)assignment - see 0038_email_action_links.sql's header comment for why this is its own table rather than columns on bookings. */
async function mintApprovalToken(bookingId, approverUserId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiryHours = Number(await getSetting('approval_token_expiry_hours', '72')) || 72;
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();
    unwrap(await db().from('booking_approval_tokens').insert({ token, booking_id: bookingId, approver_user_id: approverUserId, expires_at: expiresAt }));
    return token;
}

/**
 * The "please approve this booking" email - genuinely new (there was
 * previously only the in-app createNotification() at each of this
 * file's 3 assignment points). Mints a fresh approval token and sends
 * via the approval_request template (email_action_links migration),
 * whose View Request/Approve/Reject buttons all land on the token-
 * gated /approval page (routes/approval_link.js) - never a raw
 * GET-triggers-the-decision link, see that route's own header comment.
 */
/**
 * Shared by sendApprovalRequestEmail() (assigned approver),
 * notifyExecutives() (unassigned, executive-override case), and
 * sendApprovalReminders() (reminder/escalation) - the full booking-
 * detail field set the HOD Email Approval spec's "Email Notification"
 * section asks for. Boarding Location/Destination come from route_stops
 * (first/last active stop for the schedule) - the same source
 * seatAvailability.js already uses for equivalent fields elsewhere, not
 * a new data source.
 */
async function getBookingEmailVariables(bookingId) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select(
                'travel_date, seats, purpose, created_at, schedule_id, ' +
                    'users!bookings_user_id_fkey(full_name, employee_id, designation, departments(department_name), resorts(resort_name)), ' +
                    'ferry_schedule(departure_time, service_name, ferry_routes(route_name, direction))'
            )
            .eq('booking_id', bookingId)
            .limit(1)
    );
    const booking = rows[0];
    if (!booking) return null;

    const stopRows = booking.schedule_id
        ? unwrap(await db().from('route_stops').select('stop_name').eq('schedule_id', booking.schedule_id).eq('status', 'active').order('stop_order', { ascending: true }))
        : [];

    return {
        full_name: booking.users?.full_name ?? '',
        employee_id: booking.users?.employee_id ?? '',
        designation: booking.users?.designation ?? '',
        department_name: booking.users?.departments?.department_name ?? '',
        resort_name: booking.users?.resorts?.resort_name ?? '',
        route_name: booking.ferry_schedule?.service_name ?? booking.ferry_schedule?.ferry_routes?.route_name ?? '',
        direction: booking.ferry_schedule?.service_name ?? booking.ferry_schedule?.ferry_routes?.direction ?? '',
        travel_date: formatDate(booking.travel_date),
        departure_time: booking.ferry_schedule ? formatTime(booking.ferry_schedule.departure_time) : '',
        boarding_location: stopRows[0]?.stop_name ?? '',
        destination: stopRows[stopRows.length - 1]?.stop_name ?? '',
        seats: booking.seats,
        purpose: booking.purpose ?? '',
        booking_reference: `BK-${bookingId}`,
        submitted_at: formatDateTime(booking.created_at),
    };
}

async function sendApprovalRequestEmail(bookingId, approverId) {
    const [bookingVars, approverRows] = await Promise.all([
        getBookingEmailVariables(bookingId),
        db().from('users').select('full_name, email').eq('user_id', approverId).limit(1).then(unwrap),
    ]);
    const approver = approverRows[0];
    if (!bookingVars || !approver?.email) return;

    const token = await mintApprovalToken(bookingId, approverId);
    deferBestEffort(
        sendTemplatedEmail(
            'approval_request',
            approver.email,
            { approver_name: approver.full_name ?? '', ...bookingVars, booking_id: bookingId, approvalToken: token },
            { relatedBookingId: bookingId }
        ),
        'sendTemplatedEmail:approval_request'
    );
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
        await sendApprovalRequestEmail(bookingId, approverId);
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
    const [executives, bookingVars] = await Promise.all([
        db()
            .from('users')
            .select('user_id, full_name, email, roles!inner(role_name)')
            .eq('status', 'active')
            .in('roles.role_name', EXECUTIVE_ROLES)
            .then(unwrap),
        getBookingEmailVariables(bookingId),
    ]);
    for (const exec of executives) {
        await createNotification(exec.user_id, message, 'booking', bookingId);
        // No single approver to bind an approval token to here (that's
        // exactly why this booking landed in the executive-override
        // bucket) - the email links to the Executive Overview page
        // instead, which already gates itself on
        // approval_workflow.executive_override. See mailer.js's
        // EMAIL_ACTIONS.approval_request for the token-vs-no-token branch.
        if (exec.email && bookingVars) {
            deferBestEffort(
                sendTemplatedEmail(
                    'approval_request',
                    exec.email,
                    { approver_name: exec.full_name ?? '', ...bookingVars, booking_id: bookingId },
                    { relatedBookingId: bookingId }
                ),
                'sendTemplatedEmail:approval_request'
            );
        }
    }
}

/**
 * Returns the data needed to describe a booker's approval workflow to
 * them, dynamically - never hardcoded text. `mode` is 'department_hierarchy'
 * or 'legacy'; `executives` is every currently active GM/RM/HR user,
 * ordered to reflect the legacy chain's priority (GM, then RM, then HR),
 * for display in either mode.
 *
 * Department Hierarchy is the default: only an EXPLICIT 'legacy' config
 * row opts a department back into the old GM -> RM -> HR chain. A
 * missing config row (a department added without one, or departmentId
 * itself null) must never silently behave like legacy - that would
 * make every newly-added department default back to the org-wide chain
 * the business no longer wants as the normal path.
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

    const mode = config?.approval_mode === 'legacy' ? 'legacy' : 'department_hierarchy';
    return { mode, executives };
}

/**
 * Routes a booking through its department's 2-tier hierarchy (Primary
 * Approver -> Secondary Approver) - the default path - or
 * delegates to the legacy routeBookingApproval() (GM -> RM -> HR) only
 * when the department has an EXPLICIT 'legacy' config row. A missing
 * config row (department added without one, or departmentId itself
 * null) is treated as an unconfigured department-hierarchy department,
 * not legacy: it flows into the "no viable tier" branch below and stays
 * pending/unassigned pending an executive override, exactly like a
 * department_hierarchy department whose tiers haven't been assigned
 * yet. This keeps "department hierarchy, GM/RM/HR only as an override"
 * the real default for every department, present and future.
 *
 * If no departmental tier has a viable approver, the booking is left
 * pending/unassigned (current_approver_id = null) rather than
 * auto-escalating to HR - only an executive override (GM/RM/HR acting
 * via the Executive Overview page) can act on it from there.
 */
/**
 * Routes via the employee's actual reporting_manager_id, tried before
 * department_approval_config (routeDepartmentApproval, below) - a real,
 * per-person signal that's already populated in production for genuine
 * HODs, unlike the department-wide config table which several
 * departments have never had set up (the root cause of the GM's missing
 * approval emails - see migration 0039's header comment). Returns
 * `null` when there's nothing to route on (no reporting_manager_id set,
 * or the manager isn't currently viable) so the caller falls through to
 * the existing department_approval_config logic unchanged.
 */
async function routeViaReportingManager(bookingId, employeeUserId) {
    if (!employeeUserId) return null;
    const rows = unwrap(await db().from('users').select('reporting_manager_id').eq('user_id', employeeUserId).limit(1));
    const managerId = rows[0]?.reporting_manager_id;
    if (!managerId || !(await isApproverViable(managerId))) return null;

    const statusId = await getStatusId('Pending HOD Approval');
    unwrap(
        await db()
            .from('bookings')
            .update({
                status_id: statusId,
                current_approver_id: managerId,
                current_approval_assigned_at: new Date().toISOString(),
                reminder_sent_at: null,
                hod_escalated_at: null,
            })
            .eq('booking_id', bookingId)
    );

    await createNotification(managerId, 'A new ferry booking request is waiting for your approval.', 'booking', bookingId);
    await sendApprovalRequestEmail(bookingId, managerId);

    return { status_id: statusId, approver_id: managerId, level: 'Reporting Manager' };
}

export async function routeDepartmentApproval(bookingId, resortId, departmentId, employeeUserId) {
    const viaReportingManager = await routeViaReportingManager(bookingId, employeeUserId);
    if (viaReportingManager) return viaReportingManager;

    const config = await getDepartmentApprovalConfig(resortId, departmentId);
    if (config?.approval_mode === 'legacy') {
        return routeBookingApproval(bookingId);
    }

    let chosenLevel = null;
    let approverId = null;

    for (const { level, configColumn } of DEPARTMENT_LEVELS) {
        const candidateId = config?.[configColumn];
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
        await sendApprovalRequestEmail(bookingId, approverId);
    } else if (noDepartmentApproverAvailable) {
        await notifyExecutives(
            bookingId,
            'A new ferry booking request has no available department approver and needs an executive override.'
        );
    }

    return { status_id: statusId, approver_id: approverId, level: chosenLevel };
}

/**
 * Advances a booking to the next level in [Primary Approver, Secondary
 * Approver] after its current level, or does nothing if already at the
 * terminal level (falls to executive override, not HR - see
 * routeDepartmentApproval's header comment). Used by the SLA
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
        await sendApprovalRequestEmail(booking.booking_id, nextApproverId);
    } else if (noFurtherTierAvailable) {
        await notifyExecutives(
            booking.booking_id,
            'A ferry booking request has no available department approver and needs an executive override.'
        );
    }

    return { escalated: true, level: nextLevel, approver_id: nextApproverId };
}

/**
 * The single approve/reject decision path - originally inline in
 * routes/manager.js's POST /manager/approvals handler, extracted so the
 * new token-gated /approval page (routes/approval_link.js) produces
 * IDENTICAL behavior (status transition, audit row, booker notification
 * + email, Transport Coordinator notification on approval, activity
 * log) regardless of which page the approver actually used. Returns
 * `{ ok: false, reason: 'not_assigned' }` if the booking isn't
 * currently assigned to actorUserId, or `{ ok: false, reason: 'conflict' }`
 * if someone else already acted on it between the caller's read and this
 * call (the same compare-and-swap guard escalateApproval() uses).
 */
export async function applyApprovalDecision({ bookingId, actorUserId, actorRoleName, actorFullName, decision, comments, clientIp }) {
    const bookingRows = unwrap(
        await db()
            .from('bookings')
            .select(
                'user_id, current_approver_id, status_id, travel_date, booking_status(status_name), ' +
                    'users!bookings_user_id_fkey(department_id, resort_id, full_name, email), ' +
                    'ferry_schedule(departure_time, service_name, ferry_routes(route_name, direction))'
            )
            .eq('booking_id', bookingId)
            .limit(1)
    );
    const booking = bookingRows[0];
    if (!booking || booking.current_approver_id !== actorUserId) {
        return { ok: false, reason: 'not_assigned' };
    }

    const newStatusRows = unwrap(
        await db().from('booking_status').select('status_id, status_name').eq('status_name', decision === 'approved' ? 'Approved' : 'Rejected').limit(1)
    );
    const newStatus = newStatusRows[0];

    // Conditional compare-and-swap: only updates if the booking is still in
    // the exact state read above, guarding against a double-click (or the
    // list page and this token page racing) producing two decisions.
    const { data: updatedRows, error: updateError } = await db()
        .from('bookings')
        .update({ status_id: newStatus.status_id })
        .eq('booking_id', bookingId)
        .eq('current_approver_id', actorUserId)
        .eq('status_id', booking.status_id)
        .select('booking_id');
    if (updateError) throw new Error(updateError.message);

    if (!updatedRows.length) {
        return { ok: false, reason: 'conflict' };
    }

    const approvalLevel = LEVEL_BY_STATUS_NAME[booking.booking_status?.status_name] ?? null;
    unwrap(
        await db().from('booking_approvals').insert({
            booking_id: bookingId,
            approver_id: actorUserId,
            role_at_approval: actorRoleName,
            action: decision,
            comments: comments || null,
            approval_level: approvalLevel,
            department_id: booking.users?.department_id ?? null,
            resort_id: booking.users?.resort_id ?? null,
        })
    );

    const message =
        decision === 'approved'
            ? `Your ferry booking has been approved by ${actorFullName}.`
            : `Your ferry booking has been rejected by ${actorFullName}${comments ? ' - ' + comments : ''}.`;
    await createNotification(booking.user_id, message, 'booking', bookingId);
    deferBestEffort(
        sendTemplatedEmail(
            decision === 'approved' ? 'booking_approval' : 'booking_rejection',
            booking.users?.email,
            {
                full_name: booking.users?.full_name ?? '',
                route_name: booking.ferry_schedule?.service_name ?? booking.ferry_schedule?.ferry_routes?.route_name ?? '',
                direction: booking.ferry_schedule?.service_name ?? booking.ferry_schedule?.ferry_routes?.direction ?? '',
                travel_date: formatDate(booking.travel_date),
                departure_time: booking.ferry_schedule ? formatTime(booking.ferry_schedule.departure_time) : '',
                booking_id: bookingId,
                reason: comments || '',
            },
            { relatedBookingId: bookingId }
        ),
        `sendTemplatedEmail:booking_${decision}`
    );

    if (decision === 'approved') {
        const coordinators = unwrap(
            await db()
                .from('users')
                .select('user_id, roles!inner(role_name)')
                .eq('status', 'active')
                .eq('roles.role_name', 'Transport Coordinator')
        );
        for (const tc of coordinators) {
            await createNotification(tc.user_id, 'A new ferry booking has been approved and is ready for the passenger manifest.', 'booking', bookingId);
        }
    }

    await logActivity(actorUserId, `${decision.charAt(0).toUpperCase()}${decision.slice(1)} booking`, `booking_id=${bookingId}`, clientIp);

    return { ok: true };
}

/**
 * Two-stage timeout handling for 'Pending HOD Approval' bookings - a
 * reminder to the current approver first, then (if still no action) an
 * additional heads-up to GM/RM/HR executives via the existing
 * notifyExecutives(), without reassigning current_approver_id (mirrors
 * escalateApproval()'s "no further tier - notify, don't reassign"
 * behavior - the HOD's own assignment/token stays valid either way).
 * Called from api/cron/escalate-approvals.js alongside its existing
 * SLA-escalation sweep - same 15-minute poll, no new cron cadence.
 */
export async function sendApprovalReminders() {
    const reminderHours = Number(await getSetting('approval_reminder_hours', '24')) || 24;
    const escalationHours = Number(await getSetting('approval_escalation_hours', '48')) || 48;
    const results = { reminded: 0, escalated: 0 };

    const hodStatusId = await getStatusId('Pending HOD Approval');
    if (!hodStatusId) return results;

    const reminderCutoff = new Date(Date.now() - reminderHours * 60 * 60 * 1000).toISOString();
    const reminderCandidates = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, current_approver_id')
            .eq('status_id', hodStatusId)
            .is('reminder_sent_at', null)
            .lt('current_approval_assigned_at', reminderCutoff)
    );
    for (const booking of reminderCandidates) {
        if (booking.current_approver_id) {
            const [bookingVars, approverRows] = await Promise.all([
                getBookingEmailVariables(booking.booking_id),
                db().from('users').select('full_name, email').eq('user_id', booking.current_approver_id).limit(1).then(unwrap),
            ]);
            const approver = approverRows[0];
            if (bookingVars && approver?.email) {
                const validTokenRows = unwrap(
                    await db()
                        .from('booking_approval_tokens')
                        .select('token')
                        .eq('booking_id', booking.booking_id)
                        .eq('approver_user_id', booking.current_approver_id)
                        .gt('expires_at', new Date().toISOString())
                        .order('token_id', { ascending: false })
                        .limit(1)
                );
                const token = validTokenRows[0]?.token ?? (await mintApprovalToken(booking.booking_id, booking.current_approver_id));
                deferBestEffort(
                    sendTemplatedEmail(
                        'approval_reminder',
                        approver.email,
                        { approver_name: approver.full_name ?? '', ...bookingVars, booking_id: booking.booking_id, approvalToken: token },
                        { relatedBookingId: booking.booking_id }
                    ),
                    'sendTemplatedEmail:approval_reminder'
                );
            }
        }
        unwrap(await db().from('bookings').update({ reminder_sent_at: new Date().toISOString() }).eq('booking_id', booking.booking_id));
        results.reminded++;
    }

    const escalationCutoff = new Date(Date.now() - escalationHours * 60 * 60 * 1000).toISOString();
    const escalationCandidates = unwrap(
        await db()
            .from('bookings')
            .select('booking_id')
            .eq('status_id', hodStatusId)
            .not('reminder_sent_at', 'is', null)
            .is('hod_escalated_at', null)
            .lt('current_approval_assigned_at', escalationCutoff)
    );
    for (const booking of escalationCandidates) {
        await notifyExecutives(booking.booking_id, 'A ferry booking request has been pending HOD approval past the escalation timeout and needs attention.');
        unwrap(await db().from('bookings').update({ hod_escalated_at: new Date().toISOString() }).eq('booking_id', booking.booking_id));
        results.escalated++;
    }

    return results;
}
