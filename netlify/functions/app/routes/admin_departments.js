// Department CRUD: add / edit-name / activate-deactivate. Deliberately no
// delete action (departments are referenced by users, bookings, and
// department_approval_config across both resorts - deactivating is the
// safe equivalent). A newly-added department has no
// department_approval_config rows yet for either resort; admin_department_
// approval.js already tolerates a missing config row via its fallback
// default and creates one on first save via upsert, so nothing extra is
// needed here.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

async function departmentsPageBody(csrfToken) {
    const departments = unwrap(await db().from('departments').select('*').order('department_name'));

    const rowsHtml = departments
        .map(
            (d) => html`<tr>
            <td>
                <form method="post" class="d-flex gap-2 align-items-center">
                    ${raw(csrfField(csrfToken))}
                    <input type="hidden" name="action" value="rename">
                    <input type="hidden" name="department_id" value="${d.department_id}">
                    <input type="text" name="department_name" class="form-control form-control-sm" value="${h(d.department_name)}" required>
                    <button type="submit" class="btn btn-sm btn-outline-primary text-nowrap">Save</button>
                </form>
            </td>
            <td><span class="badge ${d.status === 'active' ? 'bg-success' : 'bg-secondary'}">${d.status.charAt(0).toUpperCase() + d.status.slice(1)}</span></td>
            <td class="text-nowrap">
                <form method="post" class="d-inline">
                    ${raw(csrfField(csrfToken))}
                    <input type="hidden" name="action" value="toggle_status">
                    <input type="hidden" name="department_id" value="${d.department_id}">
                    <button class="btn btn-sm btn-outline-secondary"><i class="bi bi-toggle2-${d.status === 'active' ? 'on' : 'off'}"></i> ${d.status === 'active' ? 'Deactivate' : 'Activate'}</button>
                </form>
            </td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-diagram-2"></i> Departments</h5>
<p class="text-muted">Departments are shared functional definitions used at every resort - each resort configures its own approval hierarchy for the same department independently (see Department Approval Configuration). Deactivating a department hides it from new user assignments; it does not delete any history.</p>
<div class="row g-3">
    <div class="col-lg-4"><div class="card shadow-sm"><div class="card-header bg-white">Add Department</div><div class="card-body">
        <form method="post">
            ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="add">
            <div class="mb-3"><label class="form-label">Department Name</label><input type="text" name="department_name" class="form-control" required placeholder="e.g. Guest Relations"></div>
            <button class="btn btn-primary" type="submit">Add Department</button>
        </form>
    </div></div></div>
    <div class="col-lg-8"><div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
        <thead><tr><th>Department Name</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${raw(rowsHtml || '<tr><td colspan="3" class="text-center text-muted py-3">No departments configured.</td></tr>')}</tbody>
    </table></div></div></div>
</div>`;
}

export function registerAdminDepartmentsRoutes(router) {
    router.get('/admin/departments', async (request) => {
        const auth = await requirePermission(request, 'user_management.manage_departments', { pageTitle: 'Departments' });
        if (auth.response) return auth.response;
        const body = await departmentsPageBody(auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'Departments', path: '/admin/departments', bodyHtml: body });
    });

    router.post('/admin/departments', async (request) => {
        const auth = await requirePermission(request, 'user_management.manage_departments', { pageTitle: 'Departments' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        if (form.action === 'add') {
            const name = (form.department_name || '').trim();
            if (!name) {
                return redirectTo('/admin/departments', { cookies: [auth.setCookie, flashSetCookie('error', 'Department name is required.')].filter(Boolean) });
            }
            try {
                unwrap(await db().from('departments').insert({ department_name: name }));
                await logActivity(user.user_id, 'Added department', `department_name=${name}`, clientIp(request));
                return redirectTo('/admin/departments', { cookies: [auth.setCookie, flashSetCookie('success', 'Department added.')].filter(Boolean) });
            } catch (err) {
                return redirectTo('/admin/departments', { cookies: [auth.setCookie, flashSetCookie('error', 'A department with that name already exists.')].filter(Boolean) });
            }
        }

        if (form.action === 'rename') {
            const departmentId = Number(form.department_id);
            const name = (form.department_name || '').trim();
            if (!name) {
                return redirectTo('/admin/departments', { cookies: [auth.setCookie, flashSetCookie('error', 'Department name is required.')].filter(Boolean) });
            }
            try {
                unwrap(await db().from('departments').update({ department_name: name }).eq('department_id', departmentId));
                await logActivity(user.user_id, 'Renamed department', `department_id=${departmentId}, department_name=${name}`, clientIp(request));
                return redirectTo('/admin/departments', { cookies: [auth.setCookie, flashSetCookie('success', 'Department renamed.')].filter(Boolean) });
            } catch (err) {
                return redirectTo('/admin/departments', { cookies: [auth.setCookie, flashSetCookie('error', 'A department with that name already exists.')].filter(Boolean) });
            }
        }

        if (form.action === 'toggle_status') {
            const departmentId = Number(form.department_id);
            const rows = unwrap(await db().from('departments').select('status').eq('department_id', departmentId).limit(1));
            if (rows.length) {
                const newStatus = rows[0].status === 'active' ? 'inactive' : 'active';
                unwrap(await db().from('departments').update({ status: newStatus }).eq('department_id', departmentId));
                await logActivity(user.user_id, 'Updated department status', `department_id=${departmentId}, status=${newStatus}`, clientIp(request));
            }
            return redirectTo('/admin/departments', { cookies: [auth.setCookie, flashSetCookie('success', 'Department status updated.')].filter(Boolean) });
        }

        return redirectTo('/admin/departments', { cookies: [auth.setCookie] });
    });
}
