// Vercel Function version - see api/cron/escalate-approvals.js's header
// comment for why this runs via a GitHub Actions scheduled workflow
// rather than a native Vercel Cron Job, and why it is protected by a
// shared secret. Fires any due report_schedules row (Automated Daily
// Operations Report Email), then retries recent failed deliveries.

import { runDueSchedules, retryFailedEmails } from '../../netlify/functions/app/reportEmailScheduling.js';

async function handleRequest(request) {
    const auth = request.headers.get('authorization');
    if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
    }

    try {
        const sent = await runDueSchedules();
        const retried = await retryFailedEmails();
        return Response.json({ ok: true, sent, retried });
    } catch (err) {
        console.error('send-scheduled-reports failed:', err.message);
        return Response.json({ ok: false, error: err.message }, { status: 500 });
    }
}

export default { fetch: handleRequest };
