// Port of includes/functions.php's create_notification()/
// get_unread_notification_count() plus the "recent 8" query navbar.php
// ran inline.

import { db, unwrap } from './db.js';
import { getSetting } from './settings.js';
import { deferBestEffort } from './deferred.js';

/**
 * The enabled-check stays awaited (it's a cached settings read, already
 * near-instant after warm-up - see settings.js) but the insert itself
 * is deferred via waitUntil() so callers don't block on it. See
 * deferred.js.
 */
export async function createNotification(userId, message, type = 'info', bookingId = null) {
    const enabled = await getSetting('notifications_enabled', '1');
    if (enabled !== '1') return;

    deferBestEffort(
        db().from('notifications').insert({ user_id: userId, message, type, related_booking_id: bookingId }).then(({ error }) => {
            if (error) throw new Error(error.message);
        }),
        'createNotification'
    );
}

export async function getUnreadNotificationCount(userId) {
    const { count, error } = await db()
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_read', false);
    if (error) throw new Error(error.message);
    return count || 0;
}

export async function getRecentNotifications(userId, limit = 8) {
    return unwrap(
        await db()
            .from('notifications')
            .select('notification_id, message, type, is_read, related_booking_id, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit)
    );
}

export async function markAllNotificationsRead(userId) {
    unwrap(
        await db()
            .from('notifications')
            .update({ is_read: true })
            .eq('user_id', userId)
            .eq('is_read', false)
    );
}
