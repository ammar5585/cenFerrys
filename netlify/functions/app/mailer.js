// Central outbound-email module: loads Email Settings (settings.js's
// generic key/value table, same as admin_settings.js/admin_branding.js),
// builds a nodemailer SMTP transport, and sends the 7 system email
// templates (email_templates table, migration 0019). Every attempt -
// sent, failed, or skipped because notifications are disabled - is
// logged to email_audit_log, per the spec's "email events shall
// continue to be logged" business rule.

import nodemailer from 'nodemailer';
import { db, unwrap } from './db.js';
import { getSetting } from './settings.js';
import { encrypt, decrypt } from './emailCrypto.js';
import { h } from './templates/html.js';

const EMAIL_SETTING_KEYS = [
    'email_notifications_enabled',
    'email_sender_name',
    'email_sender_address',
    'email_reply_to',
    'email_smtp_host',
    'email_smtp_port',
    'email_smtp_username',
    'email_smtp_password_encrypted',
    'email_smtp_encryption',
    'email_smtp_timeout_ms',
];

export async function getEmailSettings() {
    const entries = await Promise.all(EMAIL_SETTING_KEYS.map(async (key) => [key, await getSetting(key, '')]));
    const raw = Object.fromEntries(entries);
    return {
        enabled: raw.email_notifications_enabled === '1',
        senderName: raw.email_sender_name || '',
        senderAddress: raw.email_sender_address || '',
        replyTo: raw.email_reply_to || '',
        host: raw.email_smtp_host || '',
        port: Number(raw.email_smtp_port) || 587,
        username: raw.email_smtp_username || '',
        password: decrypt(raw.email_smtp_password_encrypted) || '',
        encryption: raw.email_smtp_encryption || 'tls',
        timeoutMs: Number(raw.email_smtp_timeout_ms) || 10000,
    };
}

/** Encrypts and returns the ciphertext to store - kept here so callers never import emailCrypto directly. */
export function encryptSmtpPassword(plaintext) {
    return encrypt(plaintext);
}

function buildTransport(settings) {
    return nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.encryption === 'ssl',
        requireTLS: settings.encryption === 'tls',
        ignoreTLS: settings.encryption === 'none',
        auth: settings.username ? { user: settings.username, pass: settings.password } : undefined,
        connectionTimeout: settings.timeoutMs,
        greetingTimeout: settings.timeoutMs,
        socketTimeout: settings.timeoutMs,
    });
}

function fromHeader(settings) {
    return settings.senderName ? `"${settings.senderName}" <${settings.senderAddress}>` : settings.senderAddress;
}

async function logEmailEvent(fields) {
    unwrap(await db().from('email_audit_log').insert(fields));
}

/** Used by the /admin/email_settings "Send Test Email" button - always tests the currently-SAVED settings. */
export async function sendTestEmail(recipientEmail) {
    const settings = await getEmailSettings();
    if (!settings.host || !settings.senderAddress) {
        return { ok: false, error: 'SMTP host and Sender Email Address must be configured before sending a test email.' };
    }
    try {
        const transport = buildTransport(settings);
        await transport.sendMail({
            from: fromHeader(settings),
            to: recipientEmail,
            replyTo: settings.replyTo || undefined,
            subject: 'Ferry Portal - Test Email',
            text: 'This is a test email from the Ferry Portal Email Settings page. If you received this, your SMTP configuration is working correctly.',
        });
        await logEmailEvent({ event_type: 'test_email', recipient_email: recipientEmail });
        return { ok: true };
    } catch (err) {
        await logEmailEvent({ event_type: 'test_email', recipient_email: recipientEmail, error_message: err.message });
        return { ok: false, error: err.message };
    }
}

function interpolate(template, variables) {
    return template.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (key in variables ? String(variables[key] ?? '') : match));
}

/**
 * The portal's own absolute base URL, for links inside outbound emails.
 * `portal_base_url` (admin-configured, /admin/email_settings) always
 * wins; falls back to Vercel's own auto-populated deployment URL env
 * vars so links aren't broken before an admin sets it - these work
 * uniformly whether the send was triggered by an HTTP request or a
 * cron job, unlike threading a request's Origin header through every
 * sendTemplatedEmail call site (most of which have no request at all -
 * e.g. api/cron/ferry-reminder.js).
 */
