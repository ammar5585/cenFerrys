-- =====================================================================
-- HOD Reserved Seat Request (self-service, self-only): supersedes the
-- assign-any-department-employee self-service page shipped in
-- 0024_hod_self_service.sql, which the actual business spec rejected -
-- an HOD may only reserve a seat for themselves, against a resort-wide
-- (not department-scoped) admin-configurable seat pool. The permission
-- key from 0024 is reused as-is (still granted to Department Manager);
-- only its label/description are refreshed here to describe the new,
-- narrower capability. No new tables - the per-resort seat allocation
-- is stored in the existing generic `settings` key/value table
-- (settings.js), keyed `hod_seat_allocation_resort_<id>`.
-- =====================================================================

UPDATE permissions
SET label = 'Request HOD Reserved Seat (Self)',
    description = 'Request, view, and cancel a reserved seat for oneself only, against one''s own resort''s HOD reserved seat pool.'
WHERE permission_key = 'approval_workflow.manage_reserved_seats';

NOTIFY pgrst, 'reload schema';
