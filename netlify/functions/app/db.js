// Supabase Postgres client, secret key (Supabase's current key naming -
// the "sb_secret_..." key is the equivalent of the legacy service_role
// JWT). Used only inside Netlify Functions (this key must never reach
// the browser) - all authorization checks happen in our own route
// handlers, mirroring how the PHP app did role checks in code rather
// than relying on DB-level policies.

import { createClient } from '@supabase/supabase-js';

let client = null;

export function db() {
    if (!client) {
        const url = process.env.SUPABASE_URL;
        // SUPABASE_SECRET_KEY is the current name; SUPABASE_SERVICE_ROLE_KEY
        // accepted too in case a project still issues the legacy JWT key.
        const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) {
            throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY are not set. See .env.example.');
        }
        client = createClient(url, key, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
    }
    return client;
}

/** Throws a readable error if a Supabase response carries one; otherwise returns data. */
export function unwrap({ data, error }) {
    if (error) {
        throw new Error(error.message || 'Database error');
    }
    return data;
}
