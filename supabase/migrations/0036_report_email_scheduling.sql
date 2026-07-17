-- =====================================================================
-- Automated Daily Operations Report Email: scheduled report delivery
-- to configurable recipient groups. Reuses the existing centralized
-- sender email (email_sender_name/email_sender_address, already
-- configured via /admin/email_settings and used as the `from` on
-- every email in mailer.js) - no new sender config needed. Gated by
-- the same settings.manage_email permission that already gates that
-- page (Administrator today).
--
-- report_email_log is a deliberately NEW table rather than extending
-- email_audit_log (0019_email_settings.sql): that table is
-- one-recipient-per-row transactional-email audit; this is
-- multi-recipient report-batch delivery with attachments/SMTP-response
-- tracking - different enough shape that extending it would mean
-- nullable columns everywhere.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Recipient groups: membership resolved dynamically at send time from
-- real roles (active users holding these roles), so it never goes
-- stale, plus manually-added addresses per group.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_recipient_groups (
    group_id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    group_name   TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_recipient_group_roles (
    group_id  INTEGER NOT NULL REFERENCES report_recipient_groups(group_id) ON DELETE CASCADE,
    role_id   INTEGER NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, role_id)
);

CREATE TABLE IF NOT EXISTS report_recipient_group_emails (
    email_id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    group_id        INTEGER NOT NULL REFERENCES report_recipient_groups(group_id) ON DELETE CASCADE,
    email            TEXT NOT NULL,
    recipient_type      TEXT NOT NULL DEFAULT 'to' CHECK (recipient_type IN ('to', 'cc', 'bcc')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO report_recipient_groups (group_name) VALUES
('Management'), ('Human Resources'), ('Security'), ('Administration')
ON CONFLICT (group_name) DO NOTHING;

INSERT INTO report_recipient_group_roles (group_id, role_id)
SELECT g.group_id, r.role_id
FROM report_recipient_groups g
JOIN roles r ON (
    (g.group_name = 'Management' AND r.role_name IN ('Cluster General Manager', 'Resident Manager')) OR
    (g.group_name = 'Human Resources' AND r.role_name IN ('Cluster Director of HR', 'Assistant HR Manager')) OR
    (g.group_name = 'Security' AND r.role_name IN ('Cluster Security Manager', 'Security Supervisor')) OR
    (g.group_name = 'Administration' AND r.role_name = 'Administrator')
)
ON CONFLICT (group_id, role_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Schedules: "Custom" frequency means a specific time-of-day + optional
-- day pattern (checked by the cron poll below), not arbitrary cron
-- syntax - the underlying trigger is a fixed 15-minute GitHub Actions
-- poll (see .github/workflows/scheduled-jobs.yml), not a real per-
-- schedule cron entry.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_schedules (
    schedule_id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    report_type     TEXT NOT NULL CHECK (report_type IN ('passenger_manifest', 'daily_operations')),
    frequency         TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'custom')),
    send_time            TIME NOT NULL,
    day_of_week             INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
    day_of_month                INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
    is_active                      BOOLEAN NOT NULL DEFAULT true,
    last_run_at                       TIMESTAMPTZ,
    created_by_user_id                   INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    updated_by_user_id                      INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    created_at                                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_report_schedules_updated_at ON report_schedules;
CREATE TRIGGER trg_report_schedules_updated_at
    BEFORE UPDATE ON report_schedules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS report_schedule_recipient_groups (
    schedule_id  INTEGER NOT NULL REFERENCES report_schedules(schedule_id) ON DELETE CASCADE,
    group_id     INTEGER NOT NULL REFERENCES report_recipient_groups(group_id) ON DELETE CASCADE,
    PRIMARY KEY (schedule_id, group_id)
);

-- The 2 default schedules from the spec - is_active but with no
-- recipient groups attached yet (safe default: nothing sends until an
-- Administrator assigns groups via the new "Report Emails" tab).
INSERT INTO report_schedules (report_type, frequency, send_time)
SELECT 'passenger_manifest', 'daily', '05:00:00'
WHERE NOT EXISTS (SELECT 1 FROM report_schedules WHERE report_type = 'passenger_manifest' AND frequency = 'daily' AND send_time = '05:00:00');

INSERT INTO report_schedules (report_type, frequency, send_time)
SELECT 'daily_operations', 'daily', '21:00:00'
WHERE NOT EXISTS (SELECT 1 FROM report_schedules WHERE report_type = 'daily_operations' AND frequency = 'daily' AND send_time = '21:00:00');

-- ---------------------------------------------------------------------
-- report_email_log: insert-only delivery audit trail.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_email_log (
    log_id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_id           INTEGER REFERENCES report_schedules(schedule_id) ON DELETE SET NULL,
    report_type            TEXT NOT NULL,
    sender_email             TEXT,
    recipients_to               TEXT,
    recipients_cc                  TEXT,
    recipients_bcc                    TEXT,
    attachments                          TEXT,
    sent_at                                 TIMESTAMPTZ,
    delivery_status                            TEXT NOT NULL CHECK (delivery_status IN ('sent', 'failed', 'retrying')),
    smtp_response                                 TEXT,
    error_message                                    TEXT,
    retry_count                                         INTEGER NOT NULL DEFAULT 0,
    created_at                                             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_email_log_created ON report_email_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_email_log_status ON report_email_log(delivery_status);

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Verification (same execution, per session convention).
-- ---------------------------------------------------------------------
SELECT 'report_recipient_groups seeded (4 rows)' AS check_name, (SELECT COUNT(*) FROM report_recipient_groups) = 4 AS passed
UNION ALL
SELECT 'Management group has 2 roles', (SELECT COUNT(*) FROM report_recipient_group_roles rgr JOIN report_recipient_groups g ON g.group_id = rgr.group_id WHERE g.group_name = 'Management') = 2
UNION ALL
SELECT 'Human Resources group has 2 roles', (SELECT COUNT(*) FROM report_recipient_group_roles rgr JOIN report_recipient_groups g ON g.group_id = rgr.group_id WHERE g.group_name = 'Human Resources') = 2
UNION ALL
SELECT 'Security group has 2 roles', (SELECT COUNT(*) FROM report_recipient_group_roles rgr JOIN report_recipient_groups g ON g.group_id = rgr.group_id WHERE g.group_name = 'Security') = 2
UNION ALL
SELECT 'Administration group has 1 role', (SELECT COUNT(*) FROM report_recipient_group_roles rgr JOIN report_recipient_groups g ON g.group_id = rgr.group_id WHERE g.group_name = 'Administration') = 1
UNION ALL
SELECT 'report_schedules seeded (2 default rows)', (SELECT COUNT(*) FROM report_schedules WHERE report_type IN ('passenger_manifest', 'daily_operations')) >= 2
UNION ALL
SELECT 'report_email_log table exists', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'report_email_log');
