-- =====================================================================
-- Seed data - ported 1:1 from database/ferry_portal.sql's INSERT
-- statements. Relies on GENERATED ALWAYS AS IDENTITY assigning
-- sequential ids in insertion order (same assumption the original
-- MySQL AUTO_INCREMENT seed made), so role_id/department_id/
-- reporting_manager_id literals below match the resulting rows.
-- =====================================================================

-- ---------------------------------------------------------------------
-- roles (1-7, order matters)
-- ---------------------------------------------------------------------
INSERT INTO roles (role_name, description) VALUES
('Administrator', 'Full system access'),
('General Manager', 'Primary approver for ferry requests'),
('Resident Manager', 'Approves when GM is unavailable'),
('HR Manager', 'Approves when GM and RM are unavailable'),
('Transport Coordinator', 'Manages schedules and passenger manifests'),
('Department Manager', 'Views department booking requests'),
('Staff', 'Submits and manages own bookings');

-- ---------------------------------------------------------------------
-- departments (1-8, order matters)
-- ---------------------------------------------------------------------
INSERT INTO departments (department_name) VALUES
('Front Office'), ('Housekeeping'), ('Food & Beverage'), ('Engineering'),
('Human Resources'), ('Finance'), ('Transport'), ('Administration');

-- ---------------------------------------------------------------------
-- users (1-8, order matters - self-referencing reporting_manager_id)
-- Password is a placeholder; scripts/hash-seed-passwords.mjs sets real
-- bcrypt hashes for every 'PENDING_HASH' row (default password: Passw0rd!).
-- ---------------------------------------------------------------------
INSERT INTO users (employee_id, full_name, username, password, department_id, designation, role_id, reporting_manager_id, status) VALUES
('EMP001', 'System Administrator', 'admin', 'PENDING_HASH', 8, 'System Administrator', 1, NULL, 'active'),
('EMP002', 'Richard Combs', 'gm.richard', 'PENDING_HASH', 8, 'General Manager', 2, NULL, 'active'),
('EMP003', 'Susan Blake', 'rm.susan', 'PENDING_HASH', 8, 'Resident Manager', 3, NULL, 'active'),
('EMP004', 'Nadia Farooq', 'hr.nadia', 'PENDING_HASH', 5, 'HR Manager', 4, NULL, 'active'),
('EMP005', 'Tom Reyes', 'transport.tom', 'PENDING_HASH', 7, 'Transport Coordinator', 5, NULL, 'active'),
('EMP006', 'Angela White', 'dept.angela', 'PENDING_HASH', 3, 'F&B Department Manager', 6, 2, 'active'),
('EMP007', 'John Carter', 'staff.john', 'PENDING_HASH', 3, 'Waiter', 7, 6, 'active'),
('EMP008', 'Maria Lopez', 'staff.maria', 'PENDING_HASH', 1, 'Front Desk Officer', 7, 6, 'active');

-- ---------------------------------------------------------------------
-- manager_availability
-- ---------------------------------------------------------------------
INSERT INTO manager_availability (user_id, status) VALUES
(2, 'available'), (3, 'available'), (4, 'available');

-- ---------------------------------------------------------------------
-- ferry_routes (1-2, order matters)
-- ---------------------------------------------------------------------
INSERT INTO ferry_routes (route_name, direction) VALUES
('Resort to City Ferry', 'Resort to City'),
('City to Resort Ferry', 'City to Resort');

-- ---------------------------------------------------------------------
-- ferry_schedule
-- ---------------------------------------------------------------------
INSERT INTO ferry_schedule (route_id, departure_time, capacity, weekdays, notes) VALUES
(1, '07:00:00', 20, ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], 'Morning transfer to city'),
(1, '13:00:00', 20, ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], 'Afternoon transfer to city'),
(1, '18:00:00', 20, ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], 'Evening transfer to city'),
(2, '08:30:00', 20, ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], 'Morning transfer to resort'),
(2, '15:00:00', 20, ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], 'Afternoon transfer to resort'),
(2, '20:00:00', 20, ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], 'Evening transfer to resort');

-- ---------------------------------------------------------------------
-- booking_status (1-9, order matters)
-- ---------------------------------------------------------------------
INSERT INTO booking_status (status_name, badge_color) VALUES
('Pending', 'secondary'),
('Waiting GM Approval', 'warning'),
('Waiting RM Approval', 'warning'),
('Waiting HR Approval', 'warning'),
('Approved', 'success'),
('Rejected', 'danger'),
('Cancelled', 'dark'),
('Completed', 'info'),
('Expired', 'secondary');

-- ---------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------
INSERT INTO settings (setting_key, setting_value) VALUES
('company_name', 'Sunset Resort & Spa'),
('portal_logo', ''),
('max_seats_per_booking', '4'),
('booking_cutoff_hours', '2'),
('working_days', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun'),
('password_min_length', '8'),
('session_timeout_minutes', '30'),
('maintenance_mode', '0'),
('notifications_enabled', '1');
