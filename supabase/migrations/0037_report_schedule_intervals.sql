-- =====================================================================
-- Report schedules: adds "Every N Minutes" as a real recurring
-- frequency, alongside the existing once-a-day daily/weekly/monthly/
-- custom schedules (0036_report_email_scheduling.sql). An interval
-- schedule has no fixed time-of-day - it fires repeatedly, gated only
-- by elapsed time since last_run_at - so send_time is meaningless for
-- it and interval_minutes is meaningless for the others; the CHECK
-- below enforces exactly one of the two is populated, matching which
-- mode the row is in.
--
-- interval_minutes >= 5: the underlying trigger is a GitHub Actions
-- scheduled workflow, which only guarantees ~5-minute granularity (and
-- can drift further under GitHub's load) - a smaller configured value
-- could never actually be honored, so it isn't offered.
-- =====================================================================

ALTER TABLE report_schedules ALTER COLUMN send_time DROP NOT NULL;

ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS interval_minutes INTEGER CHECK (interval_minutes >= 5);

ALTER TABLE report_schedules DROP CONSTRAINT IF EXISTS report_schedules_frequency_check;
ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_frequency_check
    CHECK (frequency IN ('daily', 'weekly', 'monthly', 'custom', 'interval'));

ALTER TABLE report_schedules DROP CONSTRAINT IF EXISTS report_schedules_frequency_fields_check;
ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_frequency_fields_check
    CHECK (
        (frequency = 'interval' AND interval_minutes IS NOT NULL AND send_time IS NULL)
        OR
        (frequency <> 'interval' AND send_time IS NOT NULL AND interval_minutes IS NULL)
    );

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Verification (same execution, per session convention).
-- ---------------------------------------------------------------------
SELECT 'interval_minutes column exists' AS check_name,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'report_schedules' AND column_name = 'interval_minutes') AS passed
UNION ALL
SELECT 'send_time is now nullable', (SELECT is_nullable FROM information_schema.columns WHERE table_name = 'report_schedules' AND column_name = 'send_time') = 'YES'
UNION ALL
SELECT 'frequency CHECK allows interval', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'report_schedules_frequency_check') LIKE '%interval%'
UNION ALL
SELECT 'existing 2 seeded schedules still valid (send_time set, interval_minutes null)',
    (SELECT COUNT(*) FROM report_schedules WHERE frequency IN ('daily', 'weekly', 'monthly', 'custom') AND send_time IS NOT NULL AND interval_minutes IS NULL) >= 2;
