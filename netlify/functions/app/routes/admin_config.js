// Port of admin/routes.php and admin/holidays.php - small CRUD pages,
// combined into one module since each is a handful of fields.

import { db, unwrap } from '../db.js';
import { requireRole } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDate } from '../format.js';
import { ROLE_ADMIN } from '../session.js';

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

// ---------------------------------------------------------------------
// Ferry routes
// ---------------------------------------------------------------------
async function routesPageBody(csrfToken) {
    const routes = unwrap(await db().from('ferry_routes').select('*').order('route_id'));
    const rowsHtml = routes
        .map(
            (r) => html`<tr>
            <td colspan="2">
                <form method="post" class="d-flex gap-2 align-items-center">
                    ${raw(csrfField(csrfToken))}
                    <input type="hidden" name="action" value="rename">
                    <input type="hidden" name="route_id" value="${r.route_id}">
                    <input type="text" name="route_name" class="form-control form-control-sm" value="${h(r.route_name)}" required>
                    <select name="direction" class="form-select form-select-sm" required style="max-width:11rem;">
                        <option value="Resort to City" ${r.direction === 'Resort to City' ? 'selected' : ''}>Resort to City</option>
                        <option value="City to Resort" ${r.direction === 'City to Resort' ? 'selected' : ''}>City to Resort</option>
                    </select>
                    <button type="submit" class="btn btn-sm btn-outline-primary text-nowrap">Save</button>
                </form>
            </td>
            <td><span class="badge ${r.status === 'active' ? 'bg-success' : 'bg-secondary'}">${r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span></td>
            <td class="text-nowrap">
                <form method="post" class="d-inline">${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="toggle_status"><input type="hidden" name="route_id" value="${r.route_id}"><button class="btn btn-sm btn-outline-secondary"><i class="bi bi-toggle2-on"></i></button></form>
                <form method="post" class="d-inline" data-confirm="Delete this route? Related schedules will also be removed.">${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="delete"><input type="hidden" name="route_id" value="${r.route_id}"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form>
            </td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-signpost-split"></i> Ferry Routes</h5>
<div class="row g-3">
    <div class="col-lg-5"><div class="card shadow-sm"><div class="card-header bg-white">Add Route</div><div class="card-body">
        <form method="post">
            ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="add">
            <div class="mb-3"><label class="form-label">Route Name</label><input type="text" name="route_name" class="form-control" required placeholder="e.g. Resort to City Ferry"></div>
            <div class="mb-3"><label class="form-label">Direction</label><select name="direction" class="form-select" required><option value="Resort to City">Resort to City</option><option value="City to Resort">City to Resort</option></select></div>
            <button class="btn btn-primary" type="submit">Add Route</button>
        </form>
    </div></div></div>
    <div class="col-lg-7"><div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
        <thead><tr><th colspan="2">Route Name / Direction</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${raw(rowsHtml)}</tbody>
    </table></div></div></div>
</div>`;
}

// ---------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------
async function holidaysPageBody(csrfToken) {
    const holidays = unwrap(await db().from('holidays').select('*').order('holiday_date'));
    const rowsHtml = holidays
        .map(
            (hd) => html`<tr>
            <td>${formatDate(hd.holiday_date)}</td><td>${hd.description ?? ''}</td>
            <td><form method="post" data-confirm="Remove this holiday?">${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="delete"><input type="hidden" name="holiday_id" value="${hd.holiday_id}"><button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button></form></td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-calendar-x"></i> Holiday Calendar</h5>
<div class="row g-3">
    <div class="col-lg-5"><div class="card shadow-sm"><div class="card-header bg-white">Add Holiday</div><div class="card-body">
        <form method="post">
            ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="add">
            <div class="mb-3"><label class="form-label">Date</label><input type="date" name="holiday_date" class="form-control" required></div>
            <div class="mb-3"><label class="form-label">Description</label><input type="text" name="description" class="form-control" placeholder="e.g. New Year's Day"></div>
            <button class="btn btn-primary" type="submit">Add Holiday</button>
        </form>
    </div></div></div>
    <div class="col-lg-7"><div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
        <thead><tr><th>Date</th><th>Description</th><th>Actions</th></tr></thead>
        <tbody>${raw(rowsHtml || '<tr><td colspan="3" class="text-center text-muted py-3">No holidays configured.</td></tr>')}</tbody>
    </table></div></div></div>
</div>`;
}

export function registerAdminConfigRoutes(router) {
    router.get('/admin/routes', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const body = await routesPageBody(auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'Ferry Routes', path: '/admin/routes', bodyHtml: body });
    });

    router.post('/admin/routes', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const form = await readFormBody(request);
        if (!verifyCsrf(auth.user.csrf, form.csrf_token)) return notFound();

        if (form.action === 'add' && form.route_name?.trim() && ['Resort to City', 'City to Resort'].includes(form.direction)) {
            unwrap(await db().from('ferry_routes').insert({ route_name: form.route_name.trim(), direction: form.direction }));
            return redirectTo('/admin/routes', { cookies: [auth.setCookie, flashSetCookie('success', 'Route added.')].filter(Boolean) });
        }
        if (form.action === 'rename') {
            const routeId = Number(form.route_id);
            const routeName = (form.route_name || '').trim();
            if (!routeId || !routeName || !['Resort to City', 'City to Resort'].includes(form.direction)) {
                return redirectTo('/admin/routes', { cookies: [auth.setCookie, flashSetCookie('error', 'Route name and a valid direction are required.')].filter(Boolean) });
            }
            unwrap(await db().from('ferry_routes').update({ route_name: routeName, direction: form.direction }).eq('route_id', routeId));
            return redirectTo('/admin/routes', { cookies: [auth.setCookie, flashSetCookie('success', 'Route updated.')].filter(Boolean) });
        }
        if (form.action === 'toggle_status') {
            const rows = unwrap(await db().from('ferry_routes').select('status').eq('route_id', Number(form.route_id)).limit(1));
            if (rows.length) unwrap(await db().from('ferry_routes').update({ status: rows[0].status === 'active' ? 'inactive' : 'active' }).eq('route_id', Number(form.route_id)));
            return redirectTo('/admin/routes', { cookies: [auth.setCookie, flashSetCookie('success', 'Route status updated.')].filter(Boolean) });
        }
        if (form.action === 'delete') {
            unwrap(await db().from('ferry_routes').delete().eq('route_id', Number(form.route_id)));
            return redirectTo('/admin/routes', { cookies: [auth.setCookie, flashSetCookie('success', 'Route deleted.')].filter(Boolean) });
        }
        return redirectTo('/admin/routes', { cookies: [auth.setCookie] });
    });

    router.get('/admin/holidays', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const body = await holidaysPageBody(auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'Holidays', path: '/admin/holidays', bodyHtml: body });
    });

    router.post('/admin/holidays', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const form = await readFormBody(request);
        if (!verifyCsrf(auth.user.csrf, form.csrf_token)) return notFound();

        if (form.action === 'add') {
            try {
                unwrap(await db().from('holidays').insert({ holiday_date: form.holiday_date, description: (form.description || '').trim() || null }));
                return redirectTo('/admin/holidays', { cookies: [auth.setCookie, flashSetCookie('success', 'Holiday added.')].filter(Boolean) });
            } catch (err) {
                return redirectTo('/admin/holidays', { cookies: [auth.setCookie, flashSetCookie('error', 'That date is already marked as a holiday.')].filter(Boolean) });
            }
        }
        if (form.action === 'delete') {
            unwrap(await db().from('holidays').delete().eq('holiday_id', Number(form.holiday_id)));
            return redirectTo('/admin/holidays', { cookies: [auth.setCookie, flashSetCookie('success', 'Holiday removed.')].filter(Boolean) });
        }
        return redirectTo('/admin/holidays', { cookies: [auth.setCookie] });
    });
}
