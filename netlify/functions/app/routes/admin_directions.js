// Direction Management: full CRUD for the "direction" concept
// (previously a hardcoded 2-value enum) - name, description, resort
// association, active/inactive, display order. Mirrors
// admin_departments.js's add/edit/toggle_status pattern, plus what
// departments doesn't need: search/filter, a dependents-check before
// delete, and display-order.
//
// ferry_routes.direction (the plain-text column every other part of
// the app already reads for display) is kept automatically in sync by
// a database trigger (see supabase/migrations/0010_direction_management.sql)
// whenever a direction is renamed here - no other route file needs to
// change for existing reads to reflect an edit.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { getAllResorts } from '../refData.js';

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

async function fetchFilteredDirections({ search, resortFilter, statusFilter }) {
    let query = db().from('directions').select('*, resorts(resort_name)').order('display_order').order('name');
    if (resortFilter) query = query.eq('resort_id', resortFilter);
    if (['active', 'inactive'].includes(statusFilter)) query = query.eq('status', statusFilter);
    let directions = unwrap(await query);

    if (search) {
        const needle = search.toLowerCase();
        directions = directions.filter(
            (d) => d.name.toLowerCase().includes(needle) || (d.description ?? '').toLowerCase().includes(needle)
        );
    }
    return directions;
}

