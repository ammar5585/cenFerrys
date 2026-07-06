// Vercel Function version, mirroring api/cron/expire-bookings.js's shape -
// runs once daily via the GitHub Actions scheduled workflow (see
// .github/workflows/scheduled-jobs.yml), protected by the same shared
// CRON_SECRET. Sends the "ferry_reminder" email template to every
// Approved booking whose travel_date is tomorrow (1-day-ahead reminder,
// per the user's confirmed scope for this feature).

import { db, unwrap } from '../../netlify/functions/app/db.js';
import { getStatusId } from '../../netlify/functions/app/approval.js';
import { sendTemplatedEmail } from '../../netlify/functions/app/mailer.js';
import { formatDate, formatTime } from '../../netlify/functions/app/format.js';

async function handleRequest(request) {
    const auth = request.headers.get('authorization');
    if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
    }

    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowDate = tomorrow.toISOString().slice(0, 10);

    const approvedId = await getStatusId('Approved');
    const bookings = unwrap(
        await db()
            .from('bookings')
            .select(
                'booking_id, travel_date, users!bookings_user_id_fkey(full_name, email), ferry_schedule(departure_time, ferry_routes(route_name, direction))'
            )
            .eq('travel_date', tomorrowDate)
            .eq('status_id', approvedId)
    );

    let sent = 0;
    for (const booking of bookings) {
        if (!booking.users?.email) continue;
        await sendTemplatedEmail(
            'ferry_reminder',
            booking.users.email,
            {
                full_name: booking.users.full_name ?? '',
                route_name: booking.ferry_schedule?.ferry_routes?.route_name ?? '',
                direction: booking.ferry_schedule?.ferry_routes?.direction ?? '',
                travel_date: formatDate(booking.travel_date),
                departure_time: booking.ferry_schedule ? formatTime(booking.ferry_schedule.departure_time) : '',
                booking_id: booking.booking_id,
            },
            { relatedBookingId: booking.booking_id }
        );
        sent++;
    }

    return Response.json({ ok: true, checked: bookings.length, sent });
}

export default { fetch: handleRequest };
