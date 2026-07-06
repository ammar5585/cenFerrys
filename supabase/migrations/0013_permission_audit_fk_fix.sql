-- =====================================================================
-- Fix: permission_audit_log's FK columns had no ON DELETE clause
-- (default RESTRICT), unlike this codebase's established convention for
-- audit tables - activity_logs.user_id already uses ON DELETE SET NULL
-- so a user/role can be deleted without an uncaught FK-violation
-- exception, and the audit row survives as history with a null
-- reference. Found live: deleting a custom role that had ever appeared
-- in a permission_audit_log row (e.g. its own "role_created" entry)
-- raised an uncaught exception (500) instead of succeeding or a
-- friendly error.
-- =====================================================================

ALTER TABLE permission_audit_log ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE permission_audit_log DROP CONSTRAINT permission_audit_log_actor_user_id_fkey;
ALTER TABLE permission_audit_log
    ADD CONSTRAINT permission_audit_log_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL;

ALTER TABLE permission_audit_log DROP CONSTRAINT permission_audit_log_target_user_id_fkey;
ALTER TABLE permission_audit_log
    ADD CONSTRAINT permission_audit_log_target_user_id_fkey
    FOREIGN KEY (target_user_id) REFERENCES users(user_id) ON DELETE SET NULL;

ALTER TABLE permission_audit_log DROP CONSTRAINT permission_audit_log_target_role_id_fkey;
ALTER TABLE permission_audit_log
    ADD CONSTRAINT permission_audit_log_target_role_id_fkey
    FOREIGN KEY (target_role_id) REFERENCES roles(role_id) ON DELETE SET NULL;
