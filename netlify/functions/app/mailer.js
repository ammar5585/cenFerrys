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

    try {
        const transport = buildTransport(settings);
        await transport.sendMail({
            from: fromHeader(settings),
            to: toEmail,
            replyTo: settings.replyTo || undefined,
            subject,
            text: body,
        });
        await logEmailEvent({ event_type: 'email_sent', recipient_email: toEmail, template_key: templateKey, related_booking_id: relatedBookingId });
    } catch (err) {
        await logEmailEvent({ event_type: 'email_failed', recipient_email: toEmail, template_key: templateKey, related_booking_id: relatedBookingId, error_message: err.message });
    }
}
