// Single catch-all Vercel Function (Node.js runtime, Fetch Web Standard
// export) handling every dynamic route. Static files under public/ are
// served directly by Vercel before the vercel.json catch-all rewrite
// fires - same "static wins" precedence this app already relied on
// under Netlify, must be confirmed live after deploying (see the
// project's plan doc).
//
// This file is a direct port of netlify/functions/app.mts: identical
// router wiring, reusing every route module completely unchanged (they
// only ever touch standard Request/Response/Headers objects, never
// anything Netlify-specific). The only difference is the export shape
// at the bottom - Vercel's Node.js runtime wants { fetch(request) },
// not a bare default function.

import { createRouter } from '../netlify/functions/app/router.js';
import { registerAuthRoutes } from '../netlify/functions/app/routes/auth.js';
import { registerDashboardRoutes } from '../netlify/functions/app/routes/dashboard.js';
import { registerStaffRoutes } from '../netlify/functions/app/routes/staff.js';
import { registerAjaxRoutes } from '../netlify/functions/app/routes/ajax.js';
import { registerManagerRoutes } from '../netlify/functions/app/routes/manager.js';
import { registerTransportRoutes } from '../netlify/functions/app/routes/transport.js';
import { registerAdminRoutes } from '../netlify/functions/app/routes/admin.js';
import { registerAdminBookingsRoutes } from '../netlify/functions/app/routes/admin_bookings.js';
import { registerAdminConfigRoutes } from '../netlify/functions/app/routes/admin_config.js';
import { registerAdminDirectionsRoutes } from '../netlify/functions/app/routes/admin_directions.js';
import { registerAdminSettingsRoutes } from '../netlify/functions/app/routes/admin_settings.js';
import { registerAdminBrandingRoutes } from '../netlify/functions/app/routes/admin_branding.js';
import { registerAdminActivityLogRoutes } from '../netlify/functions/app/routes/admin_activity_logs.js';
import { registerAdminDepartmentApprovalRoutes } from '../netlify/functions/app/routes/admin_department_approval.js';
import { registerAdminDepartmentsRoutes } from '../netlify/functions/app/routes/admin_departments.js';
import { registerAdminPermissionsRoutes } from '../netlify/functions/app/routes/admin_permissions.js';
import { registerAdminUserPermissionsRoutes } from '../netlify/functions/app/routes/admin_user_permissions.js';
import { registerAdminSeatReservationsRoutes } from '../netlify/functions/app/routes/admin_seat_reservations.js';
import { registerAdminUserImportRoutes } from '../netlify/functions/app/routes/admin_user_import.js';
import { registerAdminEmailSettingsRoutes } from '../netlify/functions/app/routes/admin_email_settings.js';
import { registerReportsRoutes } from '../netlify/functions/app/routes/reports.js';
import { registerHrOverviewRoutes } from '../netlify/functions/app/routes/hr_overview.js';
import { registerManagerExtraRoutes } from '../netlify/functions/app/routes/manager_extra.js';
import { registerHodReservationRoutes } from '../netlify/functions/app/routes/hod_reservations.js';
import { registerTransportSchedulesViewRoutes } from '../netlify/functions/app/routes/transport_schedules_view.js';
import { registerMiscRoutes } from '../netlify/functions/app/routes/misc.js';
import { registerSecurityRoutes } from '../netlify/functions/app/routes/security.js';
import { notFound, redirectTo } from '../netlify/functions/app/response.js';

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

async function handleRequest(request) {
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
}

export default { fetch: handleRequest };