async function directionsPageBody({ search, resortFilter, statusFilter, csrfToken, errors }) {
    const directions = await fetchFilteredDirections({ search, resortFilter, statusFilter });
    const resorts = await getAllResorts();

    const resortOptions = (selectedId) =>
        `<option value="">-- Both Resorts --</option>` +
        resorts.map((r) => `<option value="${r.resort_id}" ${selectedId === r.resort_id ? 'selected' : ''}>${h(r.resort_name)}</option>`).join('');

    const rowsHtml = directions
        .map(
            (d) => html`<tr>
            <td>
                <form method="post" class="d-flex gap-2 align-items-center flex-wrap">
                    ${raw(csrfField(csrfToken))}
                    <input type="hidden" name="action" value="edit">
                    <input type="hidden" name="direction_id" value="${d.direction_id}">
                    <input type="text" name="name" class="form-control form-control-sm" style="max-width:12rem;" value="${h(d.name)}" required>
                    <input type="text" name="description" class="form-control form-control-sm" style="max-width:14rem;" value="${h(d.description ?? '')}" placeholder="Description (optional)">
                    <select name="resort_id" class="form-select form-select-sm" style="max-width:10rem;">${raw(resortOptions(d.resort_id))}</select>
                    <input type="number" name="display_order" class="form-control form-control-sm" style="max-width:6rem;" min="0" value="${d.display_order}" title="Display Order">
                    <button type="submit" class="btn btn-sm btn-outline-primary text-nowrap">Save</button>
                </form>
            </td>
            <td><span class="badge ${d.status === 'active' ? 'bg-success' : 'bg-secondary'}">${d.status.charAt(0).toUpperCase() + d.status.slice(1)}</span></td>
            <td class="text-nowrap">
                <form method="post" class="d-inline">
                    ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="toggle_status"><input type="hidden" name="direction_id" value="${d.direction_id}">
                    <button class="btn btn-sm btn-outline-secondary"><i class="bi bi-toggle2-${d.status === 'active' ? 'on' : 'off'}"></i> ${d.status === 'active' ? 'Deactivate' : 'Activate'}</button>
                </form>
                <form method="post" class="d-inline" data-confirm="Delete this direction? This only works if no ferry route currently uses it.">
                    ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="delete"><input type="hidden" name="direction_id" value="${d.direction_id}">
                    <button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button>
                </form>
            </td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-arrow-left-right"></i> Direction Management</h5>
<p class="text-muted">Directions power the Direction dropdown on the Ferry Routes page - renaming one here automatically updates every route already using it.</p>
${errors.length ? html`<div class="alert alert-danger">${raw(errors.map((e) => `${e}<br>`).join(''))}</div>` : ''}
<div class="row g-3">
    <div class="col-lg-4"><div class="card shadow-sm"><div class="card-header bg-white">Add Direction</div><div class="card-body">
        <form method="post">
            ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="add">
            <div class="mb-3"><label class="form-label">Direction Name *</label><input type="text" name="name" class="form-control" required placeholder="e.g. Resort to City"></div>
            <div class="mb-3"><label class="form-label">Description (optional)</label><input type="text" name="description" class="form-control"></div>
            <div class="mb-3"><label class="form-label">Resort</label><select name="resort_id" class="form-select">${raw(resortOptions(null))}</select></div>
            <div class="mb-3"><label class="form-label">Display Order</label><input type="number" name="display_order" class="form-control" min="0" value="0"></div>
            <button class="btn btn-primary" type="submit">Add Direction</button>
        </form>
    </div></div></div>
    <div class="col-lg-8">
        <div class="card shadow-sm mb-3"><div class="card-body">
            <form method="get" class="row g-2">
                <div class="col-md-5"><input type="text" name="search" class="form-control" placeholder="Search name or description" value="${search}"></div>
                <div class="col-md-3"><select name="resort" class="form-select"><option value="0">All Resorts</option>${raw(resorts.map((r) => `<option value="${r.resort_id}" ${resortFilter == r.resort_id ? 'selected' : ''}>${h(r.resort_name)}</option>`).join(''))}</select></div>
                <div class="col-md-2"><select name="status" class="form-select"><option value="">All</option><option value="active" ${statusFilter === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${statusFilter === 'inactive' ? 'selected' : ''}>Inactive</option></select></div>
                <div class="col-md-2"><button class="btn btn-outline-primary btn-sm w-100" type="submit"><i class="bi bi-search"></i> Filter</button></div>
            </form>
        </div></div>
        <div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
            <thead><tr><th>Name / Description / Resort / Order</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${raw(rowsHtml || '<tr><td colspan="3" class="text-center text-muted py-3">No directions found.</td></tr>')}</tbody>
        </table></div></div>
    </div>
</div>`;
}

export function registerAdminDirectionsRoutes(router) {
    router.get('/admin/directions', async (request) => {
        const auth = await requirePermission(request, 'schedule_management.manage_directions', { pageTitle: 'Direction Management' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const body = await directionsPageBody({
            search: url.searchParams.get('search') || '',
            resortFilter: Number(url.searchParams.get('resort') || 0),
            statusFilter: url.searchParams.get('status') || '',
            csrfToken: auth.user.csrf,
            errors: [],
        });
        return renderShellForRequest({ request, auth, pageTitle: 'Direction Management', path: '/admin/directions', bodyHtml: body });
    });

    router.post('/admin/directions', async (request) => {
        const auth = await requirePermission(request, 'schedule_management.manage_directions', { pageTitle: 'Direction Management' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const resortId = form.resort_id ? Number(form.resort_id) : null;
        const displayOrder = Math.max(0, Number(form.display_order) || 0);
        const description = (form.description || '').trim() || null;

        if (form.action === 'add') {
            const name = (form.name || '').trim();
            if (!name) {
                return redirectTo('/admin/directions', { cookies: [auth.setCookie, flashSetCookie('error', 'Direction name is required.')].filter(Boolean) });
            }
            try {
                unwrap(await db().from('directions').insert({ name, description, resort_id: resortId, display_order: displayOrder }));
                await logActivity(user.user_id, 'Created direction', `name=${name}`, clientIp(request));
                return redirectTo('/admin/directions', { cookies: [auth.setCookie, flashSetCookie('success', 'Direction added.')].filter(Boolean) });
            } catch (err) {
                return redirectTo('/admin/directions', { cookies: [auth.setCookie, flashSetCookie('error', 'A direction with that name already exists.')].filter(Boolean) });
            }
        }

        if (form.action === 'edit') {
            const directionId = Number(form.direction_id);
            const name = (form.name || '').trim();
            if (!directionId || !name) {
                return redirectTo('/admin/directions', { cookies: [auth.setCookie, flashSetCookie('error', 'Direction name is required.')].filter(Boolean) });
            }
            try {
                unwrap(
                    await db()
                        .from('directions')
                        .update({ name, description, resort_id: resortId, display_order: displayOrder })
                        .eq('direction_id', directionId)
                );
                await logActivity(user.user_id, 'Updated direction', `direction_id=${directionId}, name=${name}`, clientIp(request));
                return redirectTo('/admin/directions', { cookies: [auth.setCookie, flashSetCookie('success', 'Direction updated.')].filter(Boolean) });
            } catch (err) {
                return redirectTo('/admin/directions', { cookies: [auth.setCookie, flashSetCookie('error', 'A direction with that name already exists.')].filter(Boolean) });
            }
        }

        if (form.action === 'toggle_status') {
            const directionId = Number(form.direction_id);
            const rows = unwrap(await db().from('directions').select('status').eq('direction_id', directionId).limit(1));
            if (rows.length) {
                const newStatus = rows[0].status === 'active' ? 'inactive' : 'active';
                unwrap(await db().from('directions').update({ status: newStatus }).eq('direction_id', directionId));
                await logActivity(user.user_id, newStatus === 'active' ? 'Activated direction' : 'Deactivated direction', `direction_id=${directionId}`, clientIp(request));
            }
            return redirectTo('/admin/directions', { cookies: [auth.setCookie, flashSetCookie('success', 'Direction status updated.')].filter(Boolean) });
        }

        if (form.action === 'delete') {
            const directionId = Number(form.direction_id);
            const routesUsingIt = unwrap(await db().from('ferry_routes').select('route_id').eq('direction_id', directionId));
            if (routesUsingIt.length > 0) {
                return redirectTo('/admin/directions', {
                    cookies: [auth.setCookie, flashSetCookie('error', `Cannot delete - ${routesUsingIt.length} ferry route(s) currently use this direction.`)].filter(Boolean),
                });
            }
            unwrap(await db().from('directions').delete().eq('direction_id', directionId));
            await logActivity(user.user_id, 'Deleted direction', `direction_id=${directionId}`, clientIp(request));
            return redirectTo('/admin/directions', { cookies: [auth.setCookie, flashSetCookie('success', 'Direction deleted.')].filter(Boolean) });
        }

        return redirectTo('/admin/directions', { cookies: [auth.setCookie] });
    });
}
