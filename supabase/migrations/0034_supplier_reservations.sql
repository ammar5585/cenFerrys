-- =====================================================================
-- Supplier Visit Seat Reservation: lets authorized senior roles book
-- ferry seats for suppliers/contractors/consultants/auditors/other
-- approved external visitors, separately from employee bookings but
-- sharing the same ferry services and seat capacity engine.
--
-- Architecture: a supplier visit is one supplier_reservations "header"
-- row (visitor/company/host details) plus 1-2 real bookings rows (the
-- actual seat-consuming legs), linked via a new nullable
-- bookings.supplier_reservation_id - this exactly mirrors the existing
-- bookings.source_reservation_id -> seat_reservations link used by HOD
-- Reserved Seats (0023_hod_seat_assignment.sql). book_ferry_seat() and
-- get_remaining_seats() are NOT touched - a supplier leg is created via
-- the same bookFerrySeat() every other feature already uses, so it
-- follows the exact same capacity/waiting-list rules as an employee
-- booking with zero RPC changes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- visit_purposes: admin-manageable lookup, seeded with the spec's list.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visit_purposes (
    purpose_id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purpose_name   TEXT NOT NULL UNIQUE,
    is_active      BOOLEAN NOT NULL DEFAULT true,
    display_order  INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO visit_purposes (purpose_name, display_order) VALUES
('Equipment Delivery', 1),
('Maintenance Visit', 2),
('Contractor Work', 3),
('Project Meeting', 4),
('Sales Visit', 5),
('Product Demonstration', 6),
('Government Inspection', 7),
('Audit', 8),
('Training', 9),
('VIP Visit', 10),
('Other', 11)
ON CONFLICT (purpose_name) DO NOTHING;

-- ---------------------------------------------------------------------
-- supplier_reservations: the visit "header" - visitor/company/host
-- details, shared by both legs of a same-day-return visit.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_reservations (
    reservation_id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_company        TEXT NOT NULL,
    visitor_name              TEXT NOT NULL,
    nationality                 TEXT,
    contact_number                TEXT NOT NULL,
    email                           TEXT,
    pax                              INTEGER NOT NULL DEFAULT 1 CHECK (pax > 0),
    visit_purpose_id                    INTEGER REFERENCES visit_purposes(purpose_id) ON DELETE SET NULL,
    visiting_department_id                 INTEGER REFERENCES departments(department_id) ON DELETE SET NULL,
    host_employee_user_id                     INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    host_department_id                           INTEGER REFERENCES departments(department_id) ON DELETE SET NULL,
    resort_id                                       INTEGER REFERENCES resorts(resort_id) ON DELETE SET NULL,
    boarding_location                                  TEXT,
    destination                                          TEXT,
    return_required                                        BOOLEAN NOT NULL DEFAULT false,
    remarks                                                  TEXT,
    created_by_user_id                                          INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    updated_by_user_id                                             INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    created_at                                                        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                                                           TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_supplier_reservations_updated_at ON supplier_reservations;
CREATE TRIGGER trg_supplier_reservations_updated_at
    BEFORE UPDATE ON supplier_reservations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- bookings: link each leg back to its supplier_reservations header, and
-- extend booking_method (same fixed constraint name pattern used by
-- 0014/0023 - this constraint has always been explicitly named, no
-- dynamic lookup needed).
-- ---------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS supplier_reservation_id INTEGER REFERENCES supplier_reservations(reservation_id) ON DELETE CASCADE;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_booking_method_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_booking_method_check
    CHECK (booking_method IN ('self', 'admin_override', 'hr_manual', 'hod_seat_assignment', 'supplier'));

-- New intermediate status between Approved and Checked-In, used by
-- supplier reservations' manual status progression (same insert-only
-- pattern as 0004/0009) - falls into every existing status-bucket's
-- default "confirmed" treatment (statusBucketFor() in seatAvailability.js,
-- capacity counting) with no other code changes, exactly like 'Approved' does.
INSERT INTO booking_status (status_name, badge_color) VALUES
('Confirmed', 'info')
ON CONFLICT (status_name) DO NOTHING;

