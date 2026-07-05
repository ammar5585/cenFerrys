-- =====================================================================
-- Removes the Supervisor tier from the department approval hierarchy
-- (now 2 tiers: Primary Approver / Secondary Approver) per user
-- request. Confirmed before writing this migration: no department has
-- supervisor_user_id set, and no booking is currently in "Pending
-- Supervisor Approval" - safe to drop outright, no data migration
-- needed.
-- =====================================================================

ALTER TABLE department_approval_config DROP COLUMN supervisor_user_id;

DELETE FROM booking_status WHERE status_name = 'Pending Supervisor Approval';
