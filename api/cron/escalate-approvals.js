// Vercel Function version of netlify/functions/escalate-approvals.mts -
// same escalation logic, but triggered by a GitHub Actions scheduled
// workflow (see .github/workflows/scheduled-jobs.yml) rather than a
// native Vercel Cron Job, since Vercel's free Hobby plan only allows
// once-per-day cron schedules and this needs to run every 15 minutes.
// Protected by a shared secret since this URL is publicly reachable -
// only the scheduled workflow (or an operator who has the secret)
// should ever be able to trigger it.

import { db } from '../../netlify/functions/app/db.js';
import { escalateApproval } from '../../netlify/functions/app/approval.js';

async function handleRequest(request) {
    const auth = request.headers.get('authorization');
    if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
    }

    const { data: slaOverdue, error: slaError } = await db().rpc('find_sla_overdue_bookings');
    if (slaError) console.error('find_sla_overdue_bookings failed:', slaError.message);

    const { data: inactiveApprover, error: inactiveError } = await db().rpc('find_inactive_approver_bookings');
    if (inactiveError) console.error('find_inactive_approver_bookings failed:', inactiveError.message);

    const candidates = [
        ...(slaOverdue ?? []).map((booking) => ({ booking, reason: 'sla_timeout' })),
        ...(inactiveApprover ?? []).map((booking) => ({ booking, reason: 'approver_inactive' })),
    ];

    const seen = new Set();
    const escalated = [];
    for (const { booking, reason } of candidates) {
        if (seen.has(booking.booking_id)) continue;
        seen.add(booking.booking_id);

        try {
            const result = await escalateApproval(booking, reason);
            if (result.escalated) {
                console.log(`Escalated booking ${booking.booking_id} to ${result.level ?? 'unassigned'} (reason: ${reason})`);
                escalated.push(booking.booking_id);
            }
        } catch (err) {
            console.error(`Failed to escalate booking ${booking.booking_id}:`, err.message);
        }
    }

    return Response.json({ ok: true, checked: candidates.length, escalated });
}

export default { fetch: handleRequest };
