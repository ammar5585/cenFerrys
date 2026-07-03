-- =====================================================================
-- Staff Ferry Transfer Portal - Postgres schema (Supabase)
-- Ported from the original database/ferry_portal.sql (MySQL). See
-- ferry-portal-netlify's plan doc for the full list of adaptations:
-- ENUM -> TEXT+CHECK, AUTO_INCREMENT -> IDENTITY, DATETIME -> TIMESTAMPTZ,
-- TINYINT(1) -> BOOLEAN, weekdays CSV -> TEXT[], ON UPDATE CURRENT_TIMESTAMP
-- -> trigger, FIND_IN_SET -> = ANY().
-- =====================================================================

-- ---------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------
CREATE TABLE roles (
    role_id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_name   TEXT NOT NULL UNIQUE,
    description TEXT
);

-- ---------------------------------------------------------------------
-- departments
-- ---------------------------------------------------------------------
CREATE TABLE departments (
    department_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    department_name TEXT NOT NULL UNIQUE
);

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
CREATE TABLE users (
    user_id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id           TEXT NOT NULL UNIQUE,
    full_name             TEXT NOT NULL,
    username              TEXT NOT NULL UNIQUE,
    password              TEXT NOT NULL, -- bcrypt hash
    department_id         INTEGER REFERENCES departments(department_id) ON DELETE SET NULL,
    designation            TEXT,
    role_id               INTEGER NOT NULL REFERENCES roles(role_id),
    reporting_manager_id  INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    email                  TEXT,
    phone                  TEXT,
    profile_picture        TEXT, -- Supabase Storage public URL
    status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    must_change_password   BOOLEAN NOT NULL DEFAULT false,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- manager_availability
-- ---------------------------------------------------------------------
CREATE TABLE manager_availability (
    availability_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         INTEGER NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','on_leave','out_of_office')),
    remarks         TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- ferry_routes
-- ---------------------------------------------------------------------
CREATE TABLE ferry_routes (
    route_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_name TEXT NOT NULL,
    direction  TEXT NOT NULL CHECK (direction IN ('Resort to City','City to Resort')),
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'))
);

-- ---------------------------------------------------------------------
-- ferry_schedule
-- ---------------------------------------------------------------------
CREATE TABLE ferry_schedule (
    schedule_id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id            INTEGER NOT NULL REFERENCES ferry_routes(route_id) ON DELETE CASCADE,
    departure_time      TIME NOT NULL,
    capacity             INTEGER NOT NULL DEFAULT 20,
    weekdays             TEXT[] NOT NULL DEFAULT ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
    is_holiday_schedule   BOOLEAN NOT NULL DEFAULT false,
    status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    notes                 TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- holidays
-- ---------------------------------------------------------------------
CREATE TABLE holidays (
    holiday_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    holiday_date DATE NOT NULL UNIQUE,
    description  TEXT
);

-- ---------------------------------------------------------------------
-- booking_status (lookup)
-- ---------------------------------------------------------------------
CREATE TABLE booking_status (
    status_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status_name TEXT NOT NULL UNIQUE,
    badge_color TEXT NOT NULL DEFAULT 'secondary'
);

-- ---------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------
CREATE TABLE bookings (
    booking_id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id               INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    schedule_id           INTEGER NOT NULL REFERENCES ferry_schedule(schedule_id),
    travel_date            DATE NOT NULL,
    direction               TEXT NOT NULL CHECK (direction IN ('Resort to City','City to Resort')),
    purpose                 TEXT NOT NULL,
    remarks                 TEXT,
    seats                   INTEGER NOT NULL DEFAULT 1,
    status_id               INTEGER NOT NULL DEFAULT 1 REFERENCES booking_status(status_id),
    current_approver_id     INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    admin_override           BOOLEAN NOT NULL DEFAULT false,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_schedule_date ON bookings(schedule_id, travel_date);
CREATE INDEX idx_bookings_approver_status ON bookings(current_approver_id, status_id);

-- ---------------------------------------------------------------------
-- booking_approvals (audit trail)
-- ---------------------------------------------------------------------
CREATE TABLE booking_approvals (
    approval_id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id         INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
    approver_id         INTEGER NOT NULL REFERENCES users(user_id),
    role_at_approval    TEXT NOT NULL,
    action               TEXT NOT NULL CHECK (action IN ('approved','rejected')),
    comments             TEXT,
    action_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
    notification_id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id               INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    message               TEXT NOT NULL,
    type                   TEXT NOT NULL DEFAULT 'info',
    related_booking_id     INTEGER,
    is_read                 BOOLEAN NOT NULL DEFAULT false,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_read ON notifications(user_id, is_read);

-- ---------------------------------------------------------------------
-- activity_logs
-- ---------------------------------------------------------------------
CREATE TABLE activity_logs (
    log_id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    action         TEXT NOT NULL,
    details        TEXT,
    ip_address      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_logs_created ON activity_logs(created_at DESC);

-- ---------------------------------------------------------------------
-- system_logs
-- ---------------------------------------------------------------------
CREATE TABLE system_logs (
    log_id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    log_level   TEXT NOT NULL DEFAULT 'INFO' CHECK (log_level IN ('INFO','WARNING','ERROR')),
    message      TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- settings (key/value store)
-- ---------------------------------------------------------------------
CREATE TABLE settings (
    setting_key   TEXT PRIMARY KEY,
    setting_value  TEXT
);
