// Port of dashboard.php: central role router, sends each user to their
// dedicated dashboard route based on their granted dashboard.view_*
// permission - not a hardcoded role_name lookup. The 8 built-in roles
// each already have exactly one of these granted by default (see
// defaultRolePermissions.js), so this routes them identically to
// before; the fix is for any OTHER role (any custom role, including
// one created with zero permissions) - the old role_name-keyed map had
// no entry for those, falling through to redirectTo('/auth/login'),
// which - since the user is still authenticated - immediately bounces
// back to /dashboard, an actual infinite redirect loop in the browser.
// A role with no dashboard.view_* permission granted at all now gets a
// normal in-shell "Access Denied" page instead (still fully usable -
// sidebar/logout/etc. all work), never a redirect loop.

import { requireLogin } from '../guards.js';
import { redirectTo } from '../response.js';
import { hasPermission } from '../permissions.js';
import { accessDeniedResponse } from '../accessDenied.js';

// Order matters: checked top-to-bottom, first match wins - Administrator
// (the only default role with 2 dashboard.view_* permissions granted:
// view_admin + view_security) must resolve to /admin/dashboard, exactly
// like the old role_name map did.
const PERMISSION_ROUTES = [
    ['dashboard.view_admin', '/admin/dashboard'],
    ['dashboard.view_manager', '/manager/dashboard'],
    ['dashboard.view_transport', '/transport/dashboard'],
    ['dashboard.view_staff', '/staff/dashboard'],
    ['dashboard.view_security', '/security/dashboard'],
];

export function registerDashboardRoutes(router) {
    router.get('/dashboard', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;

        const match = PERMISSION_ROUTES.find(([perm]) => hasPermission(auth.user.perms, perm));
        if (!match) {
            return accessDeniedResponse({ request, auth, pageTitle: 'Dashboard' });
        }
        return redirectTo(match[1], { cookies: [auth.setCookie].filter(Boolean) });
    });
}
