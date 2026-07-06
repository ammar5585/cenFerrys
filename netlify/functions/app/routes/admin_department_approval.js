// Admin config for the department-based approval hierarchy: per
// department, pick who fills the Primary Approver (In Charge / Head of
// Department) / Secondary Approver (Assistant In Charge / Assistant
// Manager) tiers (any active user, independent of their system role),
// whether the department uses this hierarchy at all (vs. the legacy
// org-wide GM -> RM -> HR chain), and SLA auto-escalation timing.
// A third "Supervisor" tier existed previously and was removed by user
// request (supabase/migrations/0011_remove_supervisor_tier.sql) - no
// live data depended on it at removal time.

import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { getAllResorts, getActiveDepartments } from '../refData.js';

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

async function departmentApprovalPageBody(csrfToken) {
    const resorts = await getAllResorts();
    const departments = await getActiveDepartments();
    const configs = unwrap(await db().from('department_approval_config').select('*'));
    const configByKey = new Map(configs.map((c) => [`${c.resort_id}:${c.department_id}`, c]));
    const activeUsers = unwrap(
        await db().from('users').select('user_id, full_name, employee_id, resort_id').eq('status', 'active').order('full_name')
    );
    const activeUsersByResort = new Map();
    for (const u of activeUsers) {
        if (!activeUsersByResort.has(u.resort_id)) activeUsersByResort.set(u.resort_id, []);
        activeUsersByResort.get(u.resort_id).push(u);
    }

    const userOptions = (resortId, selectedId) => {
        const users = activeUsersByResort.get(resortId) ?? [];
        return (
            `<option value="">-- None --</option>` +
            users.map((u) => `<option value="${u.user_id}" ${selectedId === u.user_id ? 'selected' : ''}>${h(u.full_name)} (${h(u.employee_id)})</option>`).join('')
        );
    };

    const resortSections = resorts
        .map((r) => {
            const cards = departments
                .map((d) => {
                    // Department Hierarchy is the real runtime default for a
                    // department with no config row (see approval.js) - the
                    // fallback shown here must match, not silently default
                    // the display to Legacy.
                    const cfg = configByKey.get(`${r.resort_id}:${d.department_id}`) ?? {
                        approval_mode: 'department_hierarchy',
                        manager_user_id: null,
                        assistant_manager_user_id: null,
                        sla_hours: '',
                        auto_escalation_enabled: true,
                    };
                    const fieldId = `${r.resort_id}-${d.department_id}`;
                    return html`
<div class="col-lg-6">
    <div class="card shadow-sm h-100">
        <div class="card-header bg-white"><strong>${d.department_name}</strong></div>
        <div class="card-body">
            <form method="post">
                ${raw(csrfField(csrfToken))}
                <input type="hidden" name="resort_id" value="${r.resort_id}">
                <input type="hidden" name="department_id" value="${d.department_id}">
                <div class="mb-3">
                    <label class="form-label">Approval Workflow</label>
                    <select name="approval_mode" class="form-select form-select-sm">
                        <option value="legacy" ${cfg.approval_mode === 'legacy' ? 'selected' : ''}>Legacy (org-wide GM &rarr; RM &rarr; HR chain)</option>
                        <option value="department_hierarchy" ${cfg.approval_mode === 'department_hierarchy' ? 'selected' : ''}>Department Hierarchy (this department's own tiers below)</option>
                    </select>
                </div>
                <div class="mb-2">
                    <label class="form-label small mb-0">Approval Tier 1 (Primary Approver &ndash; In Charge / Head of Department)</label>
                    <select name="manager_user_id" class="form-select form-select-sm">${raw(userOptions(r.resort_id, cfg.manager_user_id))}</select>
                </div>
                <div class="mb-2">
                    <label class="form-label small mb-0">Approval Tier 2 (Secondary Approver &ndash; Assistant In Charge / Assistant Manager)</label>
                    <select name="assistant_manager_user_id" class="form-select form-select-sm">${raw(userOptions(r.resort_id, cfg.assistant_manager_user_id))}</select>
                </div>
                <p class="text-muted small">Assignment slots are independent of a user's system role - any active user at this resort can be assigned to any tier.</p>
                <div class="row g-2 mb-2">
                    <div class="col-6">
                        <label class="form-label small mb-0">SLA (hours)</label>
                        <input type="number" min="0" name="sla_hours" class="form-control form-control-sm" value="${cfg.sla_hours ?? ''}" placeholder="disabled">
                    </div>
                    <div class="col-6 d-flex align-items-end">
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" name="auto_escalation_enabled" id="autoesc${fieldId}" ${cfg.auto_escalation_enabled ? 'checked' : ''}>
                            <label class="form-check-label small" for="autoesc${fieldId}">Auto-escalate on timeout</label>
                        </div>
                    </div>
                </div>
                <button type="submit" class="btn btn-sm btn-primary w-100">Save</button>
            </form>
        </div>
    </div>
</div>`;
                })
                .map((c) => c.toString())
                .join('');

            return html`
<h6 class="mt-4 mb-3"><i class="bi bi-geo-alt"></i> ${r.resort_name}</h6>
<div class="row g-3">${raw(cards)}</div>`;
        })
        .map((s) => s.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-diagram-3"></i> Department Approval Configuration</h5>
<p class="text-muted">Departments left on "Legacy" keep using the existing General Manager &rarr; Resident Manager &rarr; HR Manager chain untouched. Switch a department to "Department Hierarchy" once its tiers are assigned below. Each resort's hierarchy is fully independent - the same department at a different resort has its own separate configuration. HR Manager accounts always retain organization-wide override authority regardless of a department's setting (see HR Overview).</p>
${raw(resortSections)}`;
}

export function registerAdminDepartmentApprovalRoutes(router) {
    router.get('/admin/department_approval', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.configure_hierarchy', { pageTitle: 'Department Approval Configuration' });
        if (auth.response) return auth.response;
        const body = await departmentApprovalPageBody(auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'Department Approval Configuration', path: '/admin/department_approval', bodyHtml: body });
    });

    router.post('/admin/department_approval', async (request) => {
        const auth = await requirePermission(request, 'approval_workflow.configure_hierarchy', { pageTitle: 'Department Approval Configuration' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const resortId = Number(form.resort_id);
        const departmentId = Number(form.department_id);
        const approvalMode = form.approval_mode === 'department_hierarchy' ? 'department_hierarchy' : 'legacy';
        const managerUserId = Number(form.manager_user_id) || null;
        const assistantManagerUserId = Number(form.assistant_manager_user_id) || null;
        const slaHoursRaw = (form.sla_hours || '').trim();
        const slaHours = slaHoursRaw === '' ? null : Math.max(0, Number(slaHoursRaw));
        const autoEscalationEnabled = !!form.auto_escalation_enabled;

        // Server-side re-validation that the chosen users are actually
        // active AND belong to this same resort - never trust the dropdown
        // alone (mirrors the same discipline used elsewhere in this
        // codebase, e.g. admin/users.js).
        const candidateIds = [managerUserId, assistantManagerUserId].filter(Boolean);
        if (candidateIds.length) {
            const activeRows = unwrap(
                await db().from('users').select('user_id').eq('status', 'active').eq('resort_id', resortId).in('user_id', candidateIds)
            );
            const activeIds = new Set(activeRows.map((r) => r.user_id));
            for (const id of candidateIds) {
                if (!activeIds.has(id)) {
                    return redirectTo('/admin/department_approval', {
                        cookies: [auth.setCookie, flashSetCookie('error', 'One or more selected users are no longer active at this resort. Please re-select.')].filter(Boolean),
                    });
                }
            }
        }

        unwrap(
            await db()
                .from('department_approval_config')
                .upsert(
                    {
                        resort_id: resortId,
                        department_id: departmentId,
                        approval_mode: approvalMode,
                        manager_user_id: managerUserId,
                        assistant_manager_user_id: assistantManagerUserId,
                        sla_hours: slaHours,
                        auto_escalation_enabled: autoEscalationEnabled,
                    },
                    { onConflict: 'resort_id,department_id' }
                )
        );
        await logActivity(user.user_id, 'Updated department approval configuration', `resort_id=${resortId}, department_id=${departmentId}, mode=${approvalMode}`, clientIp(request));

        return redirectTo('/admin/department_approval', { cookies: [auth.setCookie, flashSetCookie('success', 'Department approval configuration saved.')].filter(Boolean) });
    });
}
