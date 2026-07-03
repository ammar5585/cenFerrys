// Session resolution: verifies the incoming JWT, rechecks the user is
// still active (the deactivation-latency mitigation - see plan doc),
// and reissues a fresh cookie on every authenticated request so the
// JWT's `exp` slides forward like PHP's idle-timeout session did.

import { db, unwrap } from './db.js';
import { readSessionCookie, verifySessionTokenDetailed, buildSessionCookie, signSessionToken } from './auth.js';
import { getSetting } from './settings.js';

/**
 * Resolves the current session for a request.
 * Returns { user, setCookie, expired } where `user` is null if not
 * logged in or the session expired/was invalidated, `setCookie` is a
 * Set-Cookie header value to attach to the response when the session
 * was successfully refreshed (null otherwise), and `expired` is true
 * only when a session *was* present but its JWT had expired (used to
 * show the "your session expired" banner, matching the PHP app's
 * ?timeout=1 flag - not shown for a plain not-logged-in visit).
 */
export async function getSession(request) {
    const token = readSessionCookie(request);
    const { payload, expired } = verifySessionTokenDetailed(token);
    if (!payload) {
        return { user: null, setCookie: null, expired };
    }

    // Re-check the account is still active - closes most of the gap
    // left by JWTs not supporting instant server-side revocation.
    const rows = unwrap(
        await db().from('users').select('status').eq('user_id', payload.user_id).limit(1)
    );
    if (!rows.length || rows[0].status !== 'active') {
        return { user: null, setCookie: null, expired: false };
    }

    const timeoutMinutes = Number(await getSetting('session_timeout_minutes', 30));
    const freshToken = signSessionToken(
        {
            user_id: payload.user_id,
            employee_id: payload.employee_id,
            full_name: payload.full_name,
            username: payload.username,
            role_id: payload.role_id,
            role_name: payload.role_name,
            department_name: payload.department,
        },
        payload.csrf,
        timeoutMinutes
    );

    return {
        user: payload,
        setCookie: buildSessionCookie(freshToken),
        expired: false,
    };
}

/** Role name constants - identical strings to includes/functions.php. */
export const ROLE_ADMIN = 'Administrator';
export const ROLE_GM = 'General Manager';
export const ROLE_RM = 'Resident Manager';
export const ROLE_HR = 'HR Manager';
export const ROLE_TRANSPORT = 'Transport Coordinator';
export const ROLE_DEPT_MGR = 'Department Manager';
export const ROLE_STAFF = 'Staff';

export const APPROVAL_CHAIN = [ROLE_GM, ROLE_RM, ROLE_HR];
