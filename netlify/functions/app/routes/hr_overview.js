// Executive Overview page: view every pending request org-wide
// (regardless of who it's currently assigned to or which department
// it's from), and approve/reject/reassign/return any of them. Available
// to every executive role (General Manager, Resident Manager, HR
// Manager, Admin) - authority is not restricted by department and is
// not limited to department-hierarchy-mode departments: a legacy
// Waiting-GM-Approval booking is just as actionable here as a
// department-hierarchy Pending-Assistant-Manager-Approval one, or a booking
// left unassigned because no department approver was available. URL
// stays /hr/overview for backward compatibility with existing links.

import { db, unwrap, eqOrNull } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getDepartmentApprovalConfig, getStatusId } from '../approval.js';
import { createNotification } from '../notifications.js';
import { sendTemplatedEmail } from '../mailer.js';
import { deferBestEffort } from '../deferred.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDate, formatDateTime, formatTime, statusBadgeClass } from '../format.js';

/** Same level-label mapping used in manager.js's audit trail - duplicated here
 *  deliberately (small, static lookup) rather than importing across route
 *  files, matching this codebase's existing per-route-file style. */
const LEVEL_BY_STATUS_NAME = {
    'Waiting GM Approval': 'General Manager',
    'Waiting RM Approval': 'Resident Manager',
    'Waiting HR Approval': 'HR Manager',
    'Pending Department Manager Approval': 'Primary Approver (In Charge / Head of Department)',
    'Pending Assistant Manager Approval': 'Secondary Approver (Assistant In Charge / Assistant Manager)',
    'Pending HR Approval': 'HR',
};

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

