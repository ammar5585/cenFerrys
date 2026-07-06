// Netlify Scheduled Function - port of includes/functions.php's
// expire_old_bookings(), converted from "run on every dashboard load"
// (a PHP shared-hosting workaround, per that function's own comment)
// to a genuine cron job, since Netlify supports these natively. Calls
// the expire_old_bookings() Postgres function from 0003_functions.sql.

import { db } from './app/db.js';

export default async () => {
    const { error } = await db().rpc('expire_old_bookings');
    if (error) {
        console.error('expire_old_bookings failed:', error.message);
    }

    const { error: reservationError } = await db().rpc('expire_old_seat_reservations');
    if (reservationError) {
        console.error('expire_old_seat_reservations failed:', reservationError.message);
    }
};

export const config = {
    schedule: '*/30 * * * *', // every 30 minutes
};
