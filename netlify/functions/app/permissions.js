// Granular permission resolution. The permission catalog (~55 rows,
// see supabase/migrations/0012_permission_management.sql) is fixed and
// code-owned - only role<->permission assignments and per-user
// overrides are admin-editable - so it's loaded once per warm
// serverless instance and cached for the process lifetime rather than
// hand-duplicated as a JS constant (avoids any risk of a hardcoded bit
// map silently drifting from the DB). `permission_id` doubles as the
// stable bitmask bit position: Postgres IDENTITY columns are never
// reused/renumbered, and this catalog is soft-deprecated (is_active)
// rather than ever having rows deleted, so a permission's bit is
// permanent once assigned.
//
// session.js's getSession() calls getEffectivePermissions() on every
// authenticated request (before any guard/sidebar check runs), which
// guarantees the catalog cache is warm by the time hasPermission() is
// called synchronously elsewhere in the same request.

import { db, unwrap } from './db.js';

let catalogCache = null;

async function loadCatalog() {
    if (catalogCache) return catalogCache;
    const rows = unwrap(
        await db()
            .from('permissions')
            .select('permission_id, permission_key, category, is_module_access')
            .eq('is_active', true)
    );
    const byKey = new Map();
    const byId = new Map();
    for (const r of rows) {
        const entry = { id: r.permission_id, key: r.permission_key, category: r.category, isModuleAccess: r.is_module_access };
        byKey.set(r.permission_key, entry);
        byId.set(r.permission_id, entry);
    }
    catalogCache = { byKey, byId };
    return catalogCache;
}

/** Returns the full permission catalog (for building admin UI matrices). */
export async function getPermissionCatalog() {
    const rows = unwrap(
        await db()
            .from('permissions')
            .select('*')
            .eq('is_active', true)
            .order('display_order')
    );
    await loadCatalog(); // keep the sync-lookup cache warm too
    return rows;
}

/**
 * Computes a user's effective permission bitmask: role defaults, with
 * per-user overrides applied on top (granted=true adds a bit even if
 * the role lacks it; granted=false removes a bit even if the role has
 * it), then strips every fine permission in any category whose
 * "<category>.access" bit ended up off - a disabled module hides
 * everything under it regardless of individual grants.
 */
export async function getEffectivePermissions(userId, roleId) {
    const catalog = await loadCatalog();

    const [roleRows, overrideRows] = await Promise.all([
        db().from('role_permissions').select('permission_id').eq('role_id', roleId).then(unwrap),
        db().from('user_permission_overrides').select('permission_id, granted').eq('user_id', userId).then(unwrap),
    ]);

    let bitmask = 0n;
    for (const row of roleRows) bitmask |= 1n << BigInt(row.permission_id);
    for (const row of overrideRows) {
        const bit = 1n << BigInt(row.permission_id);
        bitmask = row.granted ? bitmask | bit : bitmask & ~bit;
    }

    const disabledCategories = new Set();
    for (const entry of catalog.byId.values()) {
        if (entry.isModuleAccess && !(bitmask & (1n << BigInt(entry.id)))) {
            disabledCategories.add(entry.category);
        }
    }
    if (disabledCategories.size) {
        for (const entry of catalog.byId.values()) {
            if (!entry.isModuleAccess && disabledCategories.has(entry.category)) {
                bitmask &= ~(1n << BigInt(entry.id));
            }
        }
    }

    return bitmask;
}

/** Serializes a bitmask for storage in the session JWT - compact regardless of catalog size. */
export function bitmaskToHex(bitmask) {
    return bitmask.toString(16);
}

function hexToBitmask(hex) {
    if (!hex) return 0n;
    return BigInt(`0x${hex}`);
}

/**
 * Synchronous permission check against an already-computed bitmask
 * (typically `user.perms`, a hex string carried in the session JWT).
 * Requires the catalog cache to already be warm - true for every
 * in-request call, since session.js resolves getEffectivePermissions()
 * before any route handler or template runs.
 */
export function hasPermission(permsHex, permissionKey) {
    if (!catalogCache) {
        throw new Error('Permission catalog not loaded yet - getEffectivePermissions() must run earlier in the request.');
    }
    const entry = catalogCache.byKey.get(permissionKey);
    if (!entry) {
        throw new Error(`Unknown permission key: ${permissionKey}`);
    }
    const bitmask = hexToBitmask(permsHex);
    return (bitmask & (1n << BigInt(entry.id))) !== 0n;
}

/** Structured, insert-only audit entry for a role/permission change - mirrors security_action_log's precedent. */
export async function recordPermissionAudit({
    actorUserId,
    targetType,
    targetRoleId = null,
    targetUserId = null,
    action,
    permissionKey = null,
    previousValue = null,
    newValue = null,
    beforeSnapshot = null,
    afterSnapshot = null,
    ipAddress = null,
}) {
    let permissionId = null;
    if (permissionKey) {
        const catalog = await loadCatalog();
        permissionId = catalog.byKey.get(permissionKey)?.id ?? null;
    }
    unwrap(
        await db().from('permission_audit_log').insert({
            actor_user_id: actorUserId,
            target_type: targetType,
            target_role_id: targetRoleId,
            target_user_id: targetUserId,
            action,
            permission_id: permissionId,
            previous_value: previousValue,
            new_value: newValue,
            before_snapshot: beforeSnapshot,
            after_snapshot: afterSnapshot,
            ip_address: ipAddress,
        })
    );
}
