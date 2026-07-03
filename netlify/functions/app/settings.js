// Port of includes/functions.php's get_setting()/set_setting().
// Cache is per-invocation only (module-level state in a serverless
// function isn't reliably reused across cold starts), which is fine -
// settings change rarely and this still collapses repeat reads within
// a single request's rendering.

import { db, unwrap } from './db.js';

let cache = new Map();

export async function getSetting(key, fallback = null) {
    if (cache.has(key)) return cache.get(key);
    const rows = unwrap(await db().from('settings').select('setting_value').eq('setting_key', key).limit(1));
    const value = rows.length ? rows[0].setting_value : fallback;
    cache.set(key, value);
    return value;
}

export async function setSetting(key, value) {
    unwrap(
        await db()
            .from('settings')
            .upsert({ setting_key: key, setting_value: String(value) }, { onConflict: 'setting_key' })
    );
    cache.set(key, String(value));
}

/** Call at the start of each request so settings changes show up without a redeploy. */
export function resetSettingsCache() {
    cache = new Map();
}
