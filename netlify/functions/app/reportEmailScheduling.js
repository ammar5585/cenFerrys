// Automated Daily Operations Report Email - schedule/recipient-group CRUD,
// recipient resolution, and the actual send/retry orchestration. The new
// "Report Emails" tab (admin_email_settings.js) is the only caller of the
// CRUD exports; api/cron/send-scheduled-reports.js is the only caller of
// runDueSchedules()/retryFailedEmails().

import { db, unwrap } from './db.js';
import { getSetting } from './settings.js';
import { formatDate } from './format.js';
import { h } from './templates/html.js';
import { sendReportEmail } from './mailer.js';
import { getDailyOperationsReportData, buildDailyOperationsWorkbook, dailyOperationsEmailHtml, todayInMaldives } from './dailyOperationsReport.js';
import { REPORT_TYPES, buildReportWorkbook } from './routes/reports.js';

const MALDIVES_OFFSET_MS = 5 * 60 * 60 * 1000;
const MAX_AUTO_RETRIES = 3;

function nowInMaldives() {
    return new Date(Date.now() + MALDIVES_OFFSET_MS);
}

async function getReportMeta() {
    const companyName = await getSetting('company_name', 'Staff Ferry Transfer Portal');
    return { companyName, generatedByName: 'Automated Report Scheduler' };
}

// ---------------------------------------------------------------------
// Recipient groups
// ---------------------------------------------------------------------

export async function listRecipientGroups() {
    const [groups, roleLinks, emails, roles] = await Promise.all([
        db().from('report_recipient_groups').select('*').order('group_id').then(unwrap),
        db().from('report_recipient_group_roles').select('group_id, role_id, roles(role_name)').then(unwrap),
        db().from('report_recipient_group_emails').select('*').order('email_id').then(unwrap),
        db().from('roles').select('role_id, role_name').order('role_name').then(unwrap),
    ]);
    return {
        groups: groups.map((g) => ({
            ...g,
            roles: roleLinks.filter((r) => r.group_id === g.group_id).map((r) => ({ role_id: r.role_id, role_name: r.roles?.role_name ?? '' })),
            emails: emails.filter((e) => e.group_id === g.group_id),
        })),
        allRoles: roles,
    };
}

/** Replace-all: the "edit roles for this group" picker submits the full desired set. */
export async function setGroupRoles(groupId, roleIds) {
    unwrap(await db().from('report_recipient_group_roles').delete().eq('group_id', groupId));
    if (roleIds.length) {
        unwrap(await db().from('report_recipient_group_roles').insert(roleIds.map((role_id) => ({ group_id: groupId, role_id }))));
    }
}

export async function addGroupEmail(groupId, email, recipientType = 'to') {
    unwrap(await db().from('report_recipient_group_emails').insert({ group_id: groupId, email, recipient_type: recipientType }));
}

export async function removeGroupEmail(emailId) {
    unwrap(await db().from('report_recipient_group_emails').delete().eq('email_id', emailId));
}

/** Role-based active users' emails (always "to") + manually-added addresses (their own to/cc/bcc type), deduped across every group in groupIds. */
export async function resolveRecipients(groupIds) {
    if (!groupIds.length) return { to: [], cc: [], bcc: [] };
    const [roleRows, emailRows] = await Promise.all([
        db().from('report_recipient_group_roles').select('role_id').in('group_id', groupIds).then(unwrap),
        db().from('report_recipient_group_emails').select('email, recipient_type').in('group_id', groupIds).then(unwrap),
    ]);
    const roleIds = [...new Set(roleRows.map((r) => r.role_id))];
    const roleUserEmails = roleIds.length
        ? unwrap(await db().from('users').select('email').in('role_id', roleIds).eq('status', 'active')).map((u) => u.email).filter(Boolean)
        : [];

    const buckets = { to: new Set(), cc: new Set(), bcc: new Set() };
    for (const email of roleUserEmails) buckets.to.add(email);
    for (const row of emailRows) if (row.email) buckets[row.recipient_type].add(row.email);
    return { to: [...buckets.to], cc: [...buckets.cc], bcc: [...buckets.bcc] };
}

// ---------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------

