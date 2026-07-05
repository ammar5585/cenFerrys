// Port of admin/activity_logs.php - paginated audit log viewer with search.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { hasPermission } from '../permissions.js';
import { accessDeniedResponse } from '../accessDenied.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw } from '../templates/html.js';
import { formatDateTime } from '../format.js';

const PER_PAGE = 25;

function tabsHtml(activeTab, canViewPermissionChanges) {
    if (!canViewPermissionChanges) return '';
    return `<ul class="nav nav-tabs mb-3">
        <li class="nav-item"><a class="nav-link ${activeTab === 'activity' ? 'active' : ''}" href="/admin/activity_logs">Activity Logs</a></li>
        <li class="nav-item"><a class="nav-link ${activeTab === 'permissions' ? 'active' : ''}" href="/admin/activity_logs?tab=permissions">Permission Changes</a></li>
    </ul>`;
}

async function permissionChangesBody(page, canViewPermissionChanges) {
    const rows = unwrap(
        await db()
            .from('permission_audit_log')
            .select(
                'audit_id, target_type, action, previous_value, new_value, before_snapshot, after_snapshot, created_at, ' +
                    'actor:users!permission_audit_log_actor_user_id_fkey(full_name), ' +
                    'target_role:roles(role_name), target_user:users!permission_audit_log_target_user_id_fkey(full_name)'
            )
            .order('created_at', { ascending: false })
    );

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
    const pageRows = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);

    const rowsHtml = pageRows
        .map((r) => {
            const target = r.target_type === 'role' ? (r.target_role?.role_name ?? `role #${r.audit_id}`) : (r.target_user?.full_name ?? 'unknown user');
            const changeSummary = r.before_snapshot || r.after_snapshot
                ? `${(r.before_snapshot ?? []).length} -> ${(r.after_snapshot ?? []).length} permissions`
                : `${r.previous_value ?? ''} -> ${r.new_value ?? ''}`;
            return html`<tr>
                <td>${formatDateTime(r.created_at)}</td><td>${r.actor?.full_name ?? 'Unknown'}</td>
                <td>${r.action.replace(/_/g, ' ')}</td><td>${r.target_type}: ${target}</td><td>${changeSummary}</td>
            </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    const pagination =
        totalPages > 1
            ? `<nav class="mt-3"><ul class="pagination pagination-sm">${Array.from({ length: totalPages }, (_, i) => i + 1)
                  .map((p) => `<li class="page-item ${p === page ? 'active' : ''}"><a class="page-link" href="?tab=permissions&page=${p}">${p}</a></li>`)
                  .join('')}</ul></nav>`
            : '';

    return html`
<h5 class="mb-3"><i class="bi bi-shield-lock"></i> Permission Change History</h5>
${raw(tabsHtml('permissions', canViewPermissionChanges))}
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Date/Time</th><th>Administrator</th><th>Action</th><th>Target</th><th>Change</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="5" class="text-center text-muted py-4">No permission changes recorded.</td></tr>')}</tbody>
</table></div></div>
${raw(pagination)}`;
}

export function registerAdminActivityLogRoutes(router) {
    router.get('/admin/activity_logs', async (request) => {
        const auth = await requirePermission(request, 'audit_logs.view_activity', { pageTitle: 'Activity Logs' });
        if (auth.response) return auth.response;

        const url = new URL(request.url);
        const canViewPermissionChanges = hasPermission(auth.user.perms, 'audit_logs.view_permission_changes');
        if (url.searchParams.get('tab') === 'permissions') {
            if (!canViewPermissionChanges) return accessDeniedResponse({ request, auth, pageTitle: 'Permission Changes' });
            const page = Math.max(1, Number(url.searchParams.get('page') || 1));
            const body = await permissionChangesBody(page, canViewPermissionChanges);
            return renderShellForRequest({ request, auth, pageTitle: 'Permission Changes', path: '/admin/activity_logs', bodyHtml: body });
        }

        const search = url.searchParams.get('search') || '';
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));

        // Filtered in JS (not a raw .or() filter string - see the same fix
        // applied to admin/users.php's search and auth/forgot_password.php).
        let logs = unwrap(
            await db()
                .from('activity_logs')
                .select('log_id, action, details, ip_address, created_at, users(full_name)')
                .order('created_at', { ascending: false })
        );
        if (search) {
            const needle = search.toLowerCase();
            logs = logs.filter(
                (l) =>
                    l.action.toLowerCase().includes(needle) ||
                    (l.details ?? '').toLowerCase().includes(needle) ||
                    (l.users?.full_name ?? '').toLowerCase().includes(needle)
            );
        }

        const total = logs.length;
        const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
        const pageLogs = logs.slice((page - 1) * PER_PAGE, page * PER_PAGE);

        const rowsHtml = pageLogs
            .map(
                (log) => html`<tr>
                <td>${formatDateTime(log.created_at)}</td><td>${log.users?.full_name ?? 'System'}</td>
                <td>${log.action}</td><td>${log.details ?? ''}</td><td>${log.ip_address ?? ''}</td>
            </tr>`
            )
            .map((r) => r.toString())
            .join('');

        const pagination =
            totalPages > 1
                ? `<nav class="mt-3"><ul class="pagination pagination-sm">${Array.from({ length: totalPages }, (_, i) => i + 1)
                      .map((p) => `<li class="page-item ${p === page ? 'active' : ''}"><a class="page-link" href="?search=${encodeURIComponent(search)}&page=${p}">${p}</a></li>`)
                      .join('')}</ul></nav>`
                : '';

        const body = html`
<h5 class="mb-3"><i class="bi bi-clock-history"></i> Activity Logs</h5>
${raw(tabsHtml('activity', canViewPermissionChanges))}
<div class="card shadow-sm mb-3"><div class="card-body">
    <form method="get" class="row g-2">
        <div class="col-md-4"><input type="text" name="search" class="form-control" placeholder="Search action, user, or details" value="${search}"></div>
        <div class="col-md-2"><button class="btn btn-outline-primary btn-sm w-100" type="submit">Search</button></div>
    </form>
</div></div>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Date/Time</th><th>User</th><th>Action</th><th>Details</th><th>IP Address</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="5" class="text-center text-muted py-4">No activity recorded.</td></tr>')}</tbody>
</table></div></div>
${raw(pagination)}`;

        return renderShellForRequest({ request, auth, pageTitle: 'Activity Logs', path: '/admin/activity_logs', bodyHtml: body });
    });
}
