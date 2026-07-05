// Vercel Function version of netlify/functions/expire-bookings.mts -
// see api/cron/escalate-approvals.js's header comment for why this runs
// via a GitHub Actions scheduled workflow rather than a native Vercel
// Cron Job, and why it is protected by a shared secret.

import { db } from '../../netlify/functions/app/db.js';

async function handleRequest(request) {
    const auth = request.headers.get('authorization');
    if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
    }

    const { error } = await db().rpc('expire_old_bookings');
    if (error) {
        console.error('expire_old_bookings failed:', error.message);
        return Response.json({ ok: false, error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true });
}

export default { fetch: handleRequest };
