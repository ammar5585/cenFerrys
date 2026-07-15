-- =====================================================================
-- Supplier Visit Reservations: approval must go to Human Resources.
-- Today any of the 5 roles that can create a supplier reservation
-- (Administrator, Cluster General Manager, Resident Manager, Cluster
-- Director of HR, Assistant HR Manager - see 0034_supplier_reservations.sql)
-- can also move it Pending -> Approved themselves. This adds a
-- narrower permission gating specifically the Approved transition to
-- Administrator + the two HR roles, so a Cluster General Manager or
-- Resident Manager who creates a reservation can no longer self-approve
-- it - it must go to HR (or an Administrator) for approval. Creation,
-- Confirmed, and Cancelled are untouched - still governed by the
-- existing booking.manage_supplier_reservations permission.
-- =====================================================================

INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
('booking.approve_supplier_reservations', 'booking', 'Ferry Booking', 'Approve Supplier Visit Reservations', 'Move a Supplier Visit reservation leg from Pending to Approved. Held only by HR and Administrator - other roles that can create a reservation cannot self-approve it.', false, 111)
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.role_name IN ('Administrator', 'Cluster Director of HR', 'Assistant HR Manager')
  AND p.permission_key = 'booking.approve_supplier_reservations'
ON CONFLICT (role_id, permission_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Verification (same execution, per session convention).
-- ---------------------------------------------------------------------
SELECT 'booking.approve_supplier_reservations permission exists' AS check_name, EXISTS (
    SELECT 1 FROM permissions WHERE permission_key = 'booking.approve_supplier_reservations'
) AS passed
UNION ALL
SELECT 'granted to Administrator + Cluster Director of HR + Assistant HR Manager only', (
    SELECT COUNT(*) FROM role_permissions rp
    JOIN permissions p ON p.permission_id = rp.permission_id
    JOIN roles r ON r.role_id = rp.role_id
    WHERE p.permission_key = 'booking.approve_supplier_reservations'
      AND r.role_name IN ('Administrator', 'Cluster Director of HR', 'Assistant HR Manager')
) = 3
UNION ALL
SELECT 'NOT granted to Cluster General Manager or Resident Manager', (
    SELECT COUNT(*) FROM role_permissions rp
    JOIN permissions p ON p.permission_id = rp.permission_id
    JOIN roles r ON r.role_id = rp.role_id
    WHERE p.permission_key = 'booking.approve_supplier_reservations'
      AND r.role_name IN ('Cluster General Manager', 'Resident Manager')
) = 0;
