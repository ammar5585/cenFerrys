// Per-user Permissions tab: shows a user's effective permissions (role
// defaults, clearly labeled as such) with per-permission grant/revoke
// overrides and a bulk reset-to-role-default action. Lives in its own
// file rather than admin.js (already large) - mirrors admin.js's
// /admin/users list via a query-string user_id, matching this
// codebase's router (exact-path matching only, no path params - see
// router.js).
//
// Same hardcoded requireRole(ROLE_ADMIN) guard as admin_permissions.js,
// for the same anti-escalation reason.

import { db, unwrap } from '../db.js';
import { requireRole } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getPermissionCatalog, getEffectivePermissions, recordPermissionAudit } from '../permissions.js';
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

function groupCatalogByCategory(catalog) {
    const byCategory = new Map();
    for (const p of catalog) {
        if (!byCategory.has(p.category)) byCategory.set(p.category, { label: p.category_label, permissions: [] });
        byCategory.get(p.category).permissions.push(p);
    }
    return byCategory;
}

async function userPermissionsPageBody(targetUserId, csrfToken) {
    const userRows = unwrap(
        await db().from('users').select('user_id, full_name, employee_id, role_id, roles(role_name)').eq('user_id', targetUserId).limit(1)
    );
    if (!userRows.length) return null;
    const targetUser = userRows[0];

    const [catalog, roleGrantRows, overrideRows] = await Promise.all([
        getPermissionCatalog(),
        db().from('role_permissions').select('permission_id').eq('role_id', targetUser.role_id).then(unwrap),
        db().from('user_permission_overrides').select('permission_id, granted').eq('user_id', targetUserId).then(unwrap),
    ]);

    const roleGrantedIds = new Set(roleGrantRows.map((r) => r.permission_id));
    const overrideByPermId = new Map(overrideRows.map((r) => [r.permission_id, r.granted]));

    const byCategory = groupCatalogByCategory(catalog);
    let matrixHtml = '';
    for (const [, { label, permissions }] of byCategory) {
        matrixHtml += `<div class="col-md-6 col-lg-4"><div class="border rounded p-2 mb-2 h-100">
            <div class="fw-bold mb-1">${h(label)}</div>`;
        for (const p of permissions) {
            const fromRole = roleGrantedIds.has(p.permission_id);
            const override = overrideByPermId.has(p.permission_id) ? overrideByPermId.get(p.permission_id) : null;
            const effective = override === null ? fromRole : override;
            const tag = override === null
                ? `<span class="text-muted small">(from role)</span>`
                : override
                    ? `<span class="badge bg-success">granted (override)</span>`
                    : `<span class="badge bg-danger">revoked (override)</span>`;
            matrixHtml += `<div class="form-check d-flex align-items-center gap-2">
                <input class="form-check-input" type="checkbox" name="perm" value="${h(p.permission_key)}" id="up_${h(p.permission_key)}" ${effective ? 'checked' : ''}>
                <label class="form-check-label small flex-grow-1" for="up_${h(p.permission_key)}">${h(p.label)}</label>
                ${tag}
            </div>`;
        }
        matrixHtml += `</div></div>`;
    }

    return html`
<h5 class="mb-1"><i class="bi bi-person-lock"></i> Permissions - ${targetUser.full_name}</h5>
<p class="text-muted">Employee ID ${targetUser.employee_id} - Role: ${targetUser.roles?.role_name || 'Unknown'}</p>
<form method="post">
    ${raw(csrfField(csrfToken))}
    <input type="hidden" name="action" value="save_overrides">
    <input type="hidden" name="user_id" value="${targetUserId}">
    <div class="row g-2 mb-3">${raw(matrixHtml)}</div>
    <button type="submit" class="btn btn-primary">Save Permissions</button>
    <a href="/admin/users" class="btn btn-outline-secondary">Back to Users</a>
</form>
<form method="post" class="mt-3" onsubmit="return confirm('Reset all permission overrides for this user back to their role defaults?');">
    ${raw(csrfField(csrfToken))}
    <input type="hidden" name="action" value="reset_overrides">
    <input type="hidden" name="user_id" value="${targetUserId}">
    <button type="submit" class="btn btn-outline-danger btn-sm">Reset All to Role Default</button>
</form>`;
}