export async function getPortalBaseUrl() {
    const configured = await getSetting('portal_base_url', '');
    if (configured) return configured.replace(/\/+$/, '');
    const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    return vercelHost ? `https://${vercelHost}` : 'http://localhost:3000';
}

export function buildPortalUrl(baseUrl, path, query = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query)) {
        if (value != null) url.searchParams.set(key, value);
    }
    return url.toString();
}

function bookingViewButtons(relatedBookingId, baseUrl) {
    if (!relatedBookingId) return [];
    return [
        { label: 'View Booking', url: buildPortalUrl(baseUrl, '/staff/print_confirmation', { id: relatedBookingId }), style: 'secondary' },
        { label: 'My Bookings', url: buildPortalUrl(baseUrl, '/staff/my_bookings'), style: 'secondary' },
    ];
}

/**
 * Open Dashboard / View Reports / Login - shared by both scheduled
 * report emails (dailyOperationsReport.js/reportEmailScheduling.js).
 * Neither report is addressed to a single role (recipient groups mix
 * Management/HR/Security/Administration), so both links use role-
 * agnostic entry points rather than a specific dashboard/report route.
 */
export function reportEmailButtons({ portalBaseUrl }) {
    return [
        { label: 'Open Dashboard', url: buildPortalUrl(portalBaseUrl, '/dashboard'), style: 'secondary' },
        { label: 'View Reports', url: buildPortalUrl(portalBaseUrl, '/admin/reports'), style: 'secondary' },
        { label: 'Login to Portal', url: buildPortalUrl(portalBaseUrl, '/auth/login'), style: 'primary' },
    ];
}

/**
 * Per-template-key action buttons - deliberately code-defined, not
 * admin-editable, so "every email includes Login" (appended separately
 * by sendTemplatedEmail itself, see below) can't be broken by a
 * template edit, and token URLs never need to be hand-typed into the
 * plain-text Templates tab. Each entry receives the same `variables`
 * passed to sendTemplatedEmail() plus `relatedBookingId`.
 */
const EMAIL_ACTIONS = {
    approval_request: (variables, relatedBookingId, baseUrl) => {
        if (!variables.approvalToken) return [];
        const token = variables.approvalToken;
        return [
            { label: 'View Request', url: buildPortalUrl(baseUrl, '/approval', { token }), style: 'secondary' },
            { label: 'Approve Booking', url: buildPortalUrl(baseUrl, '/approval', { token, intent: 'approve' }), style: 'success' },
            { label: 'Reject Booking', url: buildPortalUrl(baseUrl, '/approval', { token, intent: 'reject' }), style: 'danger' },
        ];
    },
    booking_approval: (variables, relatedBookingId, baseUrl) => bookingViewButtons(relatedBookingId, baseUrl),
    booking_rejection: (variables, relatedBookingId, baseUrl) => bookingViewButtons(relatedBookingId, baseUrl),
    booking_confirmation: (variables, relatedBookingId, baseUrl) => bookingViewButtons(relatedBookingId, baseUrl),
    waiting_list_promotion: (variables, relatedBookingId, baseUrl) =>
        relatedBookingId ? [{ label: 'View Booking', url: buildPortalUrl(baseUrl, '/staff/print_confirmation', { id: relatedBookingId }), style: 'secondary' }] : [],
    ferry_transfer: (variables, relatedBookingId, baseUrl) =>
        relatedBookingId ? [{ label: 'View Booking', url: buildPortalUrl(baseUrl, '/staff/print_confirmation', { id: relatedBookingId }), style: 'secondary' }] : [],
    ferry_reminder: (variables, relatedBookingId, baseUrl) => [{ label: 'My Bookings', url: buildPortalUrl(baseUrl, '/staff/my_bookings'), style: 'secondary' }],
    booking_cancellation: (variables, relatedBookingId, baseUrl) => [
        ...(relatedBookingId ? [{ label: 'View Booking', url: buildPortalUrl(baseUrl, '/staff/print_confirmation', { id: relatedBookingId }), style: 'secondary' }] : []),
        { label: 'Book Another Ferry', url: buildPortalUrl(baseUrl, '/staff/book'), style: 'secondary' },
    ],
    user_creation: (variables, relatedBookingId, baseUrl) =>
        variables.mustChangePassword ? [{ label: 'Change Password', url: buildPortalUrl(baseUrl, '/auth/change_password'), style: 'secondary' }] : [],
    password_reset: (variables, relatedBookingId, baseUrl) =>
        variables.resetToken ? [{ label: 'Reset Password', url: buildPortalUrl(baseUrl, '/auth/reset_password', { token: variables.resetToken }), style: 'secondary' }] : [],
};

