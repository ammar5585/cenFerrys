// Single catch-all Netlify Function (v2 API) handling every dynamic
// route. Static files under public/ never reach this - Netlify matches
// them before the "/*" redirect fires. Internal routing mirrors the
// original PHP app's folder paths (see app/routes/*.js).

import { createRouter } from './app/router.js';
import { registerAuthRoutes } from './app/routes/auth.js';
import { registerDashboardRoutes } from './app/routes/dashboard.js';
import { registerStaffRoutes } from './app/routes/staff.js';
import { registerAjaxRoutes } from './app/routes/ajax.js';
import { registerManagerRoutes } from './app/routes/manager.js';
import { registerTransportRoutes } from './app/routes/transport.js';
import { registerAdminRoutes } from './app/routes/admin.js';
import { registerAdminBookingsRoutes } from './app/routes/admin_bookings.js';
import { registerAdminConfigRoutes } from './app/routes/admin_config.js';
import { registerAdminDirectionsRoutes } from './app/routes/admin_directions.js';
import { registerAdminSettingsRoutes } from './app/routes/admin_settings.js';
import { registerAdminBrandingRoutes } from './app/routes/admin_branding.js';
import { registerAdminActivityLogRoutes } from './app/routes/admin_activity_logs.js';
import { registerAdminDepartmentApprovalRoutes } from './app/routes/admin_department_approval.js';
import { registerAdminDepartmentsRoutes } from './app/routes/admin_departments.js';
import { registerAdminPermissionsRoutes } from './app/routes/admin_permissions.js';
import { registerAdminUserPermissionsRoutes } from './app/routes/admin_user_permissions.js';
import { registerAdminSeatReservationsRoutes } from './app/routes/admin_seat_reservations.js';
import { registerAdminUserImportRoutes } from './app/routes/admin_user_import.js';
import { registerAdminEmailSettingsRoutes } from './app/routes/admin_email_settings.js';
import { registerReportsRoutes } from './app/routes/reports.js';
import { registerHrOverviewRoutes } from './app/routes/hr_overview.js';
import { registerManagerExtraRoutes } from './app/routes/manager_extra.js';
import { registerHodReservationRoutes } from './app/routes/hod_reservations.js';
import { registerTransportSchedulesViewRoutes } from './app/routes/transport_schedules_view.js';
import { registerMiscRoutes } from './app/routes/misc.js';
import { registerSecurityRoutes } from './app/routes/security.js';
import { notFound, redirectTo } from './app/response.js';

const router = createRouter();
registerAuthRoutes(router);
registerDashboardRoutes(router);
registerStaffRoutes(router);
registerAjaxRoutes(router);
registerManagerRoutes(router);
registerTransportRoutes(router);
registerAdminRoutes(router);
registerAdminBookingsRoutes(router);
registerAdminConfigRoutes(router);
registerAdminDirectionsRoutes(router);
registerAdminSettingsRoutes(router);
registerAdminBrandingRoutes(router);
registerAdminActivityLogRoutes(router);
registerAdminDepartmentApprovalRoutes(router);
registerAdminDepartmentsRoutes(router);
registerAdminPermissionsRoutes(router);
registerAdminUserPermissionsRoutes(router);
registerAdminSeatReservationsRoutes(router);
registerAdminUserImportRoutes(router);
registerAdminEmailSettingsRoutes(router);
registerReportsRoutes(router);
registerHrOverviewRoutes(router);
registerManagerExtraRoutes(router);
registerHodReservationRoutes(router);
registerTransportSchedulesViewRoutes(router);
registerMiscRoutes(router);
registerSecurityRoutes(router);

// Root path mirrors index.php: send to /dashboard (which itself
// redirects to /auth/login when not authenticated).
router.get('/', async () => redirectTo('/dashboard'));

export default async (request: Request) => {
    try {
        const response = await router.handle(request, {});
        return response ?? notFound(`No route for ${request.method} ${new URL(request.url).pathname}`);
    } catch (err) {
        console.error(err);
        return new Response('<h2>500 Internal Server Error</h2><p>Something went wrong. Please try again.</p>', {
            status: 500,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    }
};

// No `config.path` here deliberately: Netlify Functions v2's own
// path-based routing appears to take precedence over static asset
// serving (unlike a netlify.toml [[redirects]] rule, which is
// documented to let existing static files win). The redirect rule in
// netlify.toml already routes everything else to this function at its
// default /.netlify/functions/app path, so no config.path is needed.
