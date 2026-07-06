// Port of includes/functions.php's log_activity()/system_log().

import { db } from './db.js';
import { deferBestEffort } from './deferred.js';

/**
 * Fire-and-forget - the insert itself is deferred via waitUntil() so
 * callers (already never awaiting this for any control-flow decision)
 * don't block their response on it. See deferred.js.
 */
export function logActivity(userId, action, details = null, ipAddress = null) {
    deferBestEffort(
        db().from('activity_logs').insert({ user_id: userId, action, details, ip_address: ipAddress }).then(({ error }) => {
            if (error) throw new Error(error.message);
        }),
        'logActivity'
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