export async function listSchedules() {
    const [schedules, links, groups] = await Promise.all([
        db().from('report_schedules').select('*').order('schedule_id').then(unwrap),
        db().from('report_schedule_recipient_groups').select('schedule_id, group_id').then(unwrap),
        db().from('report_recipient_groups').select('group_id, group_name').then(unwrap),
    ]);
    const groupsById = new Map(groups.map((g) => [g.group_id, g.group_name]));
    return schedules.map((s) => ({
        ...s,
        recipientGroups: links.filter((l) => l.schedule_id === s.schedule_id).map((l) => ({ group_id: l.group_id, group_name: groupsById.get(l.group_id) ?? '' })),
    }));
}

async function setScheduleRecipientGroups(scheduleId, groupIds) {
    unwrap(await db().from('report_schedule_recipient_groups').delete().eq('schedule_id', scheduleId));
    if (groupIds.length) {
        unwrap(await db().from('report_schedule_recipient_groups').insert(groupIds.map((group_id) => ({ schedule_id: scheduleId, group_id }))));
    }
}

/** 'interval' schedules have no time-of-day - send_time/day_of_week/day_of_month are meaningless for them (gated purely by elapsed time since last_run_at, see isDue()); everything else uses send_time and has no interval_minutes. Mirrors the DB's report_schedules_frequency_fields_check. */
function scheduleFieldsForFrequency(frequency, { sendTime, intervalMinutes, dayOfWeek, dayOfMonth }) {
    if (frequency === 'interval') {
        return { send_time: null, interval_minutes: intervalMinutes, day_of_week: null, day_of_month: null };
    }
    return { send_time: sendTime, interval_minutes: null, day_of_week: dayOfWeek ?? null, day_of_month: dayOfMonth ?? null };
}

export async function createSchedule({ reportType, frequency, sendTime, intervalMinutes, dayOfWeek, dayOfMonth, groupIds, userId }) {
    const rows = unwrap(
        await db()
            .from('report_schedules')
            .insert({ report_type: reportType, frequency, ...scheduleFieldsForFrequency(frequency, { sendTime, intervalMinutes, dayOfWeek, dayOfMonth }), created_by_user_id: userId, updated_by_user_id: userId })
            .select('schedule_id')
    );
    const scheduleId = rows[0].schedule_id;
    await setScheduleRecipientGroups(scheduleId, groupIds ?? []);
    return scheduleId;
}

export async function updateSchedule(scheduleId, { frequency, sendTime, intervalMinutes, dayOfWeek, dayOfMonth, isActive, groupIds, userId }) {
    unwrap(
        await db()
            .from('report_schedules')
            .update({ frequency, ...scheduleFieldsForFrequency(frequency, { sendTime, intervalMinutes, dayOfWeek, dayOfMonth }), is_active: isActive, updated_by_user_id: userId })
            .eq('schedule_id', scheduleId)
    );
    if (groupIds) await setScheduleRecipientGroups(scheduleId, groupIds);
}

export async function setScheduleActive(scheduleId, isActive, userId) {
    unwrap(await db().from('report_schedules').update({ is_active: isActive, updated_by_user_id: userId }).eq('schedule_id', scheduleId));
}

// ---------------------------------------------------------------------
// Report payload assembly - shared by scheduled sends, manual "Send Now",
// and retries, so all 3 paths produce byte-identical attachments/HTML for
// the same report type + travel date.
// ---------------------------------------------------------------------

const TH = 'padding:6px 10px;text-align:left;font-size:11px;color:#475569;border-bottom:1px solid #E2E8F0;';
const TD = 'padding:6px 10px;font-size:12px;border-bottom:1px solid #E2E8F0;';

function passengerManifestEmailHtml(rows, def, travelDate, companyName) {
    const header = `<tr>${def.columns.map((c) => `<th style="${TH}">${h(c.header)}</th>`).join('')}</tr>`;
    const body = rows.map((r) => `<tr>${def.columns.map((c) => `<td style="${TD}">${h(String(c.get(r) ?? ''))}</td>`).join('')}</tr>`).join('');
    return `<div style="font-family:Arial,Helvetica,sans-serif;color:#0F172A;max-width:900px;">
<h2 style="font-size:18px;margin-bottom:0;">${h(companyName)} - ${h(def.label)}</h2>
<p style="color:#475569;font-size:12px;margin-top:4px;">${formatDate(travelDate)} &middot; ${rows.length} record(s)</p>
<table style="border-collapse:collapse;width:100%;">${header}${body}</table>
<p style="color:#94A3B8;font-size:9px;margin-top:24px;">Automatically Generated Report &middot; ${h(companyName)} Staff Transfer Portal &middot; Confidential - Internal Use Only</p>
</div>`;
}

