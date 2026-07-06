// Role & Permission Management: create/edit/delete custom roles, assign
// permissions to any role (system role permissions ARE editable, only
// their name/existence is protected), copy permissions between roles,
// and reset a system role back to its shipped default.
//
// Deliberately guarded by requireRole(ROLE_ADMIN) rather than
// requirePermission() - a permission-management surface that itself
// checked a permission could be used to self-escalate (grant your own
// role every permission), so this one meta-surface stays hardcoded to
// the literal Administrator role, matching the spec's own "only
// Administrators can manage user permissions" rule.

import { db, unwrap } from '../db.js';
import { requireRole } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getPermissionCatalog, recordPermissionAudit } from '../permissions.js';
import { DEFAULT_ROLE_PERMISSIONS } from '../permissions/defaultRolePermissions.js';
import { clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { ROLE_ADMIN } from '../session.js';

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) {
        if (out[key] !== undefined) {
            out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
        } else {
            out[key] = value;
        }
    }
    return out;
}

function asArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

async function rolesWithUserCounts() {
    const roles = unwrap(await db().from('roles').select('*').order('role_id'));
    const counts = unwrap(await db().from('users').select('role_id'));
    const countByRole = new Map();
    for (const row of counts) countByRole.set(row.role_id, (countByRole.get(row.role_id) || 0) + 1);
    return roles.map((r) => ({ ...r, userCount: countByRole.get(r.role_id) || 0 }));
}

function groupCatalogByCategory(catalog) {
    const byCategory = new Map();
    for (const p of catalog) {
        if (!byCategory.has(p.category)) byCategory.set(p.category, { label: p.category_label, permissions: [] });
        byCategory.get(p.category).permissions.push(p);
    }
    return byCategory;
}

function permissionMatrixHtml(catalog, grantedKeys, formIdPrefix) {
    const byCategory = groupCatalogByCategory(catalog);
    const granted = new Set(grantedKeys);
    let out = '';
    for (const [category, { label, permissions }] of byCategory) {
        const moduleAccess = permissions.find((p) => p.is_module_access);
        const finePerms = permissions.filter((p) => !p.is_module_access);
        out += `<div class="col-md-6 col-lg-4"><div class="border rounded p-2 mb-2 h-100">`;
        if (moduleAccess) {
            out += `<div class="form-check mb-1 border-bottom pb-1">
                <input class="form-check-input" type="checkbox" name="${formIdPrefix}_perm" value="${h(moduleAccess.permission_key)}" id="${formIdPrefix}_${h(moduleAccess.permission_key)}" ${granted.has(moduleAccess.permission_key) ? 'checked' : ''}>
                <label class="form-check-label fw-bold" for="${formIdPrefix}_${h(moduleAccess.permission_key)}">${h(label)}</label>
            </div>`;
        } else {
            out += `<div class="fw-bold mb-1">${h(label)}</div>`;
        }
        for (const p of finePerms) {
            out += `<div class="form-check">
                <input class="form-check-input" type="checkbox" name="${formIdPrefix}_perm" value="${h(p.permission_key)}" id="${formIdPrefix}_${h(p.permission_key)}" ${granted.has(p.permission_key) ? 'checked' : ''}>
                <label class="form-check-label small" for="${formIdPrefix}_${h(p.permission_key)}">${h(p.label)}</label>
            </div>`;
        }
        out += `</div></div>`;
    }
    return out;
}

