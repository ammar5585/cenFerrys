-- =====================================================================
-- Email Settings module: lets an Administrator configure outbound SMTP
-- (host/port/credentials/encryption), enable/disable email sending, and
-- edit the wording of 7 system email templates, all from the portal -
-- no code or environment-variable changes needed. The actual SMTP
-- host/port/username/sender fields reuse the existing generic
-- `settings` key/value table (settings.js) exactly like admin_settings.js
-- and admin_branding.js already do; the SMTP password is the one value
-- that needs to be reversibly encrypted (not hashed, since it must be
-- decrypted again to actually send mail) - see
-- netlify/functions/app/emailCrypto.js for the AES-256-GCM
-- implementation, keyed off the existing JWT_SECRET so no new
-- environment variable needs to be provisioned.
-- =====================================================================

-- ---------------------------------------------------------------------
-- email_templates: 7 fixed, seeded rows (one per system email event).
-- Subject/body support {{placeholder}} interpolation, done in
-- mailer.js's sendTemplatedEmail() - not a Postgres-side concern.
-- ---------------------------------------------------------------------
CREATE TABLE email_templates (
    template_key        TEXT PRIMARY KEY,
    label                TEXT NOT NULL,
    subject               TEXT NOT NULL,
    body                   TEXT NOT NULL,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by_user_id        INTEGER REFERENCES users(user_id) ON DELETE SET NULL
);

INSERT INTO email_templates (template_key, label, subject, body) VALUES
('booking_approval', 'Booking Approval Email',
 'Your Ferry Booking Has Been Approved',
 'Hi {{full_name}},' || E'\n\n' ||
 'Your ferry booking has been approved.' || E'\n\n' ||
 'Route: {{route_name}} ({{direction}})' || E'\n' ||
 'Date: {{travel_date}}' || E'\n' ||
 'Departure: {{departure_time}}' || E'\n' ||
 'Booking ID: {{booking_id}}' || E'\n\n' ||
 'Thank you.'),
('booking_rejection', 'Booking Rejection Email',
 'Your Ferry Booking Has Been Rejected',
 'Hi {{full_name}},' || E'\n\n' ||
 'Your ferry booking request could not be approved.' || E'\n\n' ||
 'Route: {{route_name}} ({{direction}})' || E'\n' ||
 'Date: {{travel_date}}' || E'\n' ||
 'Departure: {{departure_time}}' || E'\n' ||
 'Booking ID: {{booking_id}}' || E'\n' ||
 'Reason: {{reason}}' || E'\n\n' ||
 'Please contact your department for further assistance.'),
('booking_confirmation', 'Booking Confirmation Email',
 'Ferry Booking Submitted',
 'Hi {{full_name}},' || E'\n\n' ||
 'Your ferry booking request has been submitted and is awaiting approval.' || E'\n\n' ||
 'Route: {{route_name}} ({{direction}})' || E'\n' ||
 'Date: {{travel_date}}' || E'\n' ||
 'Departure: {{departure_time}}' || E'\n' ||
 'Booking ID: {{booking_id}}' || E'\n\n' ||
 'You will be notified once a decision has been made.'),
('waiting_list_promotion', 'Waiting List Promotion Email',
 'You Have Been Moved Off the Waiting List',
 'Hi {{full_name}},' || E'\n\n' ||
 'A seat has become available and your booking has been promoted from the waiting list to Approved.' || E'\n\n' ||
 'Route: {{route_name}} ({{direction}})' || E'\n' ||
 'Date: {{travel_date}}' || E'\n' ||
 'Departure: {{departure_time}}' || E'\n' ||
 'Booking ID: {{booking_id}}' || E'\n\n' ||
 'Thank you for your patience.'),
('password_reset', 'Password Reset Email',
 'Your Password Has Been Reset',
 'Hi {{full_name}},' || E'\n\n' ||
 'An Administrator has reset your Ferry Portal password.' || E'\n\n' ||
 'Username: {{username}}' || E'\n' ||
 'Temporary Password: {{temp_password}}' || E'\n\n' ||
 'You will be required to change this password the next time you log in.'),
('user_creation', 'User Creation Email',
 'Welcome to the Ferry Portal',
 'Hi {{full_name}},' || E'\n\n' ||
 'An account has been created for you on the Ferry Portal.' || E'\n\n' ||
 'Username: {{username}}' || E'\n' ||
 'Temporary Password: {{temp_password}}' || E'\n\n' ||
 'You will be required to change this password the first time you log in.'),
('ferry_reminder', 'Ferry Reminder Email',
 'Reminder: Your Ferry Trip Is Tomorrow',
 'Hi {{full_name}},' || E'\n\n' ||
 'This is a reminder that you have an upcoming ferry trip tomorrow.' || E'\n\n' ||
 'Route: {{route_name}} ({{direction}})' || E'\n' ||
 'Date: {{travel_date}}' || E'\n' ||
 'Departure: {{departure_time}}' || E'\n' ||
 'Booking ID: {{booking_id}}' || E'\n\n' ||
 'Safe travels.');

-- ---------------------------------------------------------------------
-- email_audit_log: unified log covering BOTH the spec's "Audit Log"
-- section (settings/template changes, previous/new value excluding
-- passwords) and its "email events shall continue to be logged even
-- when disabled" business rule (actual send attempts/skips), rather
-- than two separate tables - a single insert-only ledger, viewable
-- as a new tab on the existing /admin/activity_logs page (mirrors
-- seat_reservation_log's/permission_audit_log's precedent).
-- ---------------------------------------------------------------------
CREATE TABLE email_audit_log (
    log_id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type              TEXT NOT NULL
        CHECK (event_type IN ('settings_updated', 'template_updated', 'test_email', 'email_sent', 'email_failed', 'email_skipped')),
    actor_user_id             INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    setting_key                TEXT,
    previous_value               TEXT,
    new_value                      TEXT,
    recipient_email                  TEXT,
    template_key                      TEXT,
    error_message                       TEXT,
    related_booking_id                    INTEGER REFERENCES bookings(booking_id) ON DELETE SET NULL,
    created_at                              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_audit_log_created ON email_audit_log(created_at DESC);

-- ---------------------------------------------------------------------
-- New permission catalog rows (existing granular RBAC system - see
-- supabase/migrations/0012_permission_management.sql). Both
-- Administrator-only per the spec's "Only System Administrators may
-- access Email Settings."
-- ---------------------------------------------------------------------
INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
('settings.manage_email',        'settings', 'System Settings', 'Manage Email Settings', 'Administrator-only regardless of grant.', false, 93),
('audit_logs.view_email_log',     'audit_logs', 'Audit Logs', 'View Email Log', 'Administrator-only regardless of grant.', false, 104);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('Administrator', 'settings.manage_email'),
    ('Administrator', 'audit_logs.view_email_log')
) AS rp(role_name, permission_key)
JOIN roles r ON r.role_name = rp.role_name
JOIN permissions p ON p.permission_key = rp.permission_key;
