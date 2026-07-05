// Port of includes/functions.php's require_login()/require_role().
// Route handlers call one of these first; a non-null `response` means
// "stop and return this" (redirect to login, or 403).

import { getSession } from './session.js';
import { redirectTo, forbidden } from './response.js';
import { hasPermission } from './permissions.js';
import { accessDeniedResponse } from './accessDenied.js';

export async function requireLogin(request) {
    const { user, setCookie, expired } = await getSession(request);
    if (!user) {
        const location = expired ? '/auth/login?timeout=1' : '/auth/login';
        return { response: redirectTo(location) };
    }
    return { user, setCookie };
}

export async function requireRole(request, allowedRoles) {
    const result = await requireLogin(request);
    if (result.response) return result;
    if (!allowedRoles.includes(result.user.role_name)) {
        return { response: forbidden('You do not have permission to view this page.') };
    }
    return result;
}

/**
 * Permission-based guard, alongside (not replacing) requireRole - the
 * 53 existing requireRole() call sites are being converted to this one
 * by one, with seed role_permissions constructed to reproduce today's
 * exact access, so the conversion changes no existing user's access.
 */
export async function requirePermission(request, permissionKey, { pageTitle } = {}) {
    const result = await requireLogin(request);
    if (result.response) return result;
    if (!hasPermission(result.user.perms, permissionKey)) {
        return { response: await accessDeniedResponse({ request, auth: result, pageTitle }) };
    }
    return result;
}
