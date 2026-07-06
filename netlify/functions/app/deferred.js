// Defers a best-effort side-effect promise (audit logging, notification
// inserts) so the HTTP response doesn't wait on it, via Vercel's
// waitUntil() (@vercel/functions) - the function instance keeps running
// after the response is sent until the promise settles, instead of the
// request blocking on it. Falls back to a plain fire-and-forget if
// waitUntil isn't available (e.g. local `netlify dev`, or a cron
// invocation with no active Vercel request context) - the promise still
// runs via the normal event loop there, just without an explicit
// keep-alive guarantee past the response.
//
// Both call sites (activity.js's logActivity, notifications.js's
// createNotification) are already "nothing branches on this" side
// effects today - nothing awaited their result for control flow, only
// for making the caller wait. Errors are logged, not thrown, since by
// the time these settle the response may already be gone.

import { waitUntil } from '@vercel/functions';

export function deferBestEffort(promise, label) {
    const guarded = promise.catch((err) => {
        console.error(`${label} failed:`, err?.message || err);
    });
    try {
        waitUntil(guarded);
    } catch {
        // No active Vercel request context - `guarded` still runs via the
        // normal event loop (already wired above), nothing more to do.
    }
}