async function buildReportPayload(reportType, travelDate) {
    const meta = await getReportMeta();
    if (reportType === 'daily_operations') {
        const data = await getDailyOperationsReportData(travelDate);
        const buffer = await buildDailyOperationsWorkbook(data, meta);
        return {
            buffer,
            html: dailyOperationsEmailHtml(data, meta),
            filename: `daily_operations_report_${travelDate}.xlsx`,
            subject: `${meta.companyName} - Daily Operations Report - ${formatDate(travelDate)}`,
        };
    }
    if (reportType === 'passenger_manifest') {
        const def = REPORT_TYPES.passenger_manifest;
        const filters = { dateFrom: travelDate, dateTo: travelDate };
        const rows = await def.fetchRows(filters);
        const buffer = await buildReportWorkbook({ reportType: 'passenger_manifest', reportLabel: def.label, companyName: meta.companyName, generatedByName: meta.generatedByName, filters, filterOptions: {}, columns: def.columns, rows, def });
        return {
            buffer,
            html: passengerManifestEmailHtml(rows, def, travelDate, meta.companyName),
            filename: `passenger_manifest_${travelDate}.xlsx`,
            subject: `${meta.companyName} - Passenger Manifest - ${formatDate(travelDate)}`,
        };
    }
    throw new Error(`Unknown report_type "${reportType}"`);
}

/** Builds the report, sends it, and writes one report_email_log row - the single code path every sender (schedule, manual, retry) funnels through. */
async function sendAndLog({ reportType, scheduleId, groupIds }) {
    const travelDate = todayInMaldives();
    const recipients = await resolveRecipients(groupIds);
    if (!recipients.to.length && !recipients.cc.length && !recipients.bcc.length) {
        unwrap(
            await db().from('report_email_log').insert({
                schedule_id: scheduleId,
                report_type: reportType,
                delivery_status: 'failed',
                error_message: 'No recipients resolved for the selected recipient group(s).',
            })
        );
        return { ok: false };
    }

    const payload = await buildReportPayload(reportType, travelDate);
    const result = await sendReportEmail({
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: payload.subject,
        html: payload.html,
        attachments: [{ filename: payload.filename, content: payload.buffer }],
    });

    unwrap(
        await db().from('report_email_log').insert({
            schedule_id: scheduleId,
            report_type: reportType,
            sender_email: result.senderEmail ?? null,
            recipients_to: recipients.to.join(', ') || null,
            recipients_cc: recipients.cc.join(', ') || null,
            recipients_bcc: recipients.bcc.join(', ') || null,
            attachments: payload.filename,
            sent_at: result.ok ? new Date().toISOString() : null,
            delivery_status: result.ok ? 'sent' : 'failed',
            smtp_response: result.smtpResponse ?? null,
            error_message: result.error ?? null,
        })
    );
    return result;
}

/** Manual "Send Now" - bypasses the schedule entirely (schedule_id stays null in the log, matching the "manual send option" business rule). */
export async function sendReportNow(reportType, groupIds) {
    return sendAndLog({ reportType, scheduleId: null, groupIds });
}

// ---------------------------------------------------------------------
// Cron entry points
// ---------------------------------------------------------------------

/**
 * 'interval' schedules (e.g. "Every 30 Minutes") are gated purely by
 * elapsed real time since last_run_at - no day-of-week/time-of-day
 * concept applies, so they're checked against `nowMs` (a real UTC
 * instant) rather than the Maldives-shifted `now` the other frequencies
 * use. Everything else fires at most once per Maldives calendar day, at
 * or after its configured time-of-day.
 */