async function overviewPageBody(csrfToken) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select(
                'booking_id, travel_date, direction, purpose, remarks, seats, current_approver_id, users!bookings_user_id_fkey(full_name, employee_id, department_id, resort_id, departments(department_name), resorts(resort_name)), ferry_schedule(departure_time), booking_status!inner(status_name, badge_color), approver:current_approver_id(full_name)'
            )
            .or('status_name.like.Waiting%,status_name.like.Pending%', { foreignTable: 'booking_status' })
            .order('travel_date', { ascending: true })
    );

    const activeUsers = unwrap(await db().from('users').select('user_id, full_name, employee_id').eq('status', 'active').order('full_name'));
    const userOptions = activeUsers.map((u) => `<option value="${u.user_id}">${h(u.full_name)} (${h(u.employee_id)})</option>`).join('');

    const cards = rows
        .map((r) => {
            const level = LEVEL_BY_STATUS_NAME[r.booking_status.status_name] ?? r.booking_status.status_name;
            const isDeptHierarchy = r.booking_status.status_name.startsWith('Pending');
            return html`
<div class="col-lg-6">
    <div class="card shadow-sm h-100">
        <div class="card-body">
            <div class="d-flex justify-content-between">
                <h6>${r.users.full_name} <small class="text-muted">${r.users.employee_id}</small></h6>
                <span class="badge ${statusBadgeClass(r.booking_status.badge_color)}">${r.booking_status.status_name}</span>
            </div>
            <p class="small text-muted mb-1">${r.users.departments?.department_name ?? '-'} (${r.users.resorts?.resort_name ?? '-'}) &middot; Currently with: <strong>${r.approver?.full_name ?? 'Unassigned'}</strong> (${level})</p>
            <p class="mb-1"><i class="bi bi-calendar3"></i> ${formatDate(r.travel_date)} at ${formatTime(r.ferry_schedule.departure_time)}</p>
            <p class="mb-1"><i class="bi bi-signpost-split"></i> ${r.direction} &middot; ${r.seats} seat(s)</p>
            <p class="mb-1"><strong>Purpose:</strong> ${r.purpose}</p>
            ${r.remarks ? html`<p class="mb-2 text-muted small">"${r.remarks}"</p>` : ''}

            <form method="post" class="mt-2 border-top pt-2">
                ${raw(csrfField(csrfToken))}
                <input type="hidden" name="booking_id" value="${r.booking_id}">
                <textarea name="comments" class="form-control form-control-sm mb-2" rows="2" placeholder="Override reason - required if this request is not currently assigned to you"></textarea>
                <div class="d-flex gap-2 mb-2">
                    <button type="submit" name="action" value="approve" class="btn btn-sm btn-success flex-fill"><i class="bi bi-check-lg"></i> Approve</button>
                    <button type="submit" name="action" value="reject" class="btn btn-sm btn-danger flex-fill"><i class="bi bi-x-lg"></i> Reject</button>
                    ${isDeptHierarchy ? html`<button type="submit" name="action" value="return" class="btn btn-sm btn-outline-secondary flex-fill"><i class="bi bi-arrow-counterclockwise"></i> Return</button>` : ''}
                </div>
            </form>
            <form method="post" class="d-flex gap-2 mt-1">
                ${raw(csrfField(csrfToken))}
                <input type="hidden" name="booking_id" value="${r.booking_id}">
                <input type="hidden" name="action" value="reassign">
                <select name="new_approver_id" class="form-select form-select-sm" required>
                    <option value="">-- Reassign to... --</option>
                    ${raw(userOptions)}
                </select>
                <button type="submit" class="btn btn-sm btn-outline-primary text-nowrap">Reassign</button>
            </form>
        </div>
    </div>
</div>`;
        })
        .map((c) => c.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-globe"></i> Executive Overview</h5>
<p class="text-muted">Every pending request, every department - General Manager, Resident Manager, and HR Manager users can approve, reject, reassign, or return any request regardless of who it is currently assigned to.</p>
<div class="row g-3">
    ${raw(cards || '<p class="text-muted text-center py-4">No requests are currently pending anywhere in the organization.</p>')}
</div>
${await recentOverridesHtml()}`;
}

/**
 * Full override audit trail: every booking_approvals row where an
 * executive acted on a request not assigned to them, with every field
 * the audit spec requires. Avoids a single embed query across multiple
 * FKs to the same users table (booking_approvals has three: approver_id,
 * original_approver_id, escalated_to_approver_id - PostgREST cannot
 * disambiguate an embed without a constraint-name hint, and this
 * project has hit that exact ambiguity before), so this batches simple
 * lookups instead.
 */
async function recentOverridesHtml() {
    const overrides = unwrap(
        await db()
            .from('booking_approvals')
            .select('approval_id, booking_id, approver_id, role_at_approval, action, comments, action_at, original_approver_id, departments(department_name), resorts(resort_name)')
            .eq('is_hr_override', true)
            .order('action_at', { ascending: false })
            .limit(50)
    );
    if (!overrides.length) return '';

    const bookingIds = [...new Set(overrides.map((o) => o.booking_id))];
    const bookingRows = unwrap(
        await db().from('bookings').select('booking_id, users!bookings_user_id_fkey(full_name, employee_id)').in('booking_id', bookingIds)
    );
    const bookingById = new Map(bookingRows.map((b) => [b.booking_id, b.users]));

    const userIds = [...new Set(overrides.flatMap((o) => [o.approver_id, o.original_approver_id]).filter(Boolean))];
    const userRows = userIds.length ? unwrap(await db().from('users').select('user_id, full_name').in('user_id', userIds)) : [];
    const userById = new Map(userRows.map((u) => [u.user_id, u.full_name]));

    const rowsHtml = overrides
        .map((o) => {
            const employee = bookingById.get(o.booking_id);
            const decisionBadge = { approved: 'bg-success', rejected: 'bg-danger' }[o.action] ?? 'bg-secondary';
            return html`<tr>
            <td>#${o.booking_id}</td>
            <td>${employee?.full_name ?? '-'} <small class="text-muted">${employee?.employee_id ?? ''}</small></td>
            <td>${o.resorts?.resort_name ?? '-'}</td>
            <td>${o.departments?.department_name ?? '-'}</td>
            <td>${o.original_approver_id ? (userById.get(o.original_approver_id) ?? '-') : 'Unassigned'}</td>
            <td>${userById.get(o.approver_id) ?? '-'} <small class="text-muted">(ID ${o.approver_id})</small></td>
            <td>${o.role_at_approval}</td>
            <td>${o.comments ?? '-'}</td>
            <td><span class="badge ${decisionBadge}">${o.action}</span></td>
            <td>${formatDateTime(o.action_at)}</td>
        </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mt-4 mb-3"><i class="bi bi-shield-exclamation"></i> Recent Executive Overrides</h5>
<p class="text-muted small">Every request an executive acted on outside the normal departmental chain, most recent first.</p>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle small">
    <thead><tr><th>Request ID</th><th>Employee</th><th>Resort</th><th>Department</th><th>Original Approver</th><th>Executive Approver</th><th>Executive Role</th><th>Override Reason</th><th>Decision</th><th>Date/Time</th></tr></thead>
    <tbody>${raw(rowsHtml)}</tbody>
</table></div></div>`;
}

export function registerHrOverviewRoutes(router) {
    router.get('/hr/overview', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.executive_override', { pageTitle: 'Executive Overview' });
        if (auth.response) return auth.response;
        const body = await overviewPageBody(auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'Executive Overview', path: '/hr/overview', bodyHtml: body });
    });

    router.post('/hr/overview', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.executive_override', { pageTitle: 'Executive Overview' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const bookingId = Number(form.booking_id);
        const action = form.action;
        const comments = (form.comments || '').trim();

        const bookingRows = unwrap(
            await db()
                .from('bookings')
                .select(
                    'user_id, current_approver_id, status_id, travel_date, booking_status(status_name), ' +
                        'users!bookings_user_id_fkey(department_id, resort_id, full_name, email), ' +
                        'ferry_schedule(departure_time, ferry_routes(route_name, direction))'
                )
                .eq('booking_id', bookingId)
                .limit(1)
        );
        const booking = bookingRows[0];
        if (!booking) {
            return redirectTo('/hr/overview', { cookies: [auth.setCookie, flashSetCookie('error', 'Booking not found.')].filter(Boolean) });
        }
        const departmentId = booking.users?.department_id ?? null;
        const resortId = booking.users?.resort_id ?? null;
        const currentLevel = LEVEL_BY_STATUS_NAME[booking.booking_status?.status_name] ?? null;
        const isOverride = booking.current_approver_id !== user.user_id;

        // Override Reason is mandatory whenever an executive acts on a
        // request not currently assigned to them - applies to every action.
        if (isOverride && !comments) {
            return redirectTo('/hr/overview', {
                cookies: [auth.setCookie, flashSetCookie('error', 'An override reason is required when acting on a request not assigned to you.')].filter(Boolean),
            });
        }

        if (action === 'approve' || action === 'reject') {
            const newStatusName = action === 'approve' ? 'Approved' : 'Rejected';
            const newStatusId = await getStatusId(newStatusName);

            const { data: updatedRows, error } = await eqOrNull(
                db().from('bookings').update({ status_id: newStatusId }).eq('booking_id', bookingId).eq('status_id', booking.status_id),
                'current_approver_id',
                booking.current_approver_id
            ).select('booking_id');
            if (error) throw new Error(error.message);

            if (updatedRows.length) {
                unwrap(
                    await db().from('booking_approvals').insert({
                        booking_id: bookingId,
                        approver_id: user.user_id,
                        role_at_approval: user.role_name,
                        action: action === 'approve' ? 'approved' : 'rejected',
                        comments: comments || null,
                        approval_level: currentLevel,
                        department_id: departmentId,
                        resort_id: resortId,
                        original_approver_id: booking.current_approver_id,
                        is_hr_override: isOverride,
                    })
                );
                const message =
                    action === 'approve'
                        ? `Your ferry booking has been approved by HR (${user.full_name}).`
                        : `Your ferry booking has been rejected by HR (${user.full_name})${comments ? ' - ' + comments : ''}.`;
                await createNotification(booking.user_id, message, 'booking', bookingId);
                deferBestEffort(
                    sendTemplatedEmail(
                        action === 'approve' ? 'booking_approval' : 'booking_rejection',
                        booking.users?.email,
                        {
                            full_name: booking.users?.full_name ?? '',
                            route_name: booking.ferry_schedule?.ferry_routes?.route_name ?? '',
                            direction: booking.ferry_schedule?.ferry_routes?.direction ?? '',
                            travel_date: formatDate(booking.travel_date),
                            departure_time: booking.ferry_schedule ? formatTime(booking.ferry_schedule.departure_time) : '',
                            booking_id: bookingId,
                            reason: comments || '',
                        },
                        { relatedBookingId: bookingId }
                    ),
                    `sendTemplatedEmail:booking_${action}`
                );

                if (action === 'approve') {
                    const coordinators = unwrap(
                        await db().from('users').select('user_id, roles!inner(role_name)').eq('status', 'active').eq('roles.role_name', 'Transport Coordinator')
                    );
                    for (const tc of coordinators) {
                        await createNotification(tc.user_id, 'A new ferry booking has been approved and is ready for the passenger manifest.', 'booking', bookingId);
                    }
                }
                await logActivity(user.user_id, `HR ${action === 'approve' ? 'approved' : 'rejected'} booking (override: ${isOverride})`, `booking_id=${bookingId}`, clientIp(request));
            }
            return redirectTo('/hr/overview', { cookies: [auth.setCookie, flashSetCookie('success', 'Decision recorded.')].filter(Boolean) });
        }

        if (action === 'reassign') {
            const newApproverId = Number(form.new_approver_id);
            if (!newApproverId) {
                return redirectTo('/hr/overview', { cookies: [auth.setCookie, flashSetCookie('error', 'Please choose someone to reassign to.')].filter(Boolean) });
            }
            // Server-side re-validation - never trust the dropdown alone.
            const activeCheck = unwrap(await db().from('users').select('user_id').eq('user_id', newApproverId).eq('status', 'active').limit(1));
            if (!activeCheck.length) {
                return redirectTo('/hr/overview', { cookies: [auth.setCookie, flashSetCookie('error', 'That user is no longer active.')].filter(Boolean) });
            }

            const { data: updatedRows, error } = await eqOrNull(
                db()
                    .from('bookings')
                    .update({ current_approver_id: newApproverId, current_approval_assigned_at: new Date().toISOString() })
                    .eq('booking_id', bookingId)
                    .eq('status_id', booking.status_id),
                'current_approver_id',
                booking.current_approver_id
            ).select('booking_id');
            if (error) throw new Error(error.message);

            if (updatedRows.length) {
                unwrap(
                    await db().from('booking_approvals').insert({
                        booking_id: bookingId,
                        approver_id: user.user_id,
                        role_at_approval: user.role_name,
                        action: 'reassigned',
                        comments: comments || null,
                        approval_level: currentLevel,
                        department_id: departmentId,
                        resort_id: resortId,
                        original_approver_id: booking.current_approver_id,
                        escalated_to_approver_id: newApproverId,
                        is_hr_override: isOverride,
                    })
                );
                await createNotification(newApproverId, 'A ferry booking request has been reassigned to you by HR for approval.', 'booking', bookingId);
                await logActivity(user.user_id, 'HR reassigned booking', `booking_id=${bookingId} -> user_id=${newApproverId}`, clientIp(request));
                return redirectTo('/hr/overview', { cookies: [auth.setCookie, flashSetCookie('success', 'Booking reassigned.')].filter(Boolean) });
            }
            return redirectTo('/hr/overview', { cookies: [auth.setCookie, flashSetCookie('error', 'Someone already acted on this booking - refresh to see its current state.')].filter(Boolean) });
        }

        if (action === 'return') {
            if (!departmentId || !resortId) {
                return redirectTo('/hr/overview', { cookies: [auth.setCookie, flashSetCookie('error', 'This booking has no department to return to.')].filter(Boolean) });
            }
            const config = await getDepartmentApprovalConfig(resortId, departmentId);
            if (!config || config.approval_mode !== 'department_hierarchy' || !config.manager_user_id) {
                return redirectTo('/hr/overview', { cookies: [auth.setCookie, flashSetCookie('error', 'This department has no configured Department Manager to return the request to.')].filter(Boolean) });
            }

            const returnStatusId = await getStatusId('Pending Department Manager Approval');
            const { data: updatedRows, error } = await eqOrNull(
                db()
                    .from('bookings')
                    .update({ status_id: returnStatusId, current_approver_id: config.manager_user_id, current_approval_assigned_at: new Date().toISOString() })
                    .eq('booking_id', bookingId)
                    .eq('status_id', booking.status_id),
                'current_approver_id',
                booking.current_approver_id
            ).select('booking_id');
            if (error) throw new Error(error.message);

            if (updatedRows.length) {
                unwrap(
                    await db().from('booking_approvals').insert({
                        booking_id: bookingId,
                        approver_id: user.user_id,
                        role_at_approval: user.role_name,
                        action: 'returned',
                        comments: comments || null,
                        approval_level: currentLevel,
                        department_id: departmentId,
                        resort_id: resortId,
                        original_approver_id: booking.current_approver_id,
                        escalated_to_approver_id: config.manager_user_id,
                        is_hr_override: isOverride,
                    })
                );
                await createNotification(config.manager_user_id, 'A ferry booking request has been returned by HR for further departmental review.', 'booking', bookingId);
                await createNotification(booking.user_id, 'Your ferry booking request has been returned to your department for further review.', 'booking', bookingId);
                await logActivity(user.user_id, 'HR returned booking to department', `booking_id=${bookingId}`, clientIp(request));
                return redirectTo('/hr/overview', { cookies: [auth.setCookie, flashSetCookie('success', 'Booking returned to the department.')].filter(Boolean) });
            }
            return redirectTo('/hr/overview', { cookies: [auth.setCookie, flashSetCookie('error', 'Someone already acted on this booking - refresh to see its current state.')].filter(Boolean) });
        }

        return redirectTo('/hr/overview', { cookies: [auth.setCookie] });
    });
}
