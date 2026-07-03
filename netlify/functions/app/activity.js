// Port of includes/functions.php's log_activity()/system_log().

import { db, unwrap } from './db.js';

export async function logActivity(userId, action, details = null, ipAddress = null) {
    unwrap(
        await db()
            .from('activity_logs')
            .insert({ user_id: userId, action, details, ip_address: ipAddress })
    );
}

export async function systemLog(level, message) {
    unwrap(await db().from('system_logs').insert({ log_level: level, message }));
}

/** Best-effort client IP extraction from Netlify's forwarded headers. */
export function clientIp(request) {
    return request.headers.get('x-nf-client-connection-ip')
        || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || null;
}
