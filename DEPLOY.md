# Deploying to Netlify

This is the Netlify-native rebuild of the Staff Ferry Transfer Portal:
static assets + Netlify Functions (Node.js) + Supabase (Postgres). Unlike
the original PHP version, this one actually runs on Netlify.

## What's already done

If you're deploying the *same* Supabase project this was built against,
skip to [Deploy to Netlify](#deploy-to-netlify) - the database schema,
seed data, RPC functions, and Storage buckets already exist. The steps
below under "Set up Supabase from scratch" are only needed if you're
starting a **new** Supabase project.

## Set up Supabase from scratch

Only do this if you don't already have a Supabase project for this app.

1. Create a free project at [supabase.com](https://supabase.com).
2. Get your credentials: **Project Settings → API**
   - **Project URL** (`https://xxxxx.supabase.co`)
   - **service_role / secret key** (Project Settings → API → "Project API
     keys" - the secret one, `sb_secret_...`. Never expose this to a
     browser; it's used only inside Netlify Functions.)
3. Get your database connection string: **Project Settings → Database →
   Connection string → Session pooler** (URI format). You'll need this
   once, to run the migrations.
4. Apply the three migration files, in order, against that connection
   string (via `psql`, a GUI like TablePlus/pgAdmin, or a short Node
   script using the `pg` package):
   - `supabase/migrations/0001_schema.sql`
   - `supabase/migrations/0002_seed.sql`
   - `supabase/migrations/0003_functions.sql`
5. Seed real passwords for the 8 sample accounts (the seed file only
   inserts a `'PENDING_HASH'` placeholder, mirroring how the original
   PHP app never hand-wrote a password hash either):
   ```
   cd ferry-portal-netlify
   npm install
   # create .env with SUPABASE_URL / SUPABASE_SECRET_KEY (see .env.example)
   node --env-file=.env scripts/hash-seed-passwords.mjs
   ```
   Default password for all sample accounts: `Passw0rd!`
6. Create the two Storage buckets (both public-read, used for profile
   pictures and the portal logo):
   ```js
   // one-off script, or use the Supabase Dashboard: Storage -> New bucket
   import { createClient } from '@supabase/supabase-js';
   const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
   await supabase.storage.createBucket('profile-pictures', { public: true, fileSizeLimit: '2MB' });
   await supabase.storage.createBucket('portal-assets', { public: true, fileSizeLimit: '2MB' });
   ```

## Deploy to Netlify

1. **Push this project to GitHub**:
   ```
   cd ferry-portal-netlify
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/<you>/ferry-portal-netlify.git
   git branch -M main
   git push -u origin main
   ```
   (`.env` is gitignored - your secrets never get committed.)

2. **Create the Netlify site**: [app.netlify.com](https://app.netlify.com)
   → **Add new site → Import an existing project** → connect GitHub →
   pick the repo. Netlify auto-detects `netlify.toml` (build settings,
   publish directory, functions directory) - no manual config needed.

3. **Set environment variables**: Site configuration → Environment
   variables → add:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | your project URL |
   | `SUPABASE_SECRET_KEY` | your secret key |
   | `JWT_SECRET` | a long random string - **generate a fresh one for production**, don't reuse a local dev value: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

4. **Deploy**. Netlify builds and deploys automatically. Your site is
   live at `https://<your-site-name>.netlify.app`.

5. **Log in** as `admin` / `Passw0rd!` and change the password immediately
   (Account menu → Change Password).

## The Scheduled Function

`netlify/functions/expire-bookings.mts` runs every 30 minutes on Netlify's
infrastructure automatically once deployed (see its `config.schedule` -
cron syntax, no separate setup needed). It marks overdue Pending/Waiting
bookings as Expired and past Approved bookings as Completed.

## Local development

```
cd ferry-portal-netlify
npm install
cp .env.example .env   # fill in your real values
npm run dev            # runs `netlify dev` - serves the site at http://localhost:8888
```

## Notes

- **Uploads** (profile pictures, portal logo) go to Supabase Storage, not
  local disk - this works correctly both locally and once deployed,
  unlike a naive "save to the filesystem" approach which would fail on
  Netlify's read-only/ephemeral Functions filesystem.
- **Sessions** are JWT-based (httpOnly cookie), not server-side files -
  see the project's plan doc for the exact idle-timeout/CSRF design and
  the one known behavioral gap versus the original PHP app (a
  deactivated user's existing session takes effect on their *next*
  request rather than instantly - accepted trade-off, see plan doc).
- **Not ported**: `admin/backup.php` and `admin/restore.php` from the
  original PHP app were dropped by design - Supabase handles its own
  backups, and running arbitrary uploaded SQL against a live database
  inside a stateless Function is a bad idea regardless.