async function rolesPageBody(csrfToken) {
    const [roles, catalog] = await Promise.all([rolesWithUserCounts(), getPermissionCatalog()]);
    const rolePermRows = unwrap(await db().from('role_permissions').select('role_id, permission_id'));
    const permKeyById = new Map(catalog.map((p) => [p.permission_id, p.permission_key]));
    const grantedByRole = new Map();
    for (const row of rolePermRows) {
        const key = permKeyById.get(row.permission_id);
        if (!key) continue;
        if (!grantedByRole.has(row.role_id)) grantedByRole.set(row.role_id, []);
        grantedByRole.get(row.role_id).push(key);
    }

    const roleOptionsHtml = roles.map((r) => `<option value="${r.role_id}">${h(r.role_name)}</option>`).join('');

    const rowsHtml = roles
        .map((r) => {
            const granted = grantedByRole.get(r.role_id) || [];
            return html`<tr>
            <td>${r.role_name}${r.is_system ? html` <span class="badge bg-secondary">System</span>` : ''}</td>
            <td class="text-muted small">${r.description || ''}</td>
            <td>${r.userCount}</td>
            <td class="text-nowrap">
                <button type="button" class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#permsModal${r.role_id}">
                    <i class="bi bi-shield-check"></i> Permissions
                </button>
                ${!r.is_system
                    ? html`<form method="post" class="d-inline" onsubmit="return confirm('Delete this role? This cannot be undone.');">
                        ${raw(csrfField(csrfToken))}
                        <input type="hidden" name="action" value="delete_role">
                        <input type="hidden" name="role_id" value="${r.role_id}">
                        <button type="submit" class="btn btn-sm btn-outline-danger" ${r.userCount > 0 ? 'disabled title="Cannot delete - users are assigned to this role"' : ''}><i class="bi bi-trash"></i></button>
                    </form>`
                    : ''}
            </td>
        </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    const modalsHtml = roles
        .map((r) => {
            const granted = grantedByRole.get(r.role_id) || [];
            return `<div class="modal fade" id="permsModal${r.role_id}" tabindex="-1">
  <div class="modal-dialog modal-xl">
    <div class="modal-content">
      <form method="post">
        ${csrfField(csrfToken)}
        <input type="hidden" name="action" value="set_permissions">
        <input type="hidden" name="role_id" value="${r.role_id}">
        <div class="modal-header">
          <h5 class="modal-title">Permissions - ${h(r.role_name)}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div class="row g-2">${permissionMatrixHtml(catalog, granted, `role${r.role_id}`)}</div>
        </div>
        <div class="modal-footer justify-content-between">
          ${r.is_system
              ? `<button type="submit" form="resetForm${r.role_id}" class="btn btn-outline-secondary">Reset to Default</button>`
              : '<span></span>'}
          <div>
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Permissions</button>
          </div>
        </div>
      </form>
      <form method="post" id="resetForm${r.role_id}">
          ${csrfField(csrfToken)}
          <input type="hidden" name="action" value="reset_to_default">
          <input type="hidden" name="role_id" value="${r.role_id}">
      </form>
    </div>
  </div>
</div>`;
        })
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-shield-lock"></i> Roles &amp; Permissions</h5>
<p class="text-muted">The 8 built-in roles can have their permissions edited freely, but cannot be renamed or deleted. Create custom roles below for any other access pattern - they can be fully renamed, re-permissioned, and deleted.</p>
<div class="row g-3 mb-3">
    <div class="col-lg-4"><div class="card shadow-sm"><div class="card-header bg-white">Create Custom Role</div><div class="card-body">
        <form method="post">
            ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="create_role">
            <div class="mb-2"><label class="form-label">Role Name</label><input type="text" name="role_name" class="form-control" required></div>
            <div class="mb-2"><label class="form-label">Description</label><input type="text" name="description" class="form-control"></div>
            <button class="btn btn-primary" type="submit">Create Role</button>
        </form>
    </div></div></div>
    <div class="col-lg-8"><div class="card shadow-sm"><div class="card-header bg-white">Copy Permissions Between Roles</div><div class="card-body">
        <form method="post" class="row g-2 align-items-end">
            ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="copy_permissions">
            <div class="col-md-5"><label class="form-label">From</label><select name="from_role_id" class="form-select" required>${raw(roleOptionsHtml)}</select></div>
            <div class="col-md-5"><label class="form-label">To</label><select name="to_role_id" class="form-select" required>${raw(roleOptionsHtml)}</select></div>
            <div class="col-md-2"><button class="btn btn-outline-primary w-100" type="submit">Copy</button></div>
        </form>
        <p class="text-muted small mb-0 mt-2">Replaces the target role's entire permission set with the source role's.</p>
    </div></div></div>
</div>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Role</th><th>Description</th><th>Users</th><th>Actions</th></tr></thead>
    <tbody>${raw(rowsHtml)}</tbody>
</table></div></div>
${raw(modalsHtml)}`;
}

export function registerAdminPermissionsRoutes(router) {
    router.get('/admin/roles', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const body = await rolesPageBody(auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'Roles & Permissions', path: '/admin/roles', bodyHtml: body });
    });

    router.post('/admin/roles', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();
        const ip = clientIp(request);

        if (form.action === 'create_role') {
            const roleName = (form.role_name || '').trim();
            const description = (form.description || '').trim() || null;
            if (!roleName) {
                return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('error', 'Role name is required.')].filter(Boolean) });
            }
            try {
                const inserted = unwrap(await db().from('roles').insert({ role_name: roleName, description, is_system: false }).select('role_id'));
                await recordPermissionAudit({
                    actorUserId: user.user_id, targetType: 'role', targetRoleId: inserted[0]?.role_id,
                    action: 'role_created', newValue: roleName, ipAddress: ip,
                });
                return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('success', `Role '${roleName}' created.`)].filter(Boolean) });
            } catch (err) {
                return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('error', 'A role with that name already exists.')].filter(Boolean) });
            }
        }

        if (form.action === 'delete_role') {
            const roleId = Number(form.role_id);
            const rows = unwrap(await db().from('roles').select('role_name, is_system').eq('role_id', roleId).limit(1));
            if (!rows.length) return redirectTo('/admin/roles', { cookies: [auth.setCookie] });
            if (rows[0].is_system) {
                return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('error', 'System roles cannot be deleted.')].filter(Boolean) });
            }
            const userCountRows = unwrap(await db().from('users').select('user_id').eq('role_id', roleId).limit(1));
            if (userCountRows.length) {
                return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('error', 'Cannot delete - users are still assigned to this role.')].filter(Boolean) });
            }
            try {
                unwrap(await db().from('roles').delete().eq('role_id', roleId));
            } catch (err) {
                return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('error', `Could not delete role: ${err.message}`)].filter(Boolean) });
            }
            await recordPermissionAudit({
                actorUserId: user.user_id, targetType: 'role', targetRoleId: null,
                action: 'role_deleted', previousValue: rows[0].role_name, ipAddress: ip,
            });
            return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('success', 'Role deleted.')].filter(Boolean) });
        }

        if (form.action === 'set_permissions') {
            const roleId = Number(form.role_id);
            const submittedKeys = asArray(form[`role${roleId}_perm`]);
            const catalog = await getPermissionCatalog();
            const validKeys = new Set(catalog.map((p) => p.permission_key));
            const permIdByKey = new Map(catalog.map((p) => [p.permission_key, p.permission_id]));
            const beforeRows = unwrap(await db().from('role_permissions').select('permission_id').eq('role_id', roleId));
            const permKeyById = new Map(catalog.map((p) => [p.permission_id, p.permission_key]));
            const beforeKeys = beforeRows.map((r) => permKeyById.get(r.permission_id)).filter(Boolean);

            const finalKeys = submittedKeys.filter((k) => validKeys.has(k));
            unwrap(await db().from('role_permissions').delete().eq('role_id', roleId));
            if (finalKeys.length) {
                unwrap(await db().from('role_permissions').insert(finalKeys.map((k) => ({ role_id: roleId, permission_id: permIdByKey.get(k) }))));
            }
            await recordPermissionAudit({
                actorUserId: user.user_id, targetType: 'role', targetRoleId: roleId,
                action: 'permission_granted', beforeSnapshot: beforeKeys, afterSnapshot: finalKeys, ipAddress: ip,
            });
            return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('success', 'Permissions updated.')].filter(Boolean) });
        }

        if (form.action === 'copy_permissions') {
            const fromRoleId = Number(form.from_role_id);
            const toRoleId = Number(form.to_role_id);
            if (!fromRoleId || !toRoleId || fromRoleId === toRoleId) {
                return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('error', 'Choose two different roles.')].filter(Boolean) });
            }
            const toRows = unwrap(await db().from('roles').select('is_system').eq('role_id', toRoleId).limit(1));
            const sourceRows = unwrap(await db().from('role_permissions').select('permission_id').eq('role_id', fromRoleId));
            const beforeRows = unwrap(await db().from('role_permissions').select('permission_id').eq('role_id', toRoleId));
            const catalog = await getPermissionCatalog();
            const permKeyById = new Map(catalog.map((p) => [p.permission_id, p.permission_key]));

            unwrap(await db().from('role_permissions').delete().eq('role_id', toRoleId));
            if (sourceRows.length) {
                unwrap(await db().from('role_permissions').insert(sourceRows.map((r) => ({ role_id: toRoleId, permission_id: r.permission_id }))));
            }
            await recordPermissionAudit({
                actorUserId: user.user_id, targetType: 'role', targetRoleId: toRoleId,
                action: 'permissions_copied',
                beforeSnapshot: beforeRows.map((r) => permKeyById.get(r.permission_id)).filter(Boolean),
                afterSnapshot: sourceRows.map((r) => permKeyById.get(r.permission_id)).filter(Boolean),
                previousValue: String(toRoleId), newValue: String(fromRoleId), ipAddress: ip,
            });
            return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('success', 'Permissions copied.')].filter(Boolean) });
        }

        if (form.action === 'reset_to_default') {
            const roleId = Number(form.role_id);
            const roleRows = unwrap(await db().from('roles').select('role_name, is_system').eq('role_id', roleId).limit(1));
            if (!roleRows.length || !roleRows[0].is_system) {
                return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('error', 'Only built-in roles have a default to reset to.')].filter(Boolean) });
            }
            const defaultKeys = DEFAULT_ROLE_PERMISSIONS[roleRows[0].role_name] || [];
            const catalog = await getPermissionCatalog();
            const permIdByKey = new Map(catalog.map((p) => [p.permission_key, p.permission_id]));
            const permKeyById = new Map(catalog.map((p) => [p.permission_id, p.permission_key]));
            const beforeRows = unwrap(await db().from('role_permissions').select('permission_id').eq('role_id', roleId));

            unwrap(await db().from('role_permissions').delete().eq('role_id', roleId));
            const insertRows = defaultKeys.filter((k) => permIdByKey.has(k)).map((k) => ({ role_id: roleId, permission_id: permIdByKey.get(k) }));
            if (insertRows.length) unwrap(await db().from('role_permissions').insert(insertRows));

            await recordPermissionAudit({
                actorUserId: user.user_id, targetType: 'role', targetRoleId: roleId,
                action: 'role_reset_to_default',
                beforeSnapshot: beforeRows.map((r) => permKeyById.get(r.permission_id)).filter(Boolean),
                afterSnapshot: defaultKeys, ipAddress: ip,
            });
            return redirectTo('/admin/roles', { cookies: [auth.setCookie, flashSetCookie('success', `${roleRows[0].role_name} reset to its default permissions.`)].filter(Boolean) });
        }

        return redirectTo('/admin/roles', { cookies: [auth.setCookie] });
    });
}
