// The token-gated landing page behind the approval_request email's View
// Request/Approve/Reject buttons (mailer.js's EMAIL_ACTIONS,
// approval.js's sendApprovalRequestEmail). Deliberately never performs
// the approve/reject decision on the GET request itself - corporate
// email scanners (Microsoft Safe Links, Proofpoint, etc.) pre-fetch
// every link in an email, which would silently trigger the decision
// before a human ever clicks if GET had a side effect. GET only shows
// the booking; POST (a real form submission, CSRF-protected) is the
// only thing that can actually change anything - reusing
// applyApprovalDecision() (approval.js), the exact same decision path
// /manager/approvals already uses, so behavior is identical regardless
// of entry point.
//
// The token proves this link was actually sent to the intended
// approver for this booking, but is not by itself sufficient to act -
// the visitor must also be logged in as that same user (see the plan's
// "token gets you there, login still required" decision). A stolen or
// forwarded email is therefore not a bypass.

import { db, unwrap } from '../db.js';
import { getSession } from '../session.js';
import { redirectTo, forbidden, notFound } from '../response.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { flashSetCookie } from '../flash.js';
import { formatDate, formatTime } from '../format.js';
import { applyApprovalDecision } from '../approval.js';
import { clientIp } from '../activity.js';

const TERMINAL_STATUSES = ['Approved', 'Rejected', 'Cancelled', 'Expired'];

async function getValidToken(token) {
    if (!token) return null;
    const rows = unwrap(await db().from('booking_approval_tokens').select('*').eq('token', token).limit(1));
    const row = rows[0];
    if (!row || new Date(row.expires_at) <= new Date()) return null;
    return row;
}

/** Same field shape as manager.js's pendingApprovalsBody(), for the same card layout. */
async function getActionableBooking(bookingId, approverId) {
    const rows = unwrap(
        await db()
            .from('bookings')
            .select(
                'booking_id, travel_date, direction, purpose, remarks, seats, current_approver_id, booking_status(status_name), ' +
                    'users!bookings_user_id_fkey(full_name, employee_id, departments(department_name)), ferry_schedule(departure_time)'
            )
            .eq('booking_id', bookingId)
            .limit(1)
    );
    const booking = rows[0];
    if (!booking) return { booking: null, actionable: false };
    const actionable = booking.current_approver_id === approverId && !TERMINAL_STATUSES.includes(booking.booking_status?.status_name);
    return { booking, actionable };
}

function approvalDetailBody({ booking, csrfToken, intent, token }) {
    return html`
<h5 class="mb-3"><i class="bi bi-check2-square"></i> Approval Request</h5>
<div class="row justify-content-center">
    <div class="col-md-7">
        <div class="card shadow-sm">
            <div class="card-body">
                <div class="d-flex justify-content-between">
                    <h6>${booking.users.full_name} <small class="text-muted">${booking.users.employee_id}</small></h6>
                    <span class="badge bg-warning text-dark">${booking.booking_status?.status_name ?? 'Pending'}</span>
                </div>
                <p class="small text-muted mb-1">${booking.users.departments?.department_name ?? '-'}</p>
                <p class="mb-1"><i class="bi bi-calendar3"></i> ${formatDate(booking.travel_date)} at ${formatTime(booking.ferry_schedule.departure_time)}</p>
                <p class="mb-1"><i class="bi bi-signpost-split"></i> ${booking.direction} &middot; ${booking.seats} seat(s)</p>
                <p class="mb-1"><strong>Purpose:</strong> ${booking.purpose}</p>
                ${booking.remarks ? html`<p class="mb-2 text-muted small">"${booking.remarks}"</p>` : ''}
                ${intent === 'approve' ? html`<div class="alert alert-success py-2 small mb-2">You followed an Approve Booking link - review the details below, then confirm.</div>` : ''}
                ${intent === 'reject' ? html`<div class="alert alert-danger py-2 small mb-2">You followed a Reject Booking link - review the details below, then confirm.</div>` : ''}
                <form method="post" class="mt-2">
                    ${raw(csrfField(csrfToken))}
                    <input type="hidden" name="token" value="${token}">
                    <textarea name="comments" class="form-control form-control-sm mb-2" rows="2" placeholder="Comments (required if rejecting)"></textarea>
                    <div class="d-flex gap-2">
                        <button type="submit" name="action" value="approve" class="btn btn-success flex-fill"><i class="bi bi-check-lg"></i> Approve Booking</button>
                        <button type="submit" name="action" value="reject" class="btn btn-danger flex-fill"><i class="bi bi-x-lg"></i> Reject Booking</button>
                    </div>
                </form>
            </div>
        </div>
    </div>
</div>`;
}

