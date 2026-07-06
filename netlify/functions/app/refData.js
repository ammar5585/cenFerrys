// In-memory cache for near-static reference tables (departments,
// resorts), same pattern as settings.js's per-key Map cache and
// approval.js's statusIdCache/roleIdCache - module-level, survives the
// warm-container lifetime, invalidated only on an actual mutation.
// These two tables were previously re-queried fresh on every request
// across ~9 route files with no caching at all.

import { db, unwrap } from './db.js';

let departmentsCache = null;
let resortsCache = null;

export async function getAllDepartments() {
    if (!departmentsCache) {
        departmentsCache = unwrap(await db().from('departments').select('*').order('department_name'));
    }
    return departmentsCache;
}

export async function getActiveDepartments() {
    return (await getAllDepartments()).filter((d) => d.status === 'active');
}

/** Call after any departments insert/update (admin_departments.js) - there is no cache for resorts to invalidate, since resorts has no admin CRUD page in this app (a fixed 2-row seed table, same treatment as roles/booking_status). */
export function resetDepartmentsCache() {
    departmentsCache = null;
}

export async function getAllResorts() {
    if (!resortsCache) {
        resortsCache = unwrap(await db().from('resorts').select('*').order('resort_name'));
    }
    return resortsCache;
}

export async function getActiveResorts() {
    return (await getAllResorts()).filter((r) => r.status === 'active');
}