function isDue(schedule, now, nowMs) {
    if (schedule.frequency === 'interval') {
        if (!schedule.last_run_at) return true;
        const elapsedMinutes = (nowMs - new Date(schedule.last_run_at).getTime()) / 60000;
        return elapsedMinutes >= schedule.interval_minutes;
    }

    if (schedule.frequency === 'weekly' && schedule.day_of_week != null && schedule.day_of_week !== now.getUTCDay()) return false;
    if (schedule.frequency === 'monthly' && schedule.day_of_month != null && schedule.day_of_month !== now.getUTCDate()) return false;
    if (schedule.frequency === 'custom') {
        if (schedule.day_of_week != null && schedule.day_of_week !== now.getUTCDay()) return false;
        if (schedule.day_of_month != null && schedule.day_of_month !== now.getUTCDate()) return false;
    }

    const nowHm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const sendHm = schedule.send_time.slice(0, 5);
    if (nowHm < sendHm) return false;

    if (schedule.last_run_at) {
        const todayStr = now.toISOString().slice(0, 10);
        const lastRunMaldivesDate = new Date(new Date(schedule.last_run_at).getTime() + MALDIVES_OFFSET_MS).toISOString().slice(0, 10);
        if (lastRunMaldivesDate === todayStr) return false;
    }
    return true;
}

/**
 * Fires every active schedule that is due: 'interval' schedules by
 * elapsed time since last_run_at, everything else at most once per
 * Maldives calendar day at/after its configured time-of-day.
 * last_run_at is the only concurrency guard - correct because this is
 * called from a single GitHub Actions poll, never in parallel with
 * itself, and a missed poll (server down, etc.) still sends as soon as
 * the next poll catches up, rather than being skipped - "reports always
 * reflect latest data" outweighs precise timing.
 */
export async function runDueSchedules() {
    const now = nowInMaldives();
    const nowMs = Date.now();

    const schedules = unwrap(await db().from('report_schedules').select('*, report_schedule_recipient_groups(group_id)').eq('is_active', true));
    const results = [];
    for (const schedule of schedules) {
        if (!isDue(schedule, now, nowMs)) continue;

        const groupIds = schedule.report_schedule_recipient_groups.map((g) => g.group_id);
        const result = groupIds.length
            ? await sendAndLog({ reportType: schedule.report_type, scheduleId: schedule.schedule_id, groupIds })
            : { ok: false, error: 'No recipient groups assigned to this schedule.' };
        unwrap(await db().from('report_schedules').update({ last_run_at: new Date().toISOString() }).eq('schedule_id', schedule.schedule_id));
        results.push({ scheduleId: schedule.schedule_id, ...result });
    }
    return results;
}

/** Re-attempts recent failed sends, up to MAX_AUTO_RETRIES per row, per the "failed deliveries automatically retry" business rule. */
export async function retryFailedEmails() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const failedRows = unwrap(
        await db()
            .from('report_email_log')
            .select('*')
            .eq('delivery_status', 'failed')
            .lt('retry_count', MAX_AUTO_RETRIES)
            .gte('created_at', cutoff)
    );
    const results = [];
    for (const row of failedRows) {
        results.push(await retryLogRow(row));
    }
    return results;
}

/** Shared by the automatic cron retry pass and the admin "Retry" button on a single failed row. */
export async function retryLogRow(row) {
    if (!row.recipients_to && !row.recipients_cc && !row.recipients_bcc) {
        unwrap(await db().from('report_email_log').update({ retry_count: row.retry_count + 1 }).eq('log_id', row.log_id));
        return { ok: false };
    }
    const travelDate = todayInMaldives();
    const payload = await buildReportPayload(row.report_type, travelDate);
    const result = await sendReportEmail({
        to: row.recipients_to ? row.recipients_to.split(', ') : [],
        cc: row.recipients_cc ? row.recipients_cc.split(', ') : [],
        bcc: row.recipients_bcc ? row.recipients_bcc.split(', ') : [],
        subject: payload.subject,
        html: payload.html,
        attachments: [{ filename: payload.filename, content: payload.buffer }],
    });
    unwrap(
        await db()
            .from('report_email_log')
            .update({
                delivery_status: result.ok ? 'sent' : 'failed',
                sent_at: result.ok ? new Date().toISOString() : null,
                smtp_response: result.smtpResponse ?? row.smtp_response,
                error_message: result.error ?? null,
                retry_count: row.retry_count + 1,
            })
            .eq('log_id', row.log_id)
    );
    return result;
}

export async function listEmailLog({ page = 1, pageSize = 25 } = {}) {
    const from = (page - 1) * pageSize;
    const { data, count, error } = await db()
        .from('report_email_log')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message || 'Database error');
    return { rows: data, total: count ?? data.length };
}