function alreadyHandledBody(statusName) {
    return html`
<div class="row justify-content-center"><div class="col-md-7">
    <div class="alert alert-info">This request has already been handled${statusName ? ` (current status: ${statusName})` : ''}. No further action is needed.</div>
    <a href="/dashboard" class="btn btn-primary">Go to Dashboard</a>
</div></div>`;
}

export function registerApprovalLinkRoutes(router) {
    router.get('/approval', async (request) => {
        const url = new URL(request.url);
        const token = (url.searchParams.get('token') || '').trim();
        const intent = url.searchParams.get('intent');

        const tokenRow = await getValidToken(token);
        if (!tokenRow) {
            return redirectTo('/auth/login', { cookies: [flashSetCookie('error', 'This approval link is invalid or has expired.')] });
        }

        const { user, setCookie } = await getSession(request);
        if (!user) {
            const next = `/approval?${new URLSearchParams({ token, ...(intent ? { intent } : {}) }).toString()}`;
            return redirectTo(`/auth/login?next=${encodeURIComponent(next)}`);
        }
        if (user.user_id !== tokenRow.approver_user_id) {
            return forbidden('This approval request was not assigned to your account.');
        }

        const { booking, actionable } = await getActionableBooking(tokenRow.booking_id, user.user_id);
        if (!booking) return notFound();

        const auth = { user, setCookie };
        const body = actionable
            ? approvalDetailBody({ booking, csrfToken: user.csrf, intent, token })
            : alreadyHandledBody(booking.booking_status?.status_name);
        return renderShellForRequest({ request, auth, pageTitle: 'Approval Request', path: '/approval', bodyHtml: body });
    });

    router.post('/approval', async (request) => {
        const form = await request.formData();
        const token = (form.get('token') || '').toString().trim();

        const tokenRow = await getValidToken(token);
        if (!tokenRow) {
            return redirectTo('/auth/login', { cookies: [flashSetCookie('error', 'This approval link is invalid or has expired.')] });
        }

        const { user, setCookie } = await getSession(request);
        if (!user) {
            return redirectTo(`/auth/login?next=${encodeURIComponent(`/approval?token=${token}`)}`);
        }
        if (!verifyCsrf(user.csrf, form.get('csrf_token'))) return forbidden();
        if (user.user_id !== tokenRow.approver_user_id) {
            return forbidden('This approval request was not assigned to your account.');
        }

        const action = form.get('action');
        if (!['approve', 'reject'].includes(action)) return notFound();
        const comments = (form.get('comments') || '').toString().trim();
        if (action === 'reject' && !comments) {
            return redirectTo(`/approval?token=${token}&intent=reject`, { cookies: [flashSetCookie('error', 'Please provide a reason for rejecting this request.')] });
        }

        const result = await applyApprovalDecision({
            bookingId: tokenRow.booking_id,
            actorUserId: user.user_id,
            actorRoleName: user.role_name,
            actorFullName: user.full_name,
            decision: action === 'approve' ? 'approved' : 'rejected',
            comments,
            clientIp: clientIp(request),
        });

        const message = result.ok
            ? `Booking ${action === 'approve' ? 'approved' : 'rejected'} successfully.`
            : result.reason === 'not_assigned'
              ? 'This request is not assigned to you.'
              : 'This request was already handled.';
        return redirectTo('/dashboard', { cookies: [setCookie, flashSetCookie(result.ok ? 'success' : 'error', message)].filter(Boolean) });
    });
}
