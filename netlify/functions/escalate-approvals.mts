// Netlify Scheduled Function - auto-escalates department-hierarchy
// bookings on two independent triggers (see supabase/migrations/
// 0005_escalation_queries.sql and the project's plan doc): SLA timeout
// (only for departments with auto_escalation_enabled + sla_hours set)
// and current-approver-deactivated (runs regardless of a department's
// SLA settings, since "the assigned person literally cannot act" isn't
// a timing concern). escalateApproval() itself is CAS-protected, so a
// booking a human just acted on is safely skipped, not overwritten.

import { db } from './app/db.js';
import { escalateApproval } from './app/approval.js';

export default async () => {
    const { data: slaOverdue, error: slaError } = await db().rpc('find_sla_overdue_bookings');
    if (slaError) console.error('find_sla_overdue_bookings failed:', slaError.message);

    const { data: inactiveApprover, error: inactiveError } = await db().rpc('find_inactive_approver_bookings');
    if (inactiveError) console.error('find_inactive_approver_bookings failed:', inactiveError.message);

    const candidates = [
        ...(slaOverdue ?? []).map((booking) => ({ booking, reason: 'sla_timeout' })),
        ...(inactiveApprover ?? []).map((booking) => ({ booking, reason: 'approver_inactive' })),
    ];

    // A booking could appear in both lists (SLA overdue AND its
    // approver got deactivated) - escalate it at most once per run.
    const seen = new Set();
    for (const { booking, reason } of candidates) {
        if (seen.has(booking.booking_id)) continue;
        seen.add(booking.booking_id);

        try {
            const result = await escalateApproval(booking, reason);
            if (result.escalated) {
                console.log(`Escalated booking ${booking.booking_id} to ${result.level} (reason: ${reason})`);
            }
        } catch (err) {
            console.error(`Failed to escalate booking ${booking.booking_id}:`, err.message);
        }
    }
};

export const config = {
    schedule: '*/15 * * * *',
};
