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

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PLACEHOLDER_HINTS = {
    booking_approval: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id'],
    booking_rejection: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id', 'reason'],
    booking_confirmation: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id'],
    waiting_list_promotion: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id'],
    password_reset: ['full_name', 'username', 'temp_password'],
    user_creation: ['full_name', 'username', 'temp_password'],
    ferry_reminder: ['full_name', 'route_name', 'direction', 'travel_date', 'departure_time', 'booking_id'],
};

function tabsHtml(activeTab) {
    return `<ul class="nav nav-tabs mb-3">
        <li class="nav-item"><a class="nav-link ${activeTab === 'settings' ? 'active' : ''}" href="/admin/email_settings">Settings</a></li>
        <li class="nav-item"><a class="nav-link ${activeTab === 'templates' ? 'active' : ''}" href="/admin/email_settings?tab=templates">Email Templates</a></li>
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

export function registerAdminEmailSettingsRoutes(router) {
    router.get('/admin/email_settings', async (request) => {
        const auth = await requirePermission(request, 'settings.manage_email', { pageTitle: 'Email Settings' });
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const tab = url.searchParams.get('tab') === 'templates' ? 'templates' : 'settings';
        const body = tab === 'templates'
            ? await templatesTabBody({ csrfToken: auth.user.csrf })
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
