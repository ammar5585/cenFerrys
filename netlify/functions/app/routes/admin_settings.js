// Port of admin/settings.php - settings table editor + portal logo upload.

import { requireRole } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getSetting, setSetting, resetSettingsCache } from '../settings.js';
import { uploadPortalLogo } from '../uploads.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { ROLE_ADMIN } from '../session.js';

const WEEKDAY_OPTIONS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function settingsBody({ errors, csrfToken }) {
    const companyName = await getSetting('company_name', '');
    const portalLogo = await getSetting('portal_logo', '');
    const maxSeats = await getSetting('max_seats_per_booking', 4);
    const cutoffHours = await getSetting('booking_cutoff_hours', 2);
    const workingDaysStr = await getSetting('working_days', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun');
    const passwordMinLength = await getSetting('password_min_length', 8);
    const sessionTimeout = await getSetting('session_timeout_minutes', 30);
    const notificationsEnabled = await getSetting('notifications_enabled', '1');
    const maintenanceMode = await getSetting('maintenance_mode', '0');
    const workingDays = workingDaysStr.split(',');

    return html`
<h5 class="mb-3"><i class="bi bi-gear"></i> Portal Settings</h5>
${errors.length ? html`<div class="alert alert-danger">${raw(errors.map((e) => `${e}<br>`).join(''))}</div>` : ''}
<div class="card shadow-sm"><div class="card-body">
    <form method="post" enctype="multipart/form-data">
        ${raw(csrfField(csrfToken))}
        <div class="row g-3">
            <div class="col-md-6"><label class="form-label">Company Name</label><input type="text" name="company_name" class="form-control" value="${companyName}"></div>
            <div class="col-md-6"><label class="form-label">Portal Logo</label><input type="file" name="portal_logo" class="form-control" accept=".jpg,.jpeg,.png,.svg,.webp"><div class="form-text">Current: ${portalLogo || '(none)'}</div></div>
            <div class="col-md-4"><label class="form-label">Max Seats Per Booking</label><input type="number" min="1" name="max_seats_per_booking" class="form-control" value="${maxSeats}"></div>
            <div class="col-md-4"><label class="form-label">Booking Cut-Off Time (hours before departure)</label><input type="number" min="0" name="booking_cutoff_hours" class="form-control" value="${cutoffHours}"></div>
            <div class="col-md-4"><label class="form-label">Session Timeout (minutes)</label><input type="number" min="5" name="session_timeout_minutes" class="form-control" value="${sessionTimeout}"></div>
            <div class="col-12"><label class="form-label">Working Days</label><div class="d-flex flex-wrap gap-3">
                ${raw(WEEKDAY_OPTIONS.map((day) => `<div class="form-check"><input class="form-check-input" type="checkbox" name="working_days" value="${day}" id="wd${day}" ${workingDays.includes(day) ? 'checked' : ''}><label class="form-check-label" for="wd${day}">${day}</label></div>`).join(''))}
            </div></div>
            <div class="col-md-4"><label class="form-label">Password Policy - Minimum Length</label><input type="number" min="6" name="password_min_length" class="form-control" value="${passwordMinLength}"></div>
            <div class="col-md-4"><label class="form-label d-block">Notifications</label><div class="form-check form-switch mt-2"><input class="form-check-input" type="checkbox" role="switch" name="notifications_enabled" id="notif" ${notificationsEnabled === '1' ? 'checked' : ''}><label class="form-check-label" for="notif">Enable portal notifications</label></div></div>
            <div class="col-md-4"><label class="form-label d-block">Maintenance Mode</label><div class="form-check form-switch mt-2"><input class="form-check-input" type="checkbox" role="switch" name="maintenance_mode" id="maint" ${maintenanceMode === '1' ? 'checked' : ''}><label class="form-check-label" for="maint">Enable maintenance mode (blocks staff login)</label></div></div>
            <div class="col-12"><div class="alert alert-info small mb-0"><strong>Approval Hierarchy</strong> (fixed by design): General Manager &rarr; Resident Manager &rarr; HR Manager. Adjust who is currently able to approve from <a href="/admin/manager_availability">Manager Availability</a>.</div></div>
        </div>
        <button type="submit" class="btn btn-primary mt-3">Save Settings</button>
    </form>
</div></div>`;
}

export function registerAdminSettingsRoutes(router) {
    router.get('/admin/settings', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const body = await settingsBody({ errors: [], csrfToken: auth.user.csrf });
        return renderShellForRequest({ request, auth, pageTitle: 'Settings', path: '/admin/settings', bodyHtml: body });
    });

    router.post('/admin/settings', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const { user } = auth;

        const form = await request.formData();
        if (!verifyCsrf(user.csrf, form.get('csrf_token'))) return notFound();

        const errors = [];
        await setSetting('company_name', (form.get('company_name') || '').toString().trim());
        await setSetting('max_seats_per_booking', Math.max(1, Number(form.get('max_seats_per_booking')) || 4));
        await setSetting('booking_cutoff_hours', Math.max(0, Number(form.get('booking_cutoff_hours')) || 2));
        await setSetting('working_days', form.getAll('working_days').join(','));
        await setSetting('password_min_length', Math.max(6, Number(form.get('password_min_length')) || 8));
        await setSetting('session_timeout_minutes', Math.max(5, Number(form.get('session_timeout_minutes')) || 30));
        await setSetting('maintenance_mode', form.get('maintenance_mode') ? '1' : '0');
        await setSetting('notifications_enabled', form.get('notifications_enabled') ? '1' : '0');

        const logoFile = form.get('portal_logo');
        if (logoFile && logoFile.size > 0) {
            try {
                const url = await uploadPortalLogo(logoFile);
                await setSetting('portal_logo', url);
            } catch (err) {
                errors.push(err.message);
            }
        }

        resetSettingsCache();

        if (errors.length) {
            const body = await settingsBody({ errors, csrfToken: user.csrf });
            return renderShellForRequest({ request, auth, pageTitle: 'Settings', path: '/admin/settings', bodyHtml: body });
        }

        await logActivity(user.user_id, 'Updated portal settings', null, clientIp(request));
        return redirectTo('/admin/settings', { cookies: [auth.setCookie, flashSetCookie('success', 'Settings saved.')].filter(Boolean) });
    });
}
