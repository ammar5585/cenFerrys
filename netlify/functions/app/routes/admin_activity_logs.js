// Port of admin/activity_logs.php - paginated audit log viewer with search.

import { db, unwrap } from '../db.js';
import { requireRole } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw } from '../templates/html.js';
import { formatDateTime } from '../format.js';
import { ROLE_ADMIN } from '../session.js';

const PER_PAGE = 25;

export function registerAdminActivityLogRoutes(router) {
    router.get('/admin/activity_logs', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;

        const url = new URL(request.url);
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