/** HTML-escapes an already-{{placeholder}}-substituted template AND every value substituted into it - the template `body` is admin-authored free text (Templates tab), not trusted markup, so it gets the same escaping as user-controlled variable values (full_name, reason, etc.), not just the latter. */
function interpolateEscaped(escapedTemplate, variables) {
    return escapedTemplate.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (key in variables ? h(variables[key]) : match));
}

function bodyToHtml(rawBody, variables) {
    const interpolated = interpolateEscaped(h(rawBody), variables);
    return interpolated
        .split(/\n{2,}/)
        .map((para) => `<p style="margin:0 0 14px;">${para.replace(/\n/g, '<br>')}</p>`)
        .join('');
}

const BUTTON_COLORS = {
    primary: (brand) => ({ bg: brand, text: '#FFFFFF', border: brand }),
    secondary: (brand) => ({ bg: '#FFFFFF', text: brand, border: brand }),
    success: () => ({ bg: '#16A34A', text: '#FFFFFF', border: '#16A34A' }),
    danger: () => ({ bg: '#DC2626', text: '#FFFFFF', border: '#DC2626' }),
};

/** A single "bulletproof button" - table/VML fallback for Outlook's Word rendering engine (no border-radius/background support without it), a plain styled <a> for every other client. Rounded corners, large touch target (44px line-height), full-width-capped so it scales on mobile. */
function buttonHtml({ label, url }, style, brandColor) {
    const colors = (BUTTON_COLORS[style] || BUTTON_COLORS.secondary)(brandColor);
    const safeLabel = h(label);
    const safeUrl = h(url);
    return `<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeUrl}" style="height:46px;v-text-anchor:middle;width:260px;" arcsize="12%" strokecolor="${colors.border}" fillcolor="${colors.bg}">
<w:anchorlock/>
<center style="color:${colors.text};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${safeLabel}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<a href="${safeUrl}" target="_blank" rel="noopener" style="background-color:${colors.bg};border:2px solid ${colors.border};border-radius:8px;color:${colors.text};display:inline-block;font-family:Arial,sans-serif;font-size:15px;font-weight:600;line-height:44px;text-align:center;text-decoration:none;width:260px;max-width:100%;-webkit-text-size-adjust:none;">${safeLabel}</a>
<!--<![endif]-->`;
}

/** Buttons stack one per row (not side-by-side columns) - the simplest layout that's inherently mobile-responsive with zero media queries, and keeps every button a full-width, large touch target on a phone. */
function buttonsHtml(buttons, brandColor) {
    return buttons.map((btn) => `<tr><td align="center" style="padding:8px 0;">${buttonHtml(btn, btn.style, brandColor)}</td></tr>`).join('');
}

/**
 * The shared HTML email shell - table-based layout, inline CSS, VML
 * Outlook fallback, 600px fluid container - used by every
 * sendTemplatedEmail() send AND the scheduled-report emails
 * (reportEmailScheduling.js/dailyOperationsReport.js import this
 * directly), so there is exactly one button/branding implementation in
 * the whole app rather than parallel bespoke HTML per feature.
 */
