// One-shot flash messages - port of includes/functions.php's
// flash_set()/flash_get(). The PHP version stored these in
// $_SESSION and consumed them on the next page load; since Functions
// are stateless, this uses a small dedicated cookie instead (set on a
// redirect response, read + cleared on the following request).

import * as cookie from 'cookie';

const FLASH_COOKIE = 'ferry_flash';

/** Set-Cookie header value carrying one flash message to the next request. */
export function flashSetCookie(type, message) {
    const isLocalDev = process.env.NETLIFY_DEV === 'true';
    const value = encodeURIComponent(JSON.stringify({ type, message }));
    return cookie.serialize(FLASH_COOKIE, value, {
        httpOnly: true,
        secure: !isLocalDev,
        sameSite: 'lax',
        path: '/',
        maxAge: 60, // only needs to survive one redirect hop
    });
}

/** Reads the pending flash message (if any) from a request's cookies. */
export function flashGet(request) {
    const header = request.headers.get('cookie');
    if (!header) return [];
    const parsed = cookie.parse(header);
    const raw = parsed[FLASH_COOKIE];
    if (!raw) return [];
    try {
        return [JSON.parse(decodeURIComponent(raw))];
    } catch {
        return [];
    }
}

/** Set-Cookie header value that clears the flash cookie once it's been read. */
export function flashClearCookie() {
    const isLocalDev = process.env.NETLIFY_DEV === 'true';
    return cookie.serialize(FLASH_COOKIE, '', {
        httpOnly: true,
        secure: !isLocalDev,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
    });
}
