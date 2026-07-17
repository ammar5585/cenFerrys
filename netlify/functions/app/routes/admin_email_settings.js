// Email Settings module: lets an Administrator configure outbound SMTP
// and edit the 7 system email templates, all from the portal. General +
// SMTP fields reuse the existing generic settings key/value table
// (settings.js), exactly like admin_settings.js/admin_branding.js -
// mirrors admin_branding.js's overall shape (error-redisplay-on-save,
// changed-field audit logging). Templates live in their own small table
// (email_templates, migration 0019) since each has 2 fields (subject/
// body) rather than a single value. All actual SMTP transport logic
// lives in mailer.js - this file is purely the admin UI + validation +
// audit logging around it.

import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { db, unwrap } from '../db.js';
import { getSetting, setSetting, resetSettingsCache } from '../settings.js';
import { encryptSmtpPassword, sendTestEmail } from '../mailer.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDateTime } from '../format.js';
import {
    listRecipientGroups, setGroupRoles, addGroupEmail, removeGroupEmail,
    listSchedules, createSchedule, updateSchedule, setScheduleActive,
    sendReportNow, retryLogRow, listEmailLog,
} from '../reportEmailScheduling.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REPORT_TYPE_LABELS = { passenger_manifest: 'Passenger Manifest', daily_operations: 'Daily Operations Report' };
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Placeholder hints only - the action buttons every email also carries
// (Login always, plus per-template-key buttons like View Booking/
// Approve/Reject/Reset Password) are appended automatically by
// mailer.js's EMAIL_ACTIONS map, not something an admin inserts here.
const PLACEHOLDER_HINTS = {
    approval_request: ['approver_name', 'full_name', 'department_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id'],
    booking_approval: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id'],
    booking_rejection: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id', 'reason'],
    booking_confirmation: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id'],
    booking_cancellation: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id'],
    waiting_list_promotion: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id'],
    password_reset: ['full_name', 'username'],
    user_creation: ['full_name', 'employee_id', 'username', 'role_name', 'resort_name', 'department_name', 'temp_password'],
    ferry_reminder: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id'],
    ferry_transfer: ['full_name', 'new_ferry_name', 'travel_date', 'departure_time', 'boarding_location', 'destination', 'reason', 'booking_id'],
    supplier_reservation_notice: ['recipient_name', 'visitor_name', 'supplier_company', 'host_employee_name', 'ferry_service', 'travel_date', 'booking_reference'],
};

function tabsHtml(activeTab) {
    return `<ul class="nav nav-tabs mb-3">
        <li class="nav-item"><a class="nav-link ${activeTab === 'settings' ? 'active' : ''}" href="/admin/email_settings">Settings</a></li>
        <li class="nav-item"><a class="nav-link ${activeTab === 'templates' ? 'active' : ''}" href="/admin/email_settings?tab=templates">Email Templates</a></li>
        <li class="nav-item"><a class="nav-link ${activeTab === 'reports' ? 'active' : ''}" href="/admin/email_settings?tab=reports">Report Emails</a></li>
    </ul>`;
}

