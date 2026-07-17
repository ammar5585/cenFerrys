-- =====================================================================
-- Email Enhancement - Action Links & Login URL. Adds the data model for
-- two brand-new emails that didn't exist before (approval_request,
-- booking_cancellation) plus the token infrastructure their action
-- buttons need. Everything else (the HTML/button shell, Portal Base
-- URL setting, expiry-duration settings) lives in the generic
-- `settings` key/value table and needs no migration.
--
-- booking_approval_tokens is a new table rather than columns on
-- bookings: a booking can be reassigned to a new approver multiple
-- times over its life (initial routing, then escalation), and each
-- reassignment needs its own token/expiry without invalidating the
-- history of who was asked what and when.
-- =====================================================================

CREATE TABLE IF NOT EXISTS booking_approval_tokens (
    token_id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token               TEXT NOT NULL UNIQUE,
    booking_id            INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
    approver_user_id        INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    expires_at                 TIMESTAMPTZ NOT NULL,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_approval_tokens_booking ON booking_approval_tokens(booking_id);

-- ---------------------------------------------------------------------
-- Self-service password reset: one active token per user at a time - a
-- fresh "forgot password" request simply overwrites the old token,
-- which naturally invalidates any previously-issued link.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_expires_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- Two genuinely new system emails (confirmed via code search - neither
-- exists today): approval_request (approver is asked to act, currently
-- only an in-app notification) and booking_cancellation (currently no
-- email at all on cancel).
-- ---------------------------------------------------------------------
INSERT INTO email_templates (template_key, label, subject, body) VALUES
('approval_request', 'Approval Request Email',
 'Ferry Booking Approval Required',
 'Hi {{approver_name}},' || E'\n\n' ||
 'A ferry booking request needs your approval.' || E'\n\n' ||
 'Employee: {{full_name}}' || E'\n' ||
 'Department: {{department_name}}' || E'\n' ||
 'Route: {{route_name}} ({{direction}})' || E'\n' ||
 'Date: {{travel_date}}' || E'\n' ||
 'Departure: {{departure_time}}' || E'\n' ||
 'Booking ID: {{booking_id}}' || E'\n\n' ||
 'Please review and respond using the button below.'),
('booking_cancellation', 'Booking Cancellation Email',
 'Your Ferry Booking Has Been Cancelled',
 'Hi {{full_name}},' || E'\n\n' ||
 'Your ferry booking has been cancelled.' || E'\n\n' ||
 'Route: {{route_name}} ({{direction}})' || E'\n' ||
 'Date: {{travel_date}}' || E'\n' ||
 'Departure: {{departure_time}}' || E'\n' ||
 'Booking ID: {{booking_id}}' || E'\n\n' ||
 'You can book another ferry trip at any time using the button below.')
ON CONFLICT (template_key) DO NOTHING;

-- ---------------------------------------------------------------------
-- password_reset's seeded body (0019) referenced {{temp_password}},
-- which neither sender still passes (admin.js's admin-initiated reset
-- and auth.js's new self-service flow both now mint a reset TOKEN
-- instead of emailing a plaintext password - the temp password admin.js
-- still generates stays server-side/in the admin's own success message,
-- not in the email body). Rewritten to reference the Reset Password
-- button instead, so the email doesn't render a literal, unsubstituted
-- "{{temp_password}}" placeholder.
-- ---------------------------------------------------------------------
UPDATE email_templates SET
    subject = 'Reset Your Ferry Portal Password',
    body =
        'Hi {{full_name}},' || E'\n\n' ||
        'A password reset was requested for your Ferry Portal account.' || E'\n\n' ||
        'Username: {{username}}' || E'\n\n' ||
        'Click the button below to set a new password. If you did not request this, you can safely ignore this email.'
WHERE template_key = 'password_reset';

-- ---------------------------------------------------------------------
-- user_creation's seeded body (0019) only mentioned Username/Temporary
-- Password - the spec also wants Employee ID/Role/Resort/Department,
-- which admin.js and admin_user_import.js's create-user call sites now
-- both resolve and pass (see routes/admin.js and
-- routes/admin_user_import.js).
-- ---------------------------------------------------------------------
UPDATE email_templates SET
    body =
        'Hi {{full_name}},' || E'\n\n' ||
        'An account has been created for you on the Ferry Portal.' || E'\n\n' ||
        'Employee ID: {{employee_id}}' || E'\n' ||
        'Username: {{username}}' || E'\n' ||
        'Role: {{role_name}}' || E'\n' ||
        'Resort: {{resort_name}}' || E'\n' ||
        'Department: {{department_name}}' || E'\n' ||
        'Temporary Password: {{temp_password}}' || E'\n\n' ||
        'You will be required to change this password the first time you log in.'
WHERE template_key = 'user_creation';

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Verification (same execution, per session convention).
-- ---------------------------------------------------------------------
SELECT 'booking_approval_tokens table exists' AS check_name,
    EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'booking_approval_tokens') AS passed
UNION ALL
SELECT 'users.password_reset_token column exists',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_reset_token')
UNION ALL
SELECT 'users.password_reset_token_expires_at column exists',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_reset_token_expires_at')
UNION ALL
SELECT 'approval_request template seeded',
    EXISTS (SELECT 1 FROM email_templates WHERE template_key = 'approval_request')
UNION ALL
SELECT 'booking_cancellation template seeded',
    EXISTS (SELECT 1 FROM email_templates WHERE template_key = 'booking_cancellation')
UNION ALL
SELECT 'password_reset template no longer references temp_password',
    (SELECT body FROM email_templates WHERE template_key = 'password_reset') NOT LIKE '%temp_password%'
UNION ALL
SELECT 'user_creation template now references employee_id/role_name/resort_name/department_name',
    (SELECT body FROM email_templates WHERE template_key = 'user_creation') LIKE '%employee_id%'
    AND (SELECT body FROM email_templates WHERE template_key = 'user_creation') LIKE '%role_name%'
    AND (SELECT body FROM email_templates WHERE template_key = 'user_creation') LIKE '%resort_name%'
    AND (SELECT body FROM email_templates WHERE template_key = 'user_creation') LIKE '%department_name%';
