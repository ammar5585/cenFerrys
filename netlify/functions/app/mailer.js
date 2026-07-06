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