export function registerAdminUserPermissionsRoutes(router) {
    router.get('/admin/users/permissions', async (request, ctx, url) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const targetUserId = Number(url.searchParams.get('user_id'));
        if (!targetUserId) return notFound();
        const body = await userPermissionsPageBody(targetUserId, auth.user.csrf);
        if (body === null) return notFound();
        return renderShellForRequest({ request, auth, pageTitle: 'User Permissions', path: '/admin/users/permissions', bodyHtml: body });
    });

    router.post('/admin/users/permissions', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();
        const targetUserId = Number(form.user_id);
        if (!targetUserId) return notFound();
        const ip = clientIp(request);
        const redirectBack = () => `/admin/users/permissions?user_id=${targetUserId}`;

        if (form.action === 'reset_overrides') {
            const existing = unwrap(await db().from('user_permission_overrides').select('permission_id').eq('user_id', targetUserId));
            unwrap(await db().from('user_permission_overrides').delete().eq('user_id', targetUserId));
            await recordPermissionAudit({
                actorUserId: user.user_id, targetType: 'user', targetUserId,
                action: 'user_override_reset', beforeSnapshot: existing.map((r) => r.permission_id), ipAddress: ip,
            });
            return redirectTo(redirectBack(), { cookies: [auth.setCookie, flashSetCookie('success', 'Permission overrides reset to role default.')].filter(Boolean) });
        }

        if (form.action === 'save_overrides') {
            const userRows = unwrap(await db().from('users').select('role_id').eq('user_id', targetUserId).limit(1));
            if (!userRows.length) return notFound();

            const [catalog, roleGrantRows, existingOverrides] = await Promise.all([
                getPermissionCatalog(),
                db().from('role_permissions').select('permission_id').eq('role_id', userRows[0].role_id).then(unwrap),
                db().from('user_permission_overrides').select('permission_id, granted').eq('user_id', targetUserId).then(unwrap),
            ]);
            const roleGrantedIds = new Set(roleGrantRows.map((r) => r.permission_id));
            const permIdByKey = new Map(catalog.map((p) => [p.permission_key, p.permission_id]));
            const checkedKeys = new Set(asArray(form.perm));

            const beforeOverrides = existingOverrides.map((r) => ({ permission_id: r.permission_id, granted: r.granted }));
            unwrap(await db().from('user_permission_overrides').delete().eq('user_id', targetUserId));

            const newOverrideRows = [];
            for (const p of catalog) {
                const checked = checkedKeys.has(p.permission_key);
                const fromRole = roleGrantedIds.has(p.permission_id);
                if (checked !== fromRole) {
                    newOverrideRows.push({ user_id: targetUserId, permission_id: p.permission_id, granted: checked, created_by: user.user_id });
                }
            }
            if (newOverrideRows.length) {
                unwrap(await db().from('user_permission_overrides').insert(newOverrideRows));
            }

            await recordPermissionAudit({
                actorUserId: user.user_id, targetType: 'user', targetUserId,
                action: newOverrideRows.length >= beforeOverrides.length ? 'user_override_granted' : 'user_override_revoked',
                beforeSnapshot: beforeOverrides,
                afterSnapshot: newOverrideRows.map((r) => ({ permission_id: r.permission_id, granted: r.granted })),
                ipAddress: ip,
            });
            return redirectTo(redirectBack(), { cookies: [auth.setCookie, flashSetCookie('success', 'Permissions updated.')].filter(Boolean) });
        }

        return redirectTo(redirectBack(), { cookies: [auth.setCookie] });
    });
}
