-- =====================================================================
-- Remove the booking cut-off time restriction entirely, per user
-- request - employees and HR can book right up until departure, no
-- override needed anywhere. Removes the now-meaningless
-- booking.override_cutoff permission (soft-deprecated via is_active,
-- matching this migration set's established discipline of never
-- deleting a seeded permission row outright - see 0012's header
-- comment on why permission_id doubles as a stable bit position).
-- The booking_cutoff_hours setting row is left in place, unused,
-- rather than deleted - harmless, and settings.js has no delete path.
-- =====================================================================

DELETE FROM role_permissions
WHERE permission_id = (SELECT permission_id FROM permissions WHERE permission_key = 'booking.override_cutoff');

UPDATE permissions SET is_active = false WHERE permission_key = 'booking.override_cutoff';
