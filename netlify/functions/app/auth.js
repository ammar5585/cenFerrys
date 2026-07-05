// Password hashing (bcryptjs - pure JS, no native bindings, so it
// builds reliably in Netlify's serverless bundler) and session JWTs
// (replacing PHP's server-side session files, since Functions are
// stateless/ephemeral between invocations).

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as cookie from 'cookie';
import { mintCsrfToken } from './csrf.js';

const COOKIE_NAME = 'ferry_session';
const BCRYPT_ROUNDS = 10; // matches PHP's PASSWORD_DEFAULT (bcrypt) cost factor

export async function hashPassword(password) {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

/** Shared by the admin "reset password" action and the CSV bulk-import path. */
export function generateTempPassword() {
    return `Ferry@${Math.floor(10000 + Math.random() * 90000)}`;
}

function jwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set. See .env.example.');
    return secret;
}

/**
 * Signs a fresh session JWT. `csrfToken` should be reused across
 * reissues within the same login (minted once at login time) so the
 * CSRF claim doesn't change out from under a page the user already has open.
 */
export function signSessionToken(user, csrfToken, timeoutMinutes) {
    const payload = {
        user_id: user.user_id,
        employee_id: user.employee_id,
        full_name: user.full_name,
        username: user.username,
        role_id: user.role_id,
        role_name: user.role_name,
        department: user.department_name ?? null,
        // Whether this user is assigned as ANY department's approval-tier
        // approver, regardless of their RBAC role - drives sidebar
        // visibility for the Pending Approvals link (see session.js).
        is_dept_approver: !!user.is_dept_approver,
        csrf: csrfToken,
    };
    return jwt.sign(payload, jwtSecret(), { expiresIn: `${timeoutMinutes}m` });
}

/** Returns the decoded payload, or null if missing/expired/invalid. */
export function verifySessionToken(token) {
    if (!token) return null;
    try {
        return jwt.verify(token, jwtSecret());
    } catch {
        return null;
    }
}

/**
 * Same as verifySessionToken, but also reports whether the token was
 * present-but-expired (vs. missing/tampered) - lets the caller show
 * PHP's "your session expired" banner (?timeout=1) only in that case.
 */
export function verifySessionTokenDetailed(token) {
    if (!token) return { payload: null, expired: false };
    try {
        return { payload: jwt.verify(token, jwtSecret()), expired: false };
    } catch (err) {
        return { payload: null, expired: err?.name === 'TokenExpiredError' };
    }
}

export function newCsrfToken() {
    return mintCsrfToken();
}

/** Extracts the session JWT from a request's Cookie header. */
export function readSessionCookie(request) {
    const header = request.headers.get('cookie');
    if (!header) return null;
    const parsed = cookie.parse(header);
    return parsed[COOKIE_NAME] || null;
}

/**
 * Builds a Set-Cookie header value for the session.
 * `rememberDays`: if set, the cookie's own Max-Age is extended (so the
 * browser retains it across restarts) while the JWT's internal `exp`
 * still follows the normal idle-timeout - matching the PHP app's
 * "remember me" behaviour, which only ever extended the raw cookie.
 */
export function buildSessionCookie(token, { rememberDays } = {}) {
    const isLocalDev = process.env.VERCEL_ENV === 'development' || process.env.NETLIFY_DEV === 'true';
    return cookie.serialize(COOKIE_NAME, token, {
        httpOnly: true,
        secure: !isLocalDev,
        sameSite: 'lax',
        path: '/',
        maxAge: rememberDays ? rememberDays * 24 * 60 * 60 : undefined,
    });
}

/** Set-Cookie header that immediately expires the session cookie (logout). */
export function clearSessionCookie() {
    const isLocalDev = process.env.VERCEL_ENV === 'development' || process.env.NETLIFY_DEV === 'true';
    return cookie.serialize(COOKIE_NAME, '', {
        httpOnly: true,
        secure: !isLocalDev,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
    });
}
