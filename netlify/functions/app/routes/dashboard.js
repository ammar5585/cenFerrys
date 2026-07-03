// Port of dashboard.php: central role router, sends each role to its
// dedicated dashboard route.

import { requireLogin } from '../guards.js';
import { redirectTo } from '../response.js';
import { ROLE_ADMIN, ROLE_STAFF, ROLE_GM, ROLE_RM, ROLE_HR, ROLE_DEPT_MGR, ROLE_TRANSPORT } from '../session.js';

const ROLE_ROUTES = {
    [ROLE_ADMIN]: '/admin/dashboard',
    [ROLE_STAFF]: '/staff/dashboard',
    [ROLE_GM]: '/manager/dashboard',
    [ROLE_RM]: '/manager/dashboard',
    [ROLE_HR]: '/manager/dashboard',
    [ROLE_DEPT_MGR]: '/manager/dashboard',
    [ROLE_TRANSPORT]: '/transport/dashboard',
};

export function registerDashboardRoutes(router) {
    router.get('/dashboard', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;

        const target = ROLE_ROUTES[auth.user.role_name];
        return redirectTo(target || '/auth/login', { cookies: [auth.setCookie].filter(Boolean) });
    });
}
