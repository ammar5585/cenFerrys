# Staff Ferry Transfer Portal (Netlify Edition)

A staff ferry transfer booking and approval portal - the same feature
set as the original PHP/MySQL version, rebuilt on a stack Netlify can
actually run: static assets + Netlify Functions (Node.js) + Supabase
(Postgres). See `DEPLOY.md` for deployment; this file covers what the
app does and how the pieces fit together.

## Why this exists

Netlify has no PHP runtime and can't hold a persistent MySQL session -
so instead of trying to deploy the PHP app there, this is a full
rewrite in a Netlify-native stack, built to match the original app's
behavior as closely as possible (same roles, same approval routing
rules, same booking/capacity guarantees).

## Features

- **Role-based access** for 7 roles: Administrator, General Manager,
  Resident Manager, HR Manager, Transport Coordinator, Department
  Manager, Staff.
- **Automatic approval routing**: bookings route to the first available
  manager in order GM → RM → HR, based on real-time availability.
- **Capacity-safe booking**: seat availability is checked and reserved
  atomically inside a single Postgres transaction (a `FOR UPDATE`-locked
  RPC function), so concurrent requests for the last seat can never both
  succeed - verified live under real concurrent load.
- **Transport coordination**: live passenger manifests per departure,
  printable and CSV-exportable.
- **Reports**: filterable booking reports (date, department, employee,
  route, status) with CSV/Excel export and print-to-PDF.
- **Admin tools**: user management, ferry schedule/route management,
  manager availability, holidays, portal settings (with logo upload),
  activity logs, admin booking overrides.
- **No email required anywhere** - username-only login, matching the
  original app's requirement.

## Stack

- **Frontend**: server-rendered HTML (Bootstrap 5), no client framework
- **Backend**: one catch-all Netlify Function (Node.js) with internal
  routing, mirroring the original app's page structure
- **Database**: Supabase Postgres, accessed via `@supabase/supabase-js`
  using a secret key (server-side only)
- **Auth**: bcrypt password hashing + JWT session cookie (httpOnly)
- **File uploads**: Supabase Storage (public-read buckets)

## Project layout

```
ferry-portal-netlify/
  netlify.toml                     # build/redirect config
  public/assets/                   # CSS, JS, images (served statically)
  netlify/functions/
    app.mts                        # catch-all Function entry point
    expire-bookings.mts            # scheduled Function (booking expiry)
    app/
      db.js, auth.js, session.js, csrf.js, settings.js, ...  # core modules
      approval.js                  # approval-routing engine
      seats.js                     # capacity-safe booking RPC wrapper
      uploads.js                   # Supabase Storage upload handling
      templates/                   # HTML rendering (layout, sidebar, navbar)
      routes/                      # one file per page-group (staff, admin, etc.)
  supabase/migrations/              # schema, seed data, RPC functions (Postgres)
  scripts/hash-seed-passwords.mjs   # one-time password seeding script
```

## Default login credentials

All sample accounts share the password `Passw0rd!` until changed:

| Role | Username |
|---|---|
| Administrator | `admin` |
| General Manager | `gm.richard` |
| Resident Manager | `rm.susan` |
| HR Manager | `hr.nadia` |
| Transport Coordinator | `transport.tom` |
| Department Manager | `dept.angela` |
| Staff | `staff.john`, `staff.maria` |

**Change these immediately after first login**, especially the
Administrator account.

## Local development

See `DEPLOY.md` → "Local development." Quick version:

```
npm install
cp .env.example .env   # fill in SUPABASE_URL, SUPABASE_SECRET_KEY, JWT_SECRET
npm run dev
```

## Related projects

- `../staff-ferry-portal/` - the original PHP + MySQL version (for
  hosts that support PHP, e.g. Railway or shared hosting - see that
  project's own `DEPLOY.md`).
- `../ferry-portal-landing/` - a static marketing/landing page that can
  point at either backend.

## Known limitations vs. the original PHP app

- **Session idle-timeout** is approximated via JWT reissue-on-activity
  rather than a true server-side sliding session; a deactivated user's
  access is cut off on their *next* request (typically within seconds)
  rather than instantly.
- **`admin/backup.php` / `admin/restore.php` were not ported** - Supabase
  manages its own backups.

Both were explicit, signed-off trade-offs during the rebuild - see the
project's plan doc for the full reasoning.