export function buildEmailHtml({ companyName, siteLogo, brandColor, bodyHtml, buttons }) {
    const color = brandColor || '#0d6efd';
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(companyName)}</title>
</head>
<body style="margin:0;padding:0;background-color:#F1F5F9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F1F5F9;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background-color:#FFFFFF;border-radius:12px;overflow:hidden;">
<tr><td style="background-color:${color};padding:20px 32px;">
${siteLogo ? `<img src="${h(siteLogo)}" alt="${h(companyName)}" height="32" style="display:block;">` : `<span style="color:#FFFFFF;font-size:18px;font-weight:700;">${h(companyName)}</span>`}
</td></tr>
<tr><td style="padding:32px;color:#0F172A;font-size:15px;line-height:1.6;">
${bodyHtml}
${buttons.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;width:100%;">${buttonsHtml(buttons, color)}</table>` : ''}
</td></tr>
<tr><td style="padding:20px 32px;background-color:#F8FAFC;border-top:1px solid #E2E8F0;color:#94A3B8;font-size:11px;text-align:center;">
${h(companyName)} Staff Transfer Portal &middot; Automatically Generated Email &middot; Confidential - Internal Use Only
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The hook every business-logic call site uses. Never throws - callers
 * wrap this in deferBestEffort() (deferred.js) exactly like
 * logActivity()/createNotification(), so a slow/failing SMTP round-trip
 * never blocks the response that triggered it.
 */
/**
 * Sibling to sendTemplatedEmail() above, not a replacement - that one
 * stays exactly as-is for the 7 transactional templates. This is for
 * the Automated Daily Operations Report Email feature
 * (reportEmailScheduling.js): supports multiple to/cc/bcc recipients
 * and real attachments (nodemailer supports both natively), and
 * returns { ok, smtpResponse, error } instead of being fire-and-forget
 * void, since the caller needs to log richer delivery detail
 * (report_email_log) than sendTemplatedEmail()'s email_audit_log ever
 * captures. Does NOT check the notifications_enabled setting - report
 * schedules have their own is_active flag as the on/off switch.
 */
export async function sendReportEmail({ to, cc, bcc, subject, html, attachments }) {
    const settings = await getEmailSettings();
    if (!settings.host || !settings.senderAddress) {
        return { ok: false, error: 'SMTP host and Sender Email Address must be configured before sending report emails.' };
    }
    try {
        const transport = buildTransport(settings);
        const info = await transport.sendMail({
            from: fromHeader(settings),
            to: Array.isArray(to) ? to.join(', ') : to,
            cc: cc && (Array.isArray(cc) ? cc.join(', ') : cc) || undefined,
            bcc: bcc && (Array.isArray(bcc) ? bcc.join(', ') : bcc) || undefined,
            replyTo: settings.replyTo || undefined,
            subject,
            html,
            attachments,
        });
        return { ok: true, smtpResponse: info.response, senderEmail: settings.senderAddress };
    } catch (err) {
        return { ok: false, error: err.message, senderEmail: settings.senderAddress };
    }
}

export async function sendTemplatedEmail(templateKey, toEmail, variables = {}, { relatedBookingId = null } = {}) {
    if (!toEmail) return;

    const settings = await getEmailSettings();
    if (!settings.enabled) {
        await logEmailEvent({ event_type: 'email_skipped', recipient_email: toEmail, template_key: templateKey, related_booking_id: relatedBookingId, error_message: 'Email notifications are disabled.' });
        return;
    }

    const templateRows = unwrap(await db().from('email_templates').select('subject, body').eq('template_key', templateKey).limit(1));
    if (!templateRows.length) {
        await logEmailEvent({ event_type: 'email_failed', recipient_email: toEmail, template_key: templateKey, related_booking_id: relatedBookingId, error_message: `No email template found for key "${templateKey}".` });
        return;
    }
    const subject = interpolate(templateRows[0].subject, variables);
    const body = interpolate(templateRows[0].body, variables);

    const [companyName, siteLogo, brandColor, portalBaseUrl] = await Promise.all([
        getSetting('company_name', 'Staff Ferry Transfer Portal'),
        getSetting('site_logo', ''),
        getSetting('theme_primary_color', '#0d6efd'),
        getPortalBaseUrl(),
    ]);
    const buttons = (EMAIL_ACTIONS[templateKey]?.(variables, relatedBookingId, portalBaseUrl) ?? []).concat({
        label: 'Login to Portal',
        url: buildPortalUrl(portalBaseUrl, '/auth/login'),
        style: 'primary',
    });
    const html = buildEmailHtml({
        companyName,
        siteLogo,
        brandColor,
        bodyHtml: bodyToHtml(templateRows[0].body, variables),
        buttons,
    });

    try {
        const transport = buildTransport(settings);
        await transport.sendMail({
            from: fromHeader(settings),
            to: toEmail,
            replyTo: settings.replyTo || undefined,
            subject,
            text: body,
            html,
        });
        await logEmailEvent({ event_type: 'email_sent', recipient_email: toEmail, template_key: templateKey, related_booking_id: relatedBookingId });
    } catch (err) {
        await logEmailEvent({ event_type: 'email_failed', recipient_email: toEmail, template_key: templateKey, related_booking_id: relatedBookingId, error_message: err.message });
    }
}