async function settingsTabBody({ errors, csrfToken, testResult }) {
    const enabled = (await getSetting('email_notifications_enabled', '0')) === '1';
    const senderName = await getSetting('email_sender_name', '');
    const senderAddress = await getSetting('email_sender_address', '');
    const replyTo = await getSetting('email_reply_to', '');
    const host = await getSetting('email_smtp_host', '');
    const port = await getSetting('email_smtp_port', '587');
    const username = await getSetting('email_smtp_username', '');
    const hasPassword = !!(await getSetting('email_smtp_password_encrypted', ''));
    const encryption = await getSetting('email_smtp_encryption', 'tls');
    const timeoutMs = await getSetting('email_smtp_timeout_ms', '10000');
    const portalBaseUrl = await getSetting('portal_base_url', '');
    const approvalExpiryHours = await getSetting('approval_token_expiry_hours', '72');
    const resetExpiryHours = await getSetting('password_reset_token_expiry_hours', '2');
    const reminderHours = await getSetting('approval_reminder_hours', '24');
    const escalationHours = await getSetting('approval_escalation_hours', '48');

    return html`
<h5 class="mb-3"><i class="bi bi-envelope-at"></i> Email Settings</h5>
${raw(tabsHtml('settings'))}
${errors.length ? html`<div class="alert alert-danger">${raw(errors.map((e) => `${h(e)}<br>`).join(''))}</div>` : ''}
${testResult ? html`<div class="alert ${testResult.ok ? 'alert-success' : 'alert-danger'}">${testResult.ok ? 'Test email sent successfully.' : `Test email failed: ${h(testResult.error)}`}</div>` : ''}
<form method="post">
    ${raw(csrfField(csrfToken))}
    <input type="hidden" name="action" value="save">
    <div class="row g-3">
        <div class="col-12 col-lg-6">
            <div class="card h-100"><div class="card-header bg-white">General Settings</div><div class="card-body">
                <div class="form-check form-switch mb-3">
                    <input class="form-check-input" type="checkbox" role="switch" name="email_notifications_enabled" id="emailEnabled" ${enabled ? 'checked' : ''}>
                    <label class="form-check-label" for="emailEnabled">Enable Email Notifications</label>
                </div>
                <div class="mb-3"><label class="form-label">Sender Name</label><input type="text" name="email_sender_name" class="form-control" value="${senderName}"></div>
                <div class="mb-3"><label class="form-label">Sender Email Address</label><input type="email" name="email_sender_address" class="form-control" value="${senderAddress}"></div>
                <div class="mb-0"><label class="form-label">Reply-To Email Address</label><input type="email" name="email_reply_to" class="form-control" value="${replyTo}"></div>
            </div></div>
        </div>
        <div class="col-12 col-lg-6">
            <div class="card h-100"><div class="card-header bg-white">SMTP Settings</div><div class="card-body">
                <div class="mb-3"><label class="form-label">SMTP Host</label><input type="text" name="email_smtp_host" class="form-control" value="${host}" placeholder="smtp.gmail.com"></div>
                <div class="row g-3 mb-3">
                    <div class="col-6"><label class="form-label">SMTP Port</label><input type="number" name="email_smtp_port" class="form-control" value="${port}" placeholder="587"></div>
                    <div class="col-6"><label class="form-label">Encryption</label><select name="email_smtp_encryption" class="form-select">
                        <option value="tls" ${encryption === 'tls' ? 'selected' : ''}>TLS</option>
                        <option value="ssl" ${encryption === 'ssl' ? 'selected' : ''}>SSL</option>
                        <option value="none" ${encryption === 'none' ? 'selected' : ''}>None</option>
                    </select></div>
                </div>
                <div class="mb-3"><label class="form-label">SMTP Username</label><input type="text" name="email_smtp_username" class="form-control" value="${username}" placeholder="you@gmail.com"></div>
                <div class="mb-3">
                    <label class="form-label">SMTP Password</label>
                    <div class="input-group">
                        <input type="password" name="email_smtp_password_new" id="smtpPasswordInput" class="form-control" placeholder="${hasPassword ? 'Leave blank to keep current password' : 'Enter SMTP password / app password'}">
                        <button class="btn btn-outline-secondary" type="button" id="toggleSmtpPassword"><i class="bi bi-eye"></i></button>
                    </div>
                    <div class="form-text">${hasPassword ? 'A password is already saved. Leave blank to keep it unchanged.' : 'No password saved yet.'}</div>
                </div>
                <div class="mb-0"><label class="form-label">Connection Timeout (ms)</label><input type="number" name="email_smtp_timeout_ms" class="form-control" value="${timeoutMs}"></div>
            </div></div>
        </div>
        <div class="col-12 col-lg-6">
            <div class="card h-100"><div class="card-header bg-white">Portal &amp; Security Links</div><div class="card-body">
                <div class="mb-3"><label class="form-label">Portal Base URL</label><input type="url" name="portal_base_url" class="form-control" value="${portalBaseUrl}" placeholder="https://theatolliaferry.vercel.app">
                    <div class="form-text">Used to build every action link (Login, View Booking, Approve, Reset Password, etc.) in outbound emails. Leave blank to fall back to this deployment's own URL.</div>
                </div>
                <div class="row g-3">
                    <div class="col-6"><label class="form-label">Approval Link Expiry (hours)</label><input type="number" name="approval_token_expiry_hours" class="form-control" min="1" value="${approvalExpiryHours}"></div>
                    <div class="col-6"><label class="form-label">Password Reset Link Expiry (hours)</label><input type="number" name="password_reset_token_expiry_hours" class="form-control" min="1" value="${resetExpiryHours}"></div>
                </div>
            </div></div>
        </div>
        <div class="col-12 col-lg-6">
            <div class="card h-100"><div class="card-header bg-white">HOD Approval Reminders</div><div class="card-body">
                <div class="row g-3">
                    <div class="col-6"><label class="form-label">Reminder After (hours)</label><input type="number" name="approval_reminder_hours" class="form-control" min="1" value="${reminderHours}">
                        <div class="form-text">How long a "Pending HOD Approval" booking waits before the approver gets a reminder email.</div>
                    </div>
                    <div class="col-6"><label class="form-label">Escalate After (hours)</label><input type="number" name="approval_escalation_hours" class="form-control" min="1" value="${escalationHours}">
                        <div class="form-text">If still no action after this long, GM/RM/HR executives get an additional heads-up email.</div>
                    </div>
                </div>
            </div></div>
        </div>
        <div class="col-12">
            <div class="alert alert-info small mb-0">
                <strong>Gmail Configuration</strong>: use SMTP Host <code>smtp.gmail.com</code>, Port <code>587</code>, Encryption <code>TLS</code>, your Gmail Address as SMTP Username, and a
                <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">Gmail App Password</a> (not your normal account password) as the SMTP Password.
            </div>
        </div>
    </div>
    <button type="submit" class="btn btn-primary mt-3"><i class="bi bi-check-lg"></i> Save Settings</button>
</form>
<div class="card mt-3"><div class="card-header bg-white">Send Test Email</div><div class="card-body">
    <p class="text-muted small">Tests the currently-saved SMTP settings above. Save your settings first, then send a test.</p>
    <form method="post" class="row g-2">
        ${raw(csrfField(csrfToken))}
        <input type="hidden" name="action" value="send_test">
        <div class="col-auto"><input type="email" name="recipient_email" class="form-control" placeholder="recipient@example.com" required></div>
        <div class="col-auto"><button type="submit" class="btn btn-outline-primary"><i class="bi bi-send"></i> Send Test Email</button></div>
    </form>
</div></div>
<script>
(function () {
    var btn = document.getElementById('toggleSmtpPassword');
    var input = document.getElementById('smtpPasswordInput');
    if (!btn || !input) return;
    btn.addEventListener('click', function () {
        var isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.querySelector('i').className = isPassword ? 'bi bi-eye-slash' : 'bi bi-eye';
    });
})();
</script>`;
}

