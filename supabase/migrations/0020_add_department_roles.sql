-- =====================================================================
-- Adds ~47 department-specific job-title roles (Executive Management,
-- HR, Finance, IT, Reservations, Front Office, Housekeeping, Culinary,
-- Engineering, F&B, Spa, Recreation, Dive Center, Quality & Hygiene,
-- Sales & Marketing, Security), per the user's supplied list, as custom
-- roles (is_system defaults to false - fully renamable/deletable from
-- /admin/roles, same as any other custom role). None of them are
-- granted any permissions here - a brand-new custom role always starts
-- with zero permissions until an Administrator configures it from
-- Roles & Permissions, exactly like creating one via the "Create Custom
-- Role" form.
--
-- "Resident Manager" is skipped intentionally: it already exists as one
-- of the 8 built-in system roles (with real approval-chain logic tied
-- to that exact name in approval.js), so ON CONFLICT DO NOTHING here
-- guards against that collision (and any other future accidental
-- duplicate) without failing the whole batch insert.
-- =====================================================================

INSERT INTO roles (role_name, description) VALUES
-- Executive Management
('Cluster General Manager', 'Executive Management'),
('Secretary to Cluster General Manager', 'Executive Management'),
-- Human Resources
('Cluster Director of HR', 'Human Resources'),
('Assistant HR Manager', 'Human Resources'),
('HR Supervisor', 'Human Resources'),
('Accomodation Manager', 'Human Resources'),
-- Finance
('Area Financial Controller', 'Finance'),
('Chief Accountant', 'Finance'),
('Finance Supervisor', 'Finance'),
-- Information Technology
('Cluster IT Manager', 'Information Technology'),
('IT Supervisor', 'Information Technology'),
-- Reservations
('Cluster Reservation Manager', 'Reservations'),
('Reservation Supervisor', 'Reservations'),
-- Front Office
('Front Office Manager', 'Front Office'),
('Duty Manager', 'Front Office'),
('Front Office Supervisor', 'Front Office'),
-- Housekeeping
('Cluster Executive Housekeeper', 'Housekeeping'),
('Assistant Housekeeping Manager', 'Housekeeping'),
('Housekeeping Supervisor', 'Housekeeping'),
-- Culinary
('Cluster Executive Chef', 'Culinary'),
('Executive Sous Chef', 'Culinary'),
('Cluster Pastry Chef', 'Culinary'),
('Kitchen Supervisor', 'Culinary'),
-- Engineering
('Cluster Chief Engineer', 'Engineering'),
('Maintenance Manager', 'Engineering'),
('Engineering Supervisor', 'Engineering'),
-- Food & Beverage Service
('Cluster F&B Director', 'Food & Beverage Service'),
('Food & Beverage Manager', 'Food & Beverage Service'),
('Complex Restaurant Manager', 'Food & Beverage Service'),
('Restaurant Manager', 'Food & Beverage Service'),
('Assistant Restaurant Manager', 'Food & Beverage Service'),
('Restaurant Supervisor', 'Food & Beverage Service'),
-- Spa
('Cluster Spa Manager', 'Spa'),
('Cluster Assistant Spa Manager', 'Spa'),
('Senior Spa Supervisor', 'Spa'),
-- Recreation
('Cluster Recreation Manager', 'Recreation'),
('Cluster Recreation Supervisor', 'Recreation'),
('Recreation Coordinator', 'Recreation'),
-- Dive Center
('Dive Center Manager', 'Dive Center'),
-- Quality & Hygiene
('Cluster Hygiene Manager', 'Quality & Hygiene'),
('Cluster Quality Manager', 'Quality & Hygiene'),
-- Sales & Marketing
('Sales Manager', 'Sales & Marketing'),
('Marketing Executive', 'Sales & Marketing'),
-- Security
('Cluster Security Manager', 'Security'),
('Security Supervisor', 'Security'),
('Security Officer', 'Security')
ON CONFLICT (role_name) DO NOTHING;
