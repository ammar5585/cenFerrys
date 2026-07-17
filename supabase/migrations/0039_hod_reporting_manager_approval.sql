-- =====================================================================
-- Approval Workflow Enhancement - HOD Email Approval via Reporting
-- Manager. Routes a new booking to the employee's actual
-- reporting_manager_id first (a real, populated per-person signal),
-- falling back to the existing department_approval_config table only
-- when unset - see netlify/functions/app/approval.js's
-- routeViaReportingManager()/routeDepartmentApproval().
--
-- 'Pending HOD Approval' is a new, distinct status (not reusing
-- 'Pending Department Manager Approval') so it's visible in the UI
-- which mechanism actually routed a given booking.
--
-- reminder_sent_at/hod_escalated_at are reset to NULL on every fresh
-- routing/reassignment (mirroring current_approval_assigned_at), so a
-- reassigned booking always gets its own full reminder/escalation
-- cycle rather than inheriting a stale one.
-- =====================================================================

INSERT INTO booking_status (status_name) VALUES ('Pending HOD Approval')
ON CONFLICT (status_name) DO NOTHING;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hod_escalated_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- New approval_reminder template ("still awaiting your approval",
-- distinct wording from approval_request's "needs your approval") -
-- same button set (mailer.js's EMAIL_ACTIONS treats it identically to
-- approval_request).
-- ---------------------------------------------------------------------
INSERT INTO email_templates (template_key, label, subject, body) VALUES
('approval_reminder', 'Approval Reminder Email',
 'Reminder: Ferry Booking Approval Still Pending',
 'Hi {{approver_name}},' || E'\n\n' ||
 'This is a reminder that a ferry booking request is still awaiting your approval.' || E'\n\n' ||
 'Employee: {{full_name}} ({{employee_id}})' || E'\n' ||
 'Designation: {{designation}}' || E'\n' ||
 'Department: {{department_name}}' || E'\n' ||
 'Resort: {{resort_name}}' || E'\n' ||
 'Travel Date: {{travel_date}}' || E'\n' ||
 'Ferry Service: {{route_name}}' || E'\n' ||
 'Boarding Location: {{boarding_location}}' || E'\n' ||
 'Destination: {{destination}}' || E'\n' ||
 'Seats: {{seats}}' || E'\n' ||
 'Purpose: {{purpose}}' || E'\n' ||
 'Booking Reference: {{booking_reference}}' || E'\n' ||
 'Submitted: {{submitted_at}}' || E'\n\n' ||
 'Please review and respond using the button below.')
ON CONFLICT (template_key) DO NOTHING;

-- ---------------------------------------------------------------------
-- approval_request's body (seeded 0038) only carried the original,
-- smaller field set - extended to match the spec's full list. Both
-- senders (approval.js's sendApprovalRequestEmail/notifyExecutives)
-- now populate every placeholder below.
-- ---------------------------------------------------------------------
UPDATE email_templates SET
    body =
        'Hi {{approver_name}},' || E'\n\n' ||
        'A ferry booking request needs your approval.' || E'\n\n' ||
        'Employee: {{full_name}} ({{employee_id}})' || E'\n' ||
        'Designation: {{designation}}' || E'\n' ||
        'Department: {{department_name}}' || E'\n' ||
        'Resort: {{resort_name}}' || E'\n' ||
        'Travel Date: {{travel_date}}' || E'\n' ||
        'Ferry Service: {{route_name}}' || E'\n' ||
        'Boarding Location: {{boarding_location}}' || E'\n' ||
        'Destination: {{destination}}' || E'\n' ||
        'Seats: {{seats}}' || E'\n' ||
        'Purpose: {{purpose}}' || E'\n' ||
        'Booking Reference: {{booking_reference}}' || E'\n' ||
        'Submitted: {{submitted_at}}' || E'\n\n' ||
        'Please review and respond using the button below.'
WHERE template_key = 'approval_request';

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Verification (same execution, per session convention).
-- ---------------------------------------------------------------------
SELECT 'Pending HOD Approval status seeded' AS check_name,
    EXISTS (SELECT 1 FROM booking_status WHERE status_name = 'Pending HOD Approval') AS passed
UNION ALL
SELECT 'bookings.reminder_sent_at column exists',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'reminder_sent_at')
UNION ALL
SELECT 'bookings.hod_escalated_at column exists',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'hod_escalated_at')
UNION ALL
SELECT 'approval_reminder template seeded',
    EXISTS (SELECT 1 FROM email_templates WHERE template_key = 'approval_reminder')
UNION ALL
SELECT 'approval_request template now references the extended field set',
    (SELECT body FROM email_templates WHERE template_key = 'approval_request') LIKE '%boarding_location%'
    AND (SELECT body FROM email_templates WHERE template_key = 'approval_request') LIKE '%submitted_at%';
