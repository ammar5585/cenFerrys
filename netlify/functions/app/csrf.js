// CSRF protection - port of includes/functions.php's csrf_token()/
// csrf_field()/csrf_verify(). Since rendering stays fully server-side,
// this uses the original app's synchronizer-token pattern rather than
// a double-submit-cookie scheme: a random value is minted once at
// login and carried unchanged as a claim inside the session JWT (see
// auth.js). Forms echo it back as a hidden field; POST handlers
// compare it against the claim in the *verified* incoming JWT.

import crypto from 'node:crypto';
import * as cookie from 'cookie';

const PRE_AUTH_COOKIE = 'ferry_csrf_pre';

export function mintCsrfToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Pre-auth CSRF (for the login form itself, before any session JWT
 * exists): mint a token, embed it in the rendered form, and also set
 * it as a short-lived httpOnly cookie so the POST handler can compare
 * against it - the same synchronizer-token shape as the authenticated
 * case, just cookie-backed instead of JWT-claim-backed.
 */
export function mintPreAuthCsrf() {
    const isLocalDev = process.env.NETLIFY_DEV === 'true';
    const token = mintCsrfToken();
    const setCookie = cookie.serialize(PRE_AUTH_COOKIE, token, {
        httpOnly: true,
        secure: !isLocalDev,
        sameSite: 'lax',
        path: '/',
        maxAge: 600, // 10 minutes - plenty for filling in a login form
    });
    return { token, setCookie };
}

export function readPreAuthCsrfCookie(request) {
    const header = request.headers.get('cookie');
    if (!header) return null;
    return cookie.parse(header)[PRE_AUTH_COOKIE] || null;
}

/** Renders the hidden CSRF field, matching the PHP app's csrf_field(). */
export function csrfField(csrfToken) {
    return `<input type="hidden" name="csrf_token" value="${csrfToken}">`;
}

/**
 * Verifies a submitted token against the session's csrf claim.
 * Accepts the token from a form field (`csrf_token`) or, for the AJAX
 * endpoints, an `X-CSRF-Token` header - either way it's compared with
 * the same constant-time check the PHP app used (hash_equals port).
 */
export function verifyCsrf(sessionCsrf, submittedCsrf) {
    if (!sessionCsrf || !submittedCsrf) return false;
    const a = Buffer.from(String(sessionCsrf));
    const b = Buffer.from(String(submittedCsrf));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