-- ---------------------------------------------------------------------
-- supplier_reservation_log: insert-only audit trail, same shape as
-- every other *_log table this session.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_reservation_log (
    log_id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reservation_id            INTEGER REFERENCES supplier_reservations(reservation_id) ON DELETE SET NULL,
    booking_id                INTEGER REFERENCES bookings(booking_id) ON DELETE SET NULL,
    supplier_company_snapshot TEXT,
    visitor_name_snapshot     TEXT,
    host_employee_snapshot    TEXT,
    ferry_service_snapshot    TEXT,
    seats                     INTEGER,
    status_snapshot           TEXT,
    action                    TEXT NOT NULL CHECK (action IN ('created', 'edited', 'cancelled', 'status_changed')),
    performed_by_user_id      INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Permissions. booking.manage_supplier_reservations granted only to
-- the 5 confirmed roles (per user decision) - any other role can be
-- granted this later via Roles & Permissions with no code change.
-- ---------------------------------------------------------------------
INSERT INTO permissions (permission_key, category, category_label, label, description, is_module_access, display_order) VALUES
('booking.manage_supplier_reservations', 'booking', 'Ferry Booking', 'Manage Supplier Visit Reservations', 'Create, edit, and cancel ferry seat reservations for suppliers/contractors/visitors.', false, 109),
('audit_logs.view_supplier_reservations', 'audit_logs', 'Audit Logs', 'View Supplier Reservation Log', 'Includes create/edit/cancel/status-change actions on Supplier Visit reservations.', false, 110)
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.role_name IN ('Administrator', 'Cluster General Manager', 'Resident Manager', 'Cluster Director of HR', 'Assistant HR Manager')
  AND p.permission_key = 'booking.manage_supplier_reservations'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.role_name = 'Administrator' AND p.permission_key = 'audit_logs.view_supplier_reservations'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Email notification template.
-- ---------------------------------------------------------------------
INSERT INTO email_templates (template_key, label, subject, body) VALUES
('supplier_reservation_notice', 'Supplier Visit Reservation Notice',
 'Supplier Visit Ferry Reservation - {{supplier_company}}',
 'Hi {{recipient_name}},' || E'\n\n' ||
 'A ferry seat reservation has been created for a supplier visit.' || E'\n\n' ||
 'Visitor: {{visitor_name}}' || E'\n' ||
 'Company: {{supplier_company}}' || E'\n' ||
 'Host Employee: {{host_employee_name}}' || E'\n' ||
 'Ferry Service: {{ferry_service}}' || E'\n' ||
 'Travel Date: {{travel_date}}' || E'\n' ||
 'Booking Reference: {{booking_reference}}' || E'\n\n' ||
 'Please coordinate accordingly.')
ON CONFLICT (template_key) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Verification (same execution, per session convention).
-- ---------------------------------------------------------------------
SELECT 'visit_purposes seeded (11 rows)' AS check_name, (SELECT COUNT(*) FROM visit_purposes) = 11 AS passed
UNION ALL
SELECT 'supplier_reservations table exists', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'supplier_reservations')
UNION ALL
SELECT 'bookings.supplier_reservation_id column', EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'supplier_reservation_id'
)
UNION ALL
SELECT 'booking_method check accepts supplier', (
    SELECT pg_get_constraintdef(oid) LIKE '%supplier%' FROM pg_constraint WHERE conname = 'bookings_booking_method_check'
)
UNION ALL
SELECT 'booking_status has Confirmed', EXISTS (SELECT 1 FROM booking_status WHERE status_name = 'Confirmed')
UNION ALL
SELECT 'supplier_reservation_log table exists', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'supplier_reservation_log')
UNION ALL
SELECT 'booking.manage_supplier_reservations granted to 5 roles', (
    SELECT COUNT(*) FROM role_permissions rp
    JOIN permissions p ON p.permission_id = rp.permission_id
    JOIN roles r ON r.role_id = rp.role_id
    WHERE p.permission_key = 'booking.manage_supplier_reservations'
      AND r.role_name IN ('Administrator', 'Cluster General Manager', 'Resident Manager', 'Cluster Director of HR', 'Assistant HR Manager')
) = 5
UNION ALL
SELECT 'audit_logs.view_supplier_reservations granted to Administrator', (
    SELECT COUNT(*) FROM role_permissions rp
    JOIN permissions p ON p.permission_id = rp.permission_id
    JOIN roles r ON r.role_id = rp.role_id
    WHERE p.permission_key = 'audit_logs.view_supplier_reservations' AND r.role_name = 'Administrator'
) = 1
UNION ALL
SELECT 'supplier_reservation_notice email template seeded', EXISTS (
    SELECT 1 FROM email_templates WHERE template_key = 'supplier_reservation_notice'
);
