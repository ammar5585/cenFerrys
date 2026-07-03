-- =====================================================================
-- Website Branding Management: no new tables needed (reuses the
-- existing flat settings key-value store). This is a data-only rename
-- of the pre-existing 'portal_logo' key (uploaded via the old dead
-- admin_settings.js field, never actually rendered anywhere) to
-- 'site_logo', tracked as a migration for consistency with this
-- project's convention of numbering every DB change.
-- =====================================================================

UPDATE settings SET setting_key = 'site_logo' WHERE setting_key = 'portal_logo';
