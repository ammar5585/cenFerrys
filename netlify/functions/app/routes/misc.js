// Port of help.php and about.php.

import { requireLogin } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { getSetting } from '../settings.js';
import { html, raw } from '../templates/html.js';
import { ROLE_STAFF, ROLE_GM, ROLE_RM, ROLE_HR, ROLE_TRANSPORT, ROLE_ADMIN } from '../session.js';

export function registerMiscRoutes(router) {
    router.get('/help', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;
        const role = auth.user.role_name;

        let roleSection = '';
        if (role === ROLE_STAFF) {
            roleSection = html`<h6 class="mt-4">Booking a Ferry</h6>
                <ol>
                    <li>Go to <strong>New Booking</strong>.</li>
                    <li>Choose your travel date and direction, then pick an available ferry time.</li>
                    <li>Enter your purpose of travel and submit.</li>
                    <li>Your request is automatically routed to the General Manager, Resident Manager, or HR Manager for approval.</li>
                    <li>Track the status from <strong>Booking History</strong>. You may cancel a booking any time before it is completed.</li>
                </ol>`.toString();
        } else if ([ROLE_GM, ROLE_RM, ROLE_HR].includes(role)) {
            roleSection = html`<h6 class="mt-4">Approving Requests</h6>
                <p>Requests routed to you appear under <strong>Pending Approvals</strong>. Approve or reject with optional comments. Set your <strong>My Availability</strong> to On Leave or Out of Office when you cannot approve, so requests route to the next manager automatically.</p>`.toString();
        } else if (role === ROLE_TRANSPORT) {
            roleSection = html`<h6 class="mt-4">Managing Passenger Lists</h6>
                <p>Use <strong>Today's Passengers</strong> to see who is confirmed on each ferry. Print manifests or export them to Excel/CSV before departure.</p>`.toString();
        } else if (role === ROLE_ADMIN) {
            roleSection = html`<h6 class="mt-4">Administrator Tasks</h6>
                <p>Manage users, ferry schedules, routes, manager availability, and portal settings from the sidebar.</p>`.toString();
        }

        const body = html`
<h5 class="mb-3"><i class="bi bi-question-circle"></i> Help</h5>
<div class="card shadow-sm"><div class="card-body">
    <h6>Getting Started</h6>
    <p>Use the sidebar to navigate the portal. Your menu is tailored to your role: <strong>${role}</strong>.</p>
    ${raw(roleSection)}
    <h6 class="mt-4">Need more help?</h6>
    <p>Contact your system Administrator.</p>
</div></div>`;
        return renderShellForRequest({ request, auth, pageTitle: 'Help', path: '/help', bodyHtml: body });
    });

    router.get('/about', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;

        const companyName = await getSetting('company_name', 'Staff Ferry Transfer Portal');
        const body = html`
<h5 class="mb-3"><i class="bi bi-info-circle"></i> About</h5>
<div class="card shadow-sm"><div class="card-body">
    <h6>${companyName} - Staff Ferry Transfer Portal</h6>
    <p class="text-muted">Version 1.0.0</p>
    <p>A staff ferry transfer booking and approval portal covering booking management, automatic
       approval routing (General Manager &rarr; Resident Manager &rarr; HR Manager), ferry schedule
       management, transport coordination, reporting, and role-based access control.</p>
    <p class="text-muted small mb-0">Built with Netlify Functions, Supabase Postgres, and Bootstrap 5.</p>
</div></div>`;
        return renderShellForRequest({ request, auth, pageTitle: 'About', path: '/about', bodyHtml: body });
    });
}