async function templatesTabBody({ csrfToken }) {
    const templates = unwrap(
        await db().from('email_templates').select('template_key, label, subject, body, updated_at, updated_by:users(full_name)').order('template_key')
    );

    const rowsHtml = templates
        .map((t) => {
            return html`<tr>
            <td>${t.label}</td>
            <td>${t.subject}</td>
            <td>${t.updated_by ? `${t.updated_by.full_name}` : '-'}</td>
            <td class="text-nowrap"><button type="button" class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#editTemplateModal${t.template_key}"><i class="bi bi-pencil"></i> Edit</button></td>
        </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    const modalsHtml = templates
        .map((t) => {
            const placeholders = (PLACEHOLDER_HINTS[t.template_key] || []).map((p) => `<code>{{${p}}}</code>`).join(' ');
            return `<div class="modal fade" id="editTemplateModal${t.template_key}" tabindex="-1"><div class="modal-dialog modal-lg"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="save_template"><input type="hidden" name="template_key" value="${t.template_key}">
    <div class="modal-header"><h5 class="modal-title">${h(t.label)}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="mb-3"><label class="form-label">Subject</label><input type="text" name="subject" class="form-control" value="${h(t.subject)}" required></div>
        <div class="mb-3"><label class="form-label">Body</label><textarea name="body" class="form-control" rows="8" required>${h(t.body)}</textarea></div>
        <div class="form-text">Available placeholders: ${placeholders}</div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Save Template</button></div>
</form></div></div>`;
        })
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-envelope-at"></i> Email Settings</h5>
${raw(tabsHtml('templates'))}
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Template</th><th>Subject</th><th>Last Updated By</th><th>Actions</th></tr></thead>
    <tbody>${raw(rowsHtml)}</tbody>
</table></div></div>
${raw(modalsHtml)}`;
}

function scheduleModalHtml({ idSuffix, csrfToken, schedule, allGroups }) {
    const s = schedule ?? { schedule_id: '', report_type: 'daily_operations', frequency: 'daily', send_time: '21:00', interval_minutes: '', day_of_week: '', day_of_month: '', is_active: true, recipientGroups: [] };
    const selectedGroupIds = new Set((s.recipientGroups ?? []).map((g) => g.group_id));
    const groupCheckboxes = allGroups
        .map((g) => `<div class="form-check"><input class="form-check-input" type="checkbox" name="group_ids" value="${g.group_id}" id="sg${idSuffix}_${g.group_id}" ${selectedGroupIds.has(g.group_id) ? 'checked' : ''}><label class="form-check-label" for="sg${idSuffix}_${g.group_id}">${h(g.group_name)}</label></div>`)
        .join('');
    const weekdayOptions = WEEKDAY_LABELS.map((w, i) => `<option value="${i}" ${s.day_of_week === i ? 'selected' : ''}>${w}</option>`).join('');

    return `<div class="modal fade" id="scheduleModal${idSuffix}" tabindex="-1"><div class="modal-dialog"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="save_schedule"><input type="hidden" name="schedule_id" value="${s.schedule_id}">
    <div class="modal-header"><h5 class="modal-title">${s.schedule_id ? 'Edit Schedule' : 'Add Schedule'}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
        <div class="mb-3"><label class="form-label">Report Type</label><select name="report_type" class="form-select" ${s.schedule_id ? 'disabled' : ''}>
            <option value="daily_operations" ${s.report_type === 'daily_operations' ? 'selected' : ''}>Daily Operations Report</option>
            <option value="passenger_manifest" ${s.report_type === 'passenger_manifest' ? 'selected' : ''}>Passenger Manifest</option>
        </select>${s.schedule_id ? `<input type="hidden" name="report_type" value="${s.report_type}">` : ''}</div>
        <div class="row g-3 mb-3">
            <div class="col-6"><label class="form-label">Frequency</label><select name="frequency" class="form-select schedule-frequency-select">
                <option value="daily" ${s.frequency === 'daily' ? 'selected' : ''}>Daily</option>
                <option value="weekly" ${s.frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
                <option value="monthly" ${s.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
                <option value="custom" ${s.frequency === 'custom' ? 'selected' : ''}>Custom</option>
                <option value="interval" ${s.frequency === 'interval' ? 'selected' : ''}>Every N Minutes</option>
            </select></div>
            <div class="col-6 field-time-only"><label class="form-label">Send Time</label><input type="time" name="send_time" class="form-control" value="${(s.send_time || '').slice(0, 5)}"></div>
            <div class="col-6 field-interval-only"><label class="form-label">Interval (Minutes)</label><input type="number" name="interval_minutes" class="form-control" min="5" step="1" placeholder="e.g. 60" value="${s.interval_minutes ?? ''}"><div class="form-text">Checked roughly every 5 minutes - shorter intervals fire as soon as the next check runs.</div></div>
        </div>
        <div class="row g-3 mb-3 field-time-only">
            <div class="col-6"><label class="form-label">Day of Week</label><select name="day_of_week" class="form-select"><option value="">-</option>${weekdayOptions}</select><div class="form-text">Weekly/Custom only</div></div>
            <div class="col-6"><label class="form-label">Day of Month</label><input type="number" name="day_of_month" class="form-control" min="1" max="31" value="${s.day_of_month ?? ''}"><div class="form-text">Monthly/Custom only</div></div>
        </div>
        <div class="mb-2"><label class="form-label">Recipient Groups</label>${groupCheckboxes}</div>
        ${s.schedule_id ? `<div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" name="is_active" id="active${idSuffix}" ${s.is_active ? 'checked' : ''}><label class="form-check-label" for="active${idSuffix}">Active</label></div>` : ''}
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Save Schedule</button></div>
</form></div></div>`;
}

function groupRolesModalHtml({ csrfToken, group, allRoles }) {
    const selectedRoleIds = new Set(group.roles.map((r) => r.role_id));
    const checkboxes = allRoles
        .map((r) => `<div class="form-check"><input class="form-check-input" type="checkbox" name="role_ids" value="${r.role_id}" id="gr${group.group_id}_${r.role_id}" ${selectedRoleIds.has(r.role_id) ? 'checked' : ''}><label class="form-check-label" for="gr${group.group_id}_${r.role_id}">${h(r.role_name)}</label></div>`)
        .join('');
    return `<div class="modal fade" id="groupRolesModal${group.group_id}" tabindex="-1"><div class="modal-dialog"><form method="post" class="modal-content">
    ${csrfField(csrfToken)}<input type="hidden" name="action" value="save_group_roles"><input type="hidden" name="group_id" value="${group.group_id}">
    <div class="modal-header"><h5 class="modal-title">${h(group.group_name)} - Roles</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">${checkboxes}</div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary">Save Roles</button></div>
</form></div></div>`;
}

function recipientGroupsCardHtml({ groups, allRoles, csrfToken }) {
    const groupCards = groups
        .map((g) => {
            const roleBadges = g.roles.length ? g.roles.map((r) => `<span class="badge text-bg-secondary me-1">${h(r.role_name)}</span>`).join('') : '<span class="text-muted small">No roles assigned</span>';
            const emailRows = g.emails
                .map(
                    (e) => `<div class="d-flex align-items-center gap-2 small mb-1">
                <span class="badge text-bg-light border">${h(e.recipient_type.toUpperCase())}</span>
                <span>${h(e.email)}</span>
                <form method="post" class="ms-auto"><input type="hidden" name="csrf_token" value="${csrfToken}"><input type="hidden" name="action" value="remove_group_email"><input type="hidden" name="email_id" value="${e.email_id}"><button type="submit" class="btn btn-sm btn-link text-danger p-0"><i class="bi bi-x-lg"></i></button></form>
            </div>`
                )
                .join('');
            return `<div class="col-12 col-lg-6">
        <div class="card h-100"><div class="card-header bg-white d-flex justify-content-between align-items-center">
            <span>${h(g.group_name)}</span>
            <button type="button" class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#groupRolesModal${g.group_id}"><i class="bi bi-pencil"></i> Edit Roles</button>
        </div><div class="card-body">
            <div class="mb-2">${roleBadges}</div>
            <hr>
            <div class="mb-2">${emailRows || '<span class="text-muted small">No manual addresses</span>'}</div>
            <form method="post" class="d-flex gap-2">
                ${csrfField(csrfToken)}<input type="hidden" name="action" value="add_group_email"><input type="hidden" name="group_id" value="${g.group_id}">
                <input type="email" name="email" class="form-control form-control-sm" placeholder="name@example.com" required>
                <select name="recipient_type" class="form-select form-select-sm" style="max-width:90px;"><option value="to">To</option><option value="cc">CC</option><option value="bcc">BCC</option></select>
                <button type="submit" class="btn btn-sm btn-outline-secondary"><i class="bi bi-plus-lg"></i></button>
            </form>
        </div></div>
    </div>`;
        })
        .join('');
    const modals = groups.map((g) => groupRolesModalHtml({ csrfToken, group: g, allRoles })).join('');
    return { cardsHtml: groupCards, modalsHtml: modals };
}

async function reportsTabBody({ csrfToken, page }) {
    const [{ groups, allRoles }, schedules, log] = await Promise.all([
        listRecipientGroups(),
        listSchedules(),
        listEmailLog({ page, pageSize: 25 }),
    ]);

    const { cardsHtml: groupCardsHtml, modalsHtml: groupModalsHtml } = recipientGroupsCardHtml({ groups, allRoles, csrfToken });

    const scheduleRows = schedules
        .map((s) => {
            const dayInfo = s.frequency === 'weekly' ? WEEKDAY_LABELS[s.day_of_week] ?? '-' : s.frequency === 'monthly' ? `Day ${s.day_of_month ?? '-'}` : s.frequency === 'custom' ? [s.day_of_week != null ? WEEKDAY_LABELS[s.day_of_week] : null, s.day_of_month ? `Day ${s.day_of_month}` : null].filter(Boolean).join(', ') || 'Every day' : '-';
            const timeInfo = s.frequency === 'interval' ? `Every ${s.interval_minutes} min` : (s.send_time || '').slice(0, 5);
            const groupBadges = s.recipientGroups.length ? s.recipientGroups.map((g) => `<span class="badge text-bg-secondary me-1">${h(g.group_name)}</span>`).join('') : '<span class="text-danger small">None assigned</span>';
            return `<tr>
            <td>${h(REPORT_TYPE_LABELS[s.report_type] ?? s.report_type)}</td>
            <td class="text-capitalize">${s.frequency === 'interval' ? 'Every N Minutes' : h(s.frequency)}</td>
            <td>${h(timeInfo)}</td>
            <td>${h(dayInfo)}</td>
            <td>${groupBadges}</td>
            <td>${s.is_active ? '<span class="badge text-bg-success">Active</span>' : '<span class="badge text-bg-secondary">Inactive</span>'}</td>
            <td class="small text-muted">${s.last_run_at ? formatDateTime(s.last_run_at) : 'Never'}</td>
            <td class="text-nowrap">
                <button type="button" class="btn btn-sm btn-outline-primary" data-bs-toggle="modal" data-bs-target="#scheduleModal${s.schedule_id}"><i class="bi bi-pencil"></i></button>
                <form method="post" class="d-inline"><input type="hidden" name="csrf_token" value="${csrfToken}"><input type="hidden" name="action" value="toggle_schedule"><input type="hidden" name="schedule_id" value="${s.schedule_id}"><input type="hidden" name="is_active" value="${s.is_active ? '0' : '1'}"><button type="submit" class="btn btn-sm btn-outline-secondary">${s.is_active ? 'Pause' : 'Resume'}</button></form>
            </td>
        </tr>`;
        })
        .join('');
    const scheduleModalsHtml = schedules.map((s) => scheduleModalHtml({ idSuffix: s.schedule_id, csrfToken, schedule: s, allGroups: groups })).join('') + scheduleModalHtml({ idSuffix: 'New', csrfToken, schedule: null, allGroups: groups });

    const sendNowGroupCheckboxes = groups.map((g) => `<div class="form-check form-check-inline"><input class="form-check-input" type="checkbox" name="group_ids" value="${g.group_id}" id="sn${g.group_id}"><label class="form-check-label" for="sn${g.group_id}">${h(g.group_name)}</label></div>`).join('');

    const statusBadge = (status) => (status === 'sent' ? '<span class="badge text-bg-success">Sent</span>' : status === 'retrying' ? '<span class="badge text-bg-warning">Retrying</span>' : '<span class="badge text-bg-danger">Failed</span>');
    const logRows = log.rows
        .map(
            (r) => `<tr>
            <td>${h(REPORT_TYPE_LABELS[r.report_type] ?? r.report_type)}</td>
            <td class="small">${h(r.recipients_to ?? '-')}</td>
            <td class="small text-muted">${formatDateTime(r.sent_at ?? r.created_at)}</td>
            <td>${statusBadge(r.delivery_status)}</td>
            <td class="small text-muted" style="max-width:220px;" title="${h(r.error_message ?? r.smtp_response ?? '')}">${h((r.error_message ?? r.smtp_response ?? '').slice(0, 60))}</td>
            <td>${r.retry_count}</td>
            <td>${r.delivery_status === 'failed' ? `<form method="post"><input type="hidden" name="csrf_token" value="${csrfToken}"><input type="hidden" name="action" value="retry_log"><input type="hidden" name="log_id" value="${r.log_id}"><button type="submit" class="btn btn-sm btn-outline-primary"><i class="bi bi-arrow-clockwise"></i> Retry</button></form>` : ''}</td>
        </tr>`
        )
        .join('');
    const totalPages = Math.max(1, Math.ceil(log.total / 25));
    const pagination = totalPages > 1
        ? `<nav class="mt-2"><ul class="pagination pagination-sm mb-0">${Array.from({ length: totalPages }, (_, i) => i + 1)
              .map((p) => `<li class="page-item ${p === page ? 'active' : ''}"><a class="page-link" href="/admin/email_settings?tab=reports&page=${p}">${p}</a></li>`)
              .join('')}</ul></nav>`
        : '';

    return html`
<h5 class="mb-3"><i class="bi bi-envelope-at"></i> Email Settings</h5>
${raw(tabsHtml('reports'))}

<h6 class="mt-4 mb-3">Recipient Groups</h6>
<div class="row g-3 mb-4">${raw(groupCardsHtml)}</div>

<div class="d-flex justify-content-between align-items-center mt-4 mb-3">
    <h6 class="mb-0">Schedules</h6>
    <button type="button" class="btn btn-sm btn-primary" data-bs-toggle="modal" data-bs-target="#scheduleModalNew"><i class="bi bi-plus-lg"></i> Add Schedule</button>
</div>
<div class="card shadow-sm mb-4"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Report</th><th>Frequency</th><th>Time</th><th>Day</th><th>Recipients</th><th>Status</th><th>Last Run</th><th></th></tr></thead>
    <tbody>${raw(scheduleRows || '<tr><td colspan="8" class="text-center text-muted py-3">No schedules configured.</td></tr>')}</tbody>
</table></div></div>

<h6 class="mt-4 mb-3">Send Now</h6>
<div class="card shadow-sm mb-4"><div class="card-body">
    <form method="post" class="row g-3 align-items-end">
        ${raw(csrfField(csrfToken))}<input type="hidden" name="action" value="send_now">
        <div class="col-12 col-md-4"><label class="form-label">Report Type</label><select name="report_type" class="form-select">
            <option value="daily_operations">Daily Operations Report</option>
            <option value="passenger_manifest">Passenger Manifest</option>
        </select></div>
        <div class="col-12 col-md-6"><label class="form-label d-block">Recipient Groups</label>${raw(sendNowGroupCheckboxes)}</div>
        <div class="col-12 col-md-2"><button type="submit" class="btn btn-primary w-100"><i class="bi bi-send"></i> Send Now</button></div>
    </form>
</div></div>

<h6 class="mt-4 mb-3">Delivery History</h6>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Report</th><th>Recipients</th><th>Sent / Attempted</th><th>Status</th><th>Detail</th><th>Retries</th><th></th></tr></thead>
    <tbody>${raw(logRows || '<tr><td colspan="7" class="text-center text-muted py-3">No delivery history yet.</td></tr>')}</tbody>
</table></div>${raw(pagination)}</div>
${raw(groupModalsHtml)}
${raw(scheduleModalsHtml)}
<script>
(function () {
    function applyFrequencyVisibility(modalEl) {
        var select = modalEl.querySelector('.schedule-frequency-select');
        if (!select) return;
        var isInterval = select.value === 'interval';
        modalEl.querySelectorAll('.field-time-only').forEach(function (el) { el.style.display = isInterval ? 'none' : ''; });
        modalEl.querySelectorAll('.field-interval-only').forEach(function (el) { el.style.display = isInterval ? '' : 'none'; });
    }
    document.querySelectorAll('.schedule-frequency-select').forEach(function (select) {
        var modalEl = select.closest('.modal');
        applyFrequencyVisibility(modalEl);
        select.addEventListener('change', function () { applyFrequencyVisibility(modalEl); });
    });
})();
</script>`;
}

export function registerAdminEmailSettingsRoutes(router) {
    router.get('/admin/email_settings', async (request) => {
        const auth = await requirePermission(request, 'settings.manage_email', { pageTitle: 'Email Settings' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const tabParam = url.searchParams.get('tab');
        const tab = tabParam === 'templates' ? 'templates' : tabParam === 'reports' ? 'reports' : 'settings';
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const body = tab === 'templates'
            ? await templatesTabBody({ csrfToken: auth.user.csrf })
            : tab === 'reports'
            ? await reportsTabBody({ csrfToken: auth.user.csrf, page })
            : await settingsTabBody({ errors: [], csrfToken: auth.user.csrf, testResult: null });
        return renderShellForRequest({ request, auth, pageTitle: 'Email Settings', path: '/admin/email_settings', bodyHtml: body });
    });

    router.post('/admin/email_settings', async (request) => {
        const auth = await requirePermission(request, 'settings.manage_email', { pageTitle: 'Email Settings' });
        if (auth.response) return auth.response;
        const { user } = auth;

        const form = await request.formData();
        if (!verifyCsrf(user.csrf, form.get('csrf_token'))) return notFound();

        const action = form.get('action') || 'save';

        if (action === 'send_test') {
            const recipient = (form.get('recipient_email') || '').toString().trim();
            const result = recipient && EMAIL_REGEX.test(recipient)
                ? await sendTestEmail(recipient)
                : { ok: false, error: 'Please enter a valid recipient email address.' };
            const body = await settingsTabBody({ errors: [], csrfToken: user.csrf, testResult: result });
            return renderShellForRequest({ request, auth, pageTitle: 'Email Settings', path: '/admin/email_settings', bodyHtml: body });
        }

        if (action === 'save_template') {
            const templateKey = (form.get('template_key') || '').toString();
            const subject = (form.get('subject') || '').toString().trim();
            const body = (form.get('body') || '').toString().trim();
            if (!subject || !body) {
                return redirectTo('/admin/email_settings?tab=templates', { cookies: [auth.setCookie, flashSetCookie('error', 'Subject and Body are required.')].filter(Boolean) });
            }
            const existingRows = unwrap(await db().from('email_templates').select('subject, body').eq('template_key', templateKey).limit(1));
            if (!existingRows.length) return notFound();
            const existing = existingRows[0];

            unwrap(
                await db()
                    .from('email_templates')
                    .update({ subject, body, updated_at: new Date().toISOString(), updated_by_user_id: user.user_id })
                    .eq('template_key', templateKey)
            );
            if (existing.subject !== subject || existing.body !== body) {
                unwrap(
                    await db().from('email_audit_log').insert({
                        event_type: 'template_updated',
                        actor_user_id: user.user_id,
                        setting_key: templateKey,
                        previous_value: `Subject: ${existing.subject}\n\n${existing.body}`,
                        new_value: `Subject: ${subject}\n\n${body}`,
                    })
                );
            }
            await logActivity(user.user_id, 'Updated email template', templateKey, clientIp(request));
            return redirectTo('/admin/email_settings?tab=templates', { cookies: [auth.setCookie, flashSetCookie('success', 'Template updated.')].filter(Boolean) });
        }

        if (action === 'save_group_roles') {
            const groupId = Number(form.get('group_id'));
            const roleIds = form.getAll('role_ids').map(Number).filter(Number.isInteger);
            await setGroupRoles(groupId, roleIds);
            await logActivity(user.user_id, 'Updated report recipient group roles', `group_id=${groupId}`, clientIp(request));
            return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie('success', 'Recipient group roles updated.')].filter(Boolean) });
        }

        if (action === 'add_group_email') {
            const groupId = Number(form.get('group_id'));
            const email = (form.get('email') || '').toString().trim();
            const recipientType = ['to', 'cc', 'bcc'].includes(form.get('recipient_type')) ? form.get('recipient_type').toString() : 'to';
            if (!email || !EMAIL_REGEX.test(email)) {
                return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie('error', 'Please enter a valid email address.')].filter(Boolean) });
            }
            await addGroupEmail(groupId, email, recipientType);
            return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie('success', 'Recipient added.')].filter(Boolean) });
        }

        if (action === 'remove_group_email') {
            await removeGroupEmail(Number(form.get('email_id')));
            return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie('success', 'Recipient removed.')].filter(Boolean) });
        }

        if (action === 'save_schedule') {
            const scheduleId = Number(form.get('schedule_id')) || null;
            const reportType = form.get('report_type').toString();
            const frequency = form.get('frequency').toString();
            const sendTimeRaw = (form.get('send_time') || '').toString();
            const sendTime = sendTimeRaw.length === 5 ? `${sendTimeRaw}:00` : sendTimeRaw;
            const intervalMinutesRaw = (form.get('interval_minutes') || '').toString();
            const intervalMinutes = intervalMinutesRaw === '' ? null : Number(intervalMinutesRaw);
            const dayOfWeekRaw = (form.get('day_of_week') || '').toString();
            const dayOfWeek = dayOfWeekRaw === '' ? null : Number(dayOfWeekRaw);
            const dayOfMonthRaw = (form.get('day_of_month') || '').toString();
            const dayOfMonth = dayOfMonthRaw === '' ? null : Number(dayOfMonthRaw);
            const groupIds = form.getAll('group_ids').map(Number).filter(Number.isInteger);
            const isActive = form.get('is_active') ? true : false;

            if (frequency === 'interval') {
                if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5) {
                    return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie('error', 'Interval must be a whole number of minutes, 5 or more (the poll only checks every ~5 minutes).')].filter(Boolean) });
                }
            } else if (!sendTime) {
                return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie('error', 'Send time is required.')].filter(Boolean) });
            }

            if (scheduleId) {
                await updateSchedule(scheduleId, { frequency, sendTime, intervalMinutes, dayOfWeek, dayOfMonth, isActive, groupIds, userId: user.user_id });
            } else {
                await createSchedule({ reportType, frequency, sendTime, intervalMinutes, dayOfWeek, dayOfMonth, groupIds, userId: user.user_id });
            }
            await logActivity(user.user_id, scheduleId ? 'Updated report schedule' : 'Created report schedule', reportType, clientIp(request));
            return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie('success', 'Schedule saved.')].filter(Boolean) });
        }

        if (action === 'toggle_schedule') {
            const scheduleId = Number(form.get('schedule_id'));
            const isActive = form.get('is_active') === '1';
            await setScheduleActive(scheduleId, isActive, user.user_id);
            return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie('success', isActive ? 'Schedule resumed.' : 'Schedule paused.')].filter(Boolean) });
        }

        if (action === 'send_now') {
            const reportType = form.get('report_type').toString();
            const groupIds = form.getAll('group_ids').map(Number).filter(Number.isInteger);
            if (!groupIds.length) {
                return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie('error', 'Select at least one recipient group.')].filter(Boolean) });
            }
            const result = await sendReportNow(reportType, groupIds);
            await logActivity(user.user_id, 'Sent report email now', reportType, clientIp(request));
            return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? 'Report sent.' : `Send failed: ${result.error ?? 'unknown error'}`)].filter(Boolean) });
        }

        if (action === 'retry_log') {
            const logId = Number(form.get('log_id'));
            const rows = unwrap(await db().from('report_email_log').select('*').eq('log_id', logId).limit(1));
            if (!rows.length) return notFound();
            const result = await retryLogRow(rows[0]);
            return redirectTo('/admin/email_settings?tab=reports', { cookies: [auth.setCookie, flashSetCookie(result.ok ? 'success' : 'error', result.ok ? 'Retry succeeded.' : `Retry failed: ${result.error ?? 'unknown error'}`)].filter(Boolean) });
        }

        // action === 'save' (settings)
        const enabled = form.get('email_notifications_enabled') ? '1' : '0';
        const senderName = (form.get('email_sender_name') || '').toString().trim();
        const senderAddress = (form.get('email_sender_address') || '').toString().trim();
        const replyTo = (form.get('email_reply_to') || '').toString().trim();
        const host = (form.get('email_smtp_host') || '').toString().trim();
        const portRaw = (form.get('email_smtp_port') || '').toString().trim();
        const username = (form.get('email_smtp_username') || '').toString().trim();
        const passwordNew = (form.get('email_smtp_password_new') || '').toString();
        const encryption = ['tls', 'ssl', 'none'].includes(form.get('email_smtp_encryption')) ? form.get('email_smtp_encryption').toString() : 'tls';
        const timeoutRaw = (form.get('email_smtp_timeout_ms') || '').toString().trim();
        const portalBaseUrl = (form.get('portal_base_url') || '').toString().trim().replace(/\/+$/, '');
        const approvalExpiryRaw = (form.get('approval_token_expiry_hours') || '').toString().trim();
        const resetExpiryRaw = (form.get('password_reset_token_expiry_hours') || '').toString().trim();
        const reminderHoursRaw = (form.get('approval_reminder_hours') || '').toString().trim();
        const escalationHoursRaw = (form.get('approval_escalation_hours') || '').toString().trim();

        const errors = [];
        if (senderAddress && !EMAIL_REGEX.test(senderAddress)) errors.push('Invalid Sender Email Address.');
        if (replyTo && !EMAIL_REGEX.test(replyTo)) errors.push('Invalid Reply-To Email Address.');
        const port = Number(portRaw);
        if (portRaw && (!Number.isInteger(port) || port < 1 || port > 65535)) errors.push('Invalid SMTP Port - must be a number between 1 and 65535.');
        const timeoutMs = Number(timeoutRaw);
        if (timeoutRaw && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) errors.push('Invalid Connection Timeout - must be a positive number.');
        if (enabled === '1') {
            if (!host) errors.push('SMTP Host is required to enable email notifications.');
            if (!senderAddress) errors.push('Sender Email Address is required to enable email notifications.');
            if (!portRaw) errors.push('SMTP Port is required to enable email notifications.');
        }
        if (portalBaseUrl) {
            try {
                new URL(portalBaseUrl);
            } catch {
                errors.push('Invalid Portal Base URL.');
            }
        }
        const approvalExpiryHours = Number(approvalExpiryRaw);
        if (approvalExpiryRaw && (!Number.isFinite(approvalExpiryHours) || approvalExpiryHours <= 0)) errors.push('Invalid Approval Link Expiry - must be a positive number of hours.');
        const resetExpiryHours = Number(resetExpiryRaw);
        if (resetExpiryRaw && (!Number.isFinite(resetExpiryHours) || resetExpiryHours <= 0)) errors.push('Invalid Password Reset Link Expiry - must be a positive number of hours.');
        const reminderHoursValue = Number(reminderHoursRaw);
        if (reminderHoursRaw && (!Number.isFinite(reminderHoursValue) || reminderHoursValue <= 0)) errors.push('Invalid Reminder After - must be a positive number of hours.');
        const escalationHoursValue = Number(escalationHoursRaw);
        if (escalationHoursRaw && (!Number.isFinite(escalationHoursValue) || escalationHoursValue <= 0)) errors.push('Invalid Escalate After - must be a positive number of hours.');
        if (reminderHoursRaw && escalationHoursRaw && reminderHoursValue >= escalationHoursValue) errors.push('Escalate After must be greater than Reminder After.');

        if (errors.length) {
            const body = await settingsTabBody({ errors, csrfToken: user.csrf, testResult: null });
            return renderShellForRequest({ request, auth, pageTitle: 'Email Settings', path: '/admin/email_settings', bodyHtml: body });
        }

        const plainFields = [
            { key: 'email_notifications_enabled', label: 'Email Notifications Enabled', value: enabled },
            { key: 'email_sender_name', label: 'Sender Name', value: senderName },
            { key: 'email_sender_address', label: 'Sender Email Address', value: senderAddress },
            { key: 'email_reply_to', label: 'Reply-To Email Address', value: replyTo },
            { key: 'email_smtp_host', label: 'SMTP Host', value: host },
            { key: 'email_smtp_port', label: 'SMTP Port', value: portRaw || '587' },
            { key: 'email_smtp_username', label: 'SMTP Username', value: username },
            { key: 'email_smtp_encryption', label: 'Encryption Type', value: encryption },
            { key: 'email_smtp_timeout_ms', label: 'Connection Timeout', value: timeoutRaw || '10000' },
            { key: 'portal_base_url', label: 'Portal Base URL', value: portalBaseUrl },
            { key: 'approval_token_expiry_hours', label: 'Approval Link Expiry (hours)', value: approvalExpiryRaw || '72' },
            { key: 'password_reset_token_expiry_hours', label: 'Password Reset Link Expiry (hours)', value: resetExpiryRaw || '2' },
            { key: 'approval_reminder_hours', label: 'HOD Approval Reminder After (hours)', value: reminderHoursRaw || '24' },
            { key: 'approval_escalation_hours', label: 'HOD Approval Escalate After (hours)', value: escalationHoursRaw || '48' },
        ];

        const auditRows = [];
        for (const f of plainFields) {
            const oldVal = await getSetting(f.key, '');
            if (oldVal !== f.value) {
                auditRows.push({ event_type: 'settings_updated', actor_user_id: user.user_id, setting_key: f.label, previous_value: oldVal, new_value: f.value });
            }
            await setSetting(f.key, f.value);
        }

        if (passwordNew) {
            await setSetting('email_smtp_password_encrypted', encryptSmtpPassword(passwordNew));
            auditRows.push({ event_type: 'settings_updated', actor_user_id: user.user_id, setting_key: 'SMTP Password', previous_value: '***', new_value: '***' });
        }

        resetSettingsCache();

        if (auditRows.length) {
            unwrap(await db().from('email_audit_log').insert(auditRows));
            await logActivity(user.user_id, 'Updated email settings', auditRows.map((r) => r.setting_key).join(', '), clientIp(request));
        }

        return redirectTo('/admin/email_settings', { cookies: [auth.setCookie, flashSetCookie('success', auditRows.length ? 'Email settings saved.' : 'No changes made.')].filter(Boolean) });
    });
}
