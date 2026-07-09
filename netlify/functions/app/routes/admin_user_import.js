// CSV bulk user import: upload -> parse/validate -> preview -> confirm,
// with an import history log. The file is staged directly to Supabase
// Storage from the browser (a signed upload URL, bypassing Vercel's
// 4.5MB function request/response body cap) and carried through the
// preview page as a storage path rather than the raw text itself. It's
// re-downloaded and re-parsed/re-validated from scratch on confirm
// (never trust the preview render's results, same discipline used by
// admin_department_approval.js's server-side active-user re-check), then
// deleted from storage - it's a temp upload, not a permanent record.

import crypto from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { db, unwrap } from '../db.js';
import { requirePermission, requireLogin } from '../guards.js';
import { hasPermission } from '../permissions.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { hashPassword } from '../auth.js';
import { sendTemplatedEmail } from '../mailer.js';
import { deferBestEffort } from '../deferred.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound, csvResponse, jsonResponse } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDateTime } from '../format.js';
import { getAllResorts, getActiveDepartments } from '../refData.js';
import { ROLE_ADMIN, ROLE_GM, ROLE_RM, ROLE_HR, ROLE_SECURITY } from '../session.js';

const MAX_ROWS = 1500;
// Vercel Functions cap both request AND response bodies at 4.5MB - files
// are staged directly to Supabase Storage from the browser (bypassing
// that limit entirely) rather than passed through the function body, so
// this is a genuine data-shape sanity cap, not a workaround for the
// platform limit.
const MAX_BYTES = 8 * 1024 * 1024;
const CSV_IMPORT_BUCKET = 'csv-imports';

// Fixed default password for every bulk-imported user (per user request) -
// must_change_password: true forces a change at their first login.
const DEFAULT_IMPORT_PASSWORD = 'Welcome@123';

// Never let a CSV grant Administrator/GM/RM/HR Manager/Security - matching
// how Role is otherwise treated as an explicit admin-only choice elsewhere
// in the app. This is a deny-list (not an allow-list of specific names) so
// it never goes stale as custom roles are added/renamed via Roles &
// Permissions - every other role, built-in or custom, is importable.
const EXCLUDED_ROLES = new Set([ROLE_ADMIN, ROLE_GM, ROLE_RM, ROLE_HR, ROLE_SECURITY]);

const CSV_TEMPLATE = [
    'Employee ID,Full Name,Username,Resort,Department,Designation,Role,Reporting Manager (Employee ID),Email,Phone',
    'EMP101,Jane Doe,jane.doe,CGLM,Front Office,Front Desk Officer,Staff,EMP006,jane.doe@example.com,',
].join('\n');

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

function csvEscape(v) {
    return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

/**
 * Parses and fully validates a raw CSV string against the current
 * database state. Returns { fileError } if the whole upload should be
 * rejected outright, or { rows } - one entry per data row, each with its
 * own errors/warnings and resolved ids so the caller can act on it
 * without re-deriving anything.
 */
async function parseAndValidateCsv(rawText) {
    if (Buffer.byteLength(rawText, 'utf-8') > MAX_BYTES) {
        return { fileError: `File is too large (max ${(MAX_BYTES / (1024 * 1024)).toFixed(1)} MB).` };
    }

    let records;
    try {
        records = parse(rawText, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch (err) {
        return { fileError: `Could not parse CSV file: ${err.message}` };
    }

    if (!records.length) {
        return { fileError: 'The CSV file has no data rows.' };
    }
    if (records.length > MAX_ROWS) {
        return { fileError: `File has ${records.length} rows, which exceeds the ${MAX_ROWS}-row limit per import.` };
    }

    const resorts = await getAllResorts();
    const resortByName = new Map(resorts.map((r) => [r.resort_name.toLowerCase(), r.resort_id]));

    const departments = await getActiveDepartments();
    const departmentByName = new Map(departments.map((d) => [d.department_name.toLowerCase(), d.department_id]));

    const allRoles = unwrap(await db().from('roles').select('role_id, role_name'));
    const importableRoles = allRoles.filter((r) => !EXCLUDED_ROLES.has(r.role_name));
    const roleByName = new Map(importableRoles.map((r) => [r.role_name.toLowerCase(), r]));

    const existingUsers = unwrap(
        await db().from('users').select('user_id, employee_id, username, resort_id, department_id')
    );
    const existingByEmployeeId = new Map(existingUsers.map((u) => [u.employee_id.toLowerCase(), u]));
    const existingByUsername = new Map(existingUsers.map((u) => [u.username.toLowerCase(), u]));

    // Which users are currently assigned as an approval-tier approver
    // anywhere, so a department/resort reassignment can warn (non-blocking)
    // rather than silently orphaning a live hierarchy slot.
    const configRows = unwrap(
        await db().from('department_approval_config').select('resort_id, department_id, manager_user_id, assistant_manager_user_id')
    );
    const approverAssignments = new Map(); // user_id -> [{resort_id, department_id}]
    for (const c of configRows) {
        for (const uid of [c.manager_user_id, c.assistant_manager_user_id]) {
            if (!uid) continue;
            if (!approverAssignments.has(uid)) approverAssignments.set(uid, []);
            approverAssignments.get(uid).push({ resort_id: c.resort_id, department_id: c.department_id });
        }
    }

    const seenEmployeeIds = new Set();
    const seenUsernames = new Set();

    // A Reporting Manager reference may point to a brand-new employee
    // being created in this very same file (importing a manager together
    // with their team in one upload is a normal use case) - so a
    // Reporting Manager ref isn't an error just because it's missing from
    // the DB today; it only fails if it matches nothing at all, in or out
    // of this batch.
    const batchEmployeeIds = new Set(
        records.map((r) => (r['Employee ID'] || '').trim().toLowerCase()).filter(Boolean)
    );

    const rows = records.map((record, index) => {
        const rowNumber = index + 2; // +1 for 1-indexing, +1 for the header row
        const errors = [];
        const warnings = [];

        const employeeId = (record['Employee ID'] || '').trim();
        const fullName = (record['Full Name'] || '').trim();
        const username = (record['Username'] || '').trim();
        const resortName = (record['Resort'] || '').trim();
        const departmentName = (record['Department'] || '').trim();
        const designation = (record['Designation'] || '').trim();
        const roleName = (record['Role'] || '').trim();
        const reportingManagerRef = (record['Reporting Manager (Employee ID)'] || record['Reporting Manager'] || '').trim();
        const email = (record['Email'] || '').trim();
        const phone = (record['Phone'] || '').trim();

        if (!employeeId) errors.push('Employee ID is required.');
        if (!fullName) errors.push('Full Name is required.');
        if (!username) errors.push('Username is required.');

        const employeeIdKey = employeeId.toLowerCase();
        const usernameKey = username.toLowerCase();
        if (employeeId) {
            if (seenEmployeeIds.has(employeeIdKey)) errors.push('Duplicate Employee ID within this file.');
            seenEmployeeIds.add(employeeIdKey);
        }
        if (username) {
            if (seenUsernames.has(usernameKey)) errors.push('Duplicate Username within this file.');
            seenUsernames.add(usernameKey);
        }

        const resortId = resortByName.get(resortName.toLowerCase()) ?? null;
        if (!resortName) errors.push('Resort is required.');
        else if (!resortId) errors.push(`Resort "${resortName}" does not exist.`);

        const departmentId = departmentByName.get(departmentName.toLowerCase()) ?? null;
        if (!departmentName) errors.push('Department is required.');
        else if (!departmentId) errors.push(`Department "${departmentName}" does not exist or is inactive.`);

        let roleId = null;
        let resolvedRoleName = null;
        if (!roleName) {
            errors.push('Role is required.');
        } else {
            const matchedRole = roleByName.get(roleName.toLowerCase()) ?? null;
            if (!matchedRole) {
                errors.push(`Role "${roleName}" is not a valid, assignable role. Check the exact spelling under Roles & Permissions.`);
            } else {
                roleId = matchedRole.role_id;
                resolvedRoleName = matchedRole.role_name;
            }
        }

        let reportingManagerId = null;
        let reportingManagerBatchRef = null;
        if (reportingManagerRef) {
            const refKey = reportingManagerRef.toLowerCase();
            const byEmp = existingByEmployeeId.get(refKey);
            const byUser = existingByUsername.get(refKey);
            const match = byEmp ?? byUser;
            if (match) {
                reportingManagerId = match.user_id;
            } else if (refKey === employeeIdKey) {
                errors.push('Reporting Manager cannot be the same as this row\'s own Employee ID.');
            } else if (batchEmployeeIds.has(refKey)) {
                // Not in the DB yet, but another row in this file has this
                // Employee ID - resolve the link after all rows are created.
                reportingManagerBatchRef = refKey;
                warnings.push(`Reporting Manager "${reportingManagerRef}" is being created in this same file - will be linked automatically after import.`);
            } else {
                errors.push(`Reporting Manager "${reportingManagerRef}" does not match any existing user's Employee ID or username.`);
            }
        }

        const existing = employeeId ? existingByEmployeeId.get(employeeIdKey) : null;
        let mode = existing ? 'update' : 'create';

        // A username collision against a *different* existing user is an
        // error either way (create: taken; update: would collide with
        // someone else).
        const usernameOwner = username ? existingByUsername.get(usernameKey) : null;
        if (usernameOwner && (!existing || usernameOwner.user_id !== existing.user_id)) {
            errors.push(`Username "${username}" is already used by another user.`);
        }

        if (existing && (resortId !== existing.resort_id || departmentId !== existing.department_id)) {
            const assignments = approverAssignments.get(existing.user_id) ?? [];
            if (assignments.length) {
                warnings.push(
                    `This user is currently assigned as a department approver (resort/department id ${assignments
                        .map((a) => `${a.resort_id}/${a.department_id}`)
                        .join(', ')}) - reassigning will not update that automatically.`
                );
            }
        }

        if (errors.length) mode = 'error';

        return {
            rowNumber,
            employeeId,
            fullName,
            username,
            resortName,
            departmentName,
            designation,
            roleName: resolvedRoleName ?? roleName,
            reportingManagerRef,
            email,
            phone,
            resortId,
            departmentId,
            roleId,
            reportingManagerId,
            reportingManagerBatchRef,
            existingUserId: existing?.user_id ?? null,
            mode,
            errors,
            warnings,
        };
    });

    return { rows };
}

function previewPageBody({ rows, storagePath, duplicateMode, csrfToken }) {
    const createCount = rows.filter((r) => r.mode === 'create').length;
    const updateCount = rows.filter((r) => r.mode === 'update').length;
    const errorCount = rows.filter((r) => r.mode === 'error').length;

    const rowsHtml = rows
        .map((r) => {
            const badge =
                r.mode === 'error'
                    ? '<span class="badge bg-danger">Error</span>'
                    : r.mode === 'update'
                      ? '<span class="badge bg-warning text-dark">Update</span>'
                      : '<span class="badge bg-success">Create</span>';
            const notes = [...r.errors.map((e) => `<span class="text-danger d-block small">${h(e)}</span>`), ...r.warnings.map((w) => `<span class="text-warning-emphasis d-block small">${h(w)}</span>`)].join('');
            return html`<tr>
            <td>${r.rowNumber}</td><td>${r.employeeId}</td><td>${r.fullName}</td><td>${r.username}</td>
            <td>${r.resortName}</td><td>${r.departmentName}</td><td>${r.roleName}</td>
            <td>${raw(badge)}</td>
            <td>${raw(notes || '-')}</td>
        </tr>`;
        })
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-file-earmark-arrow-up"></i> Import Preview</h5>
<div class="row g-3 mb-3">
    <div class="col-sm-4"><div class="stat-card bg-grad-green d-flex justify-content-between align-items-center"><div><div class="stat-value">${createCount}</div><div class="stat-label">New Users</div></div><i class="bi bi-person-plus"></i></div></div>
    <div class="col-sm-4"><div class="stat-card bg-grad-orange d-flex justify-content-between align-items-center"><div><div class="stat-value">${updateCount}</div><div class="stat-label">Existing Users (${duplicateMode === 'update' ? 'will update' : 'will skip'})</div></div><i class="bi bi-person-gear"></i></div></div>
    <div class="col-sm-4"><div class="stat-card bg-grad-red d-flex justify-content-between align-items-center"><div><div class="stat-value">${errorCount}</div><div class="stat-label">Errors (will not import)</div></div><i class="bi bi-exclamation-triangle"></i></div></div>
</div>
<div class="card shadow-sm mb-3"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Row</th><th>Employee ID</th><th>Full Name</th><th>Username</th><th>Resort</th><th>Department</th><th>Role</th><th>Status</th><th>Notes</th></tr></thead>
    <tbody>${raw(rowsHtml)}</tbody>
</table></div></div>
<form method="post" action="/admin/users/import/confirm">
    ${raw(csrfField(csrfToken))}
    <input type="hidden" name="duplicate_mode" value="${duplicateMode}">
    <input type="hidden" name="storage_path" value="${storagePath}">
    <button type="submit" class="btn btn-primary" ${createCount + updateCount === 0 ? 'disabled' : ''}>
        <i class="bi bi-check-lg"></i> Confirm Import (${createCount + (duplicateMode === 'update' ? updateCount : 0)} row(s))
    </button>
    <a href="/admin/users/import" class="btn btn-outline-secondary">Cancel</a>
</form>`;
}

function resultsPageBody({ createdRows, updatedCount, failedRows, totalCount }) {
    const createdRowsHtml = createdRows
        .map((r) => html`<tr><td>${r.employeeId}</td><td>${r.username}</td></tr>`)
        .map((r) => r.toString())
        .join('');

    const failedRowsHtml = failedRows
        .map((r) => html`<tr><td>${r.row_number}</td><td>${r.employee_id}</td><td>${(r.errors ?? []).join('; ')}</td></tr>`)
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-check2-circle"></i> Import Complete</h5>
<p>${createdRows.length + updatedCount} of ${totalCount} row(s) succeeded (${createdRows.length} created, ${updatedCount} updated), ${failedRows.length} failed/skipped.</p>
${createdRows.length
    ? html`
<div class="alert alert-warning"><i class="bi bi-exclamation-triangle"></i> Every new user has been given the default password <code>${DEFAULT_IMPORT_PASSWORD}</code>. Share it with them - each user is forced to change it at first login.</div>
<div class="card shadow-sm mb-3"><div class="card-header bg-white">New Users</div><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Employee ID</th><th>Username</th></tr></thead>
    <tbody>${raw(createdRowsHtml)}</tbody>
</table></div></div>`
    : ''}
${failedRows.length
    ? html`
<div class="card shadow-sm mb-3"><div class="card-header bg-white">Failed / Skipped Rows</div><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Row</th><th>Employee ID</th><th>Reason</th></tr></thead>
    <tbody>${raw(failedRowsHtml)}</tbody>
</table></div></div>`
    : ''}
<a href="/admin/users/import" class="btn btn-outline-secondary">Import Another File</a>
<a href="/admin/users/import/history" class="btn btn-outline-primary">View Import History</a>
<a href="/admin/users" class="btn btn-outline-primary">Go to User Management</a>`;
}

function uploadPageBody(csrfToken) {
    // The CSV is staged directly to Supabase Storage from the browser
    // (signed upload URL) instead of being posted through this function -
    // Vercel Functions cap request/response bodies at 4.5MB, which a large
    // employee roster CSV can exceed. JS intercepts submit, uploads the
    // file, then does a normal form POST carrying only the storage path.
    const script = `
(function () {
    var form = document.getElementById('importForm');
    var fileInput = document.getElementById('csvFile');
    var storagePathInput = document.getElementById('storagePathInput');
    var submitBtn = document.getElementById('importSubmitBtn');
    var errorBox = document.getElementById('importErrorBox');

    form.addEventListener('submit', function (e) {
        if (storagePathInput.value) return; // already staged, let the real submit through
        e.preventDefault();
        var file = fileInput.files[0];
        if (!file) return;
        errorBox.classList.add('d-none');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Uploading...';

        var fd = new FormData();
        fd.append('csrf_token', window.CSRF_TOKEN);
        fetch('/admin/users/import/upload-url', { method: 'POST', body: fd })
            .then(function (res) { if (!res.ok) throw new Error('Could not prepare upload.'); return res.json(); })
            .then(function (data) {
                return fetch(data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: file })
                    .then(function (putRes) {
                        if (!putRes.ok) throw new Error('File upload failed.');
                        storagePathInput.value = data.path;
                        form.submit();
                    });
            })
            .catch(function (err) {
                errorBox.textContent = err.message || 'Upload failed. Please try again.';
                errorBox.classList.remove('d-none');
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="bi bi-upload"></i> Upload &amp; Preview';
            });
    });
})();`;

    return html`
<h5 class="mb-3"><i class="bi bi-file-earmark-arrow-up"></i> Bulk Import Users</h5>
<p class="text-muted">Upload a CSV file to create or update multiple users at once. <a href="/admin/users/import/template">Download the CSV template</a>. <a href="/admin/users/import/history">View import history</a>.</p>
<div class="card shadow-sm"><div class="card-body">
    <div id="importErrorBox" class="alert alert-danger d-none"></div>
    <form method="post" action="/admin/users/import" id="importForm">
        ${raw(csrfField(csrfToken))}
        <input type="hidden" name="storage_path" id="storagePathInput" value="">
        <div class="mb-3"><label class="form-label">CSV File *</label><input type="file" id="csvFile" accept=".csv" class="form-control" required></div>
        <div class="mb-3">
            <label class="form-label d-block">If an Employee ID already exists</label>
            <div class="form-check"><input class="form-check-input" type="radio" name="duplicate_mode" value="skip" id="dupSkip" checked><label class="form-check-label" for="dupSkip">Skip (do not modify the existing user) - recommended</label></div>
            <div class="form-check"><input class="form-check-input" type="radio" name="duplicate_mode" value="update" id="dupUpdate"><label class="form-check-label" for="dupUpdate">Update the existing user's details (password is never changed by import)</label></div>
        </div>
        <button type="submit" class="btn btn-primary" id="importSubmitBtn"><i class="bi bi-upload"></i> Upload &amp; Preview</button>
    </form>
</div></div>
<script>${raw(script)}</script>`;
}

async function historyPageBody() {
    const imports = unwrap(
        await db()
            .from('user_import_history')
            .select('import_id, imported_at, filename, total_count, success_count, fail_count, imported_by_user:imported_by(full_name)')
            .order('imported_at', { ascending: false })
            .limit(50)
    );

    const rowsHtml = imports
        .map(
            (i) => html`<tr>
            <td>${formatDateTime(i.imported_at)}</td><td>${i.imported_by_user?.full_name ?? 'Unknown'}</td>
            <td>${i.filename ?? '-'}</td><td>${i.total_count}</td><td>${i.success_count}</td><td>${i.fail_count}</td>
            <td>${i.fail_count > 0 ? html`<a href="/admin/users/import/history/errors?import_id=${i.import_id}"><i class="bi bi-download"></i> Error Report</a>` : '-'}</td>
        </tr>`
        )
        .map((r) => r.toString())
        .join('');

    return html`
<h5 class="mb-3"><i class="bi bi-clock-history"></i> Import History</h5>
<p><a href="/admin/users/import">&larr; Back to Bulk Import</a></p>
<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
    <thead><tr><th>Date/Time</th><th>Imported By</th><th>File</th><th>Total</th><th>Success</th><th>Failed/Skipped</th><th>Error Report</th></tr></thead>
    <tbody>${raw(rowsHtml || '<tr><td colspan="7" class="text-center text-muted py-4">No imports yet.</td></tr>')}</tbody>
</table></div></div>`;
}

export function registerAdminUserImportRoutes(router) {
    router.get('/admin/users/import', async (request) => {
        const auth = await requirePermission(request, 'user_management.import', { pageTitle: 'Bulk Import Users' });
        if (auth.response) return auth.response;
        const body = uploadPageBody(auth.user.csrf);
        return renderShellForRequest({ request, auth, pageTitle: 'Bulk Import Users', path: '/admin/users/import', bodyHtml: body });
    });

    router.get('/admin/users/import/template', async (request) => {
        const auth = await requirePermission(request, 'user_management.import', { pageTitle: 'Bulk Import Users' });
        if (auth.response) return auth.response;
        return csvResponse(CSV_TEMPLATE, 'user_import_template.csv');
    });

    router.get('/admin/users/import/history', async (request) => {
        const auth = await requirePermission(request, 'user_management.view_import_history', { pageTitle: 'Import History' });
        if (auth.response) return auth.response;
        const body = await historyPageBody();
        return renderShellForRequest({ request, auth, pageTitle: 'Import History', path: '/admin/users/import/history', bodyHtml: body });
    });

    router.get('/admin/users/import/history/errors', async (request, ctx, url) => {
        const auth = await requirePermission(request, 'user_management.view_import_history', { pageTitle: 'Import History' });
        if (auth.response) return auth.response;
        const importId = Number(url.searchParams.get('import_id'));
        const rows = unwrap(await db().from('user_import_history').select('failed_rows').eq('import_id', importId).limit(1));
        if (!rows.length) return notFound();

        const header = 'Row,Employee ID,Errors\n';
        const body = (rows[0].failed_rows ?? [])
            .map((r) => [r.row_number, r.employee_id, (r.errors ?? []).join('; ')].map(csvEscape).join(','))
            .join('\n');
        return csvResponse(header + body, `import_${importId}_errors.csv`);
    });

    // Issues a short-lived signed URL the browser uploads the CSV straight
    // to Supabase Storage with - the file's bytes never pass through this
    // function, so Vercel's 4.5MB request-body cap doesn't apply to it.
    router.post('/admin/users/import/upload-url', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return jsonResponse({ error: 'Not authenticated.' }, { status: 401 });
        if (!hasPermission(auth.user.perms, 'user_management.import')) {
            return jsonResponse({ error: 'Forbidden.' }, { status: 403 });
        }
        const form = await request.formData();
        if (!verifyCsrf(auth.user.csrf, form.get('csrf_token'))) {
            return jsonResponse({ error: 'Invalid request.' }, { status: 403 });
        }

        const filename = `import_${crypto.randomBytes(8).toString('hex')}.csv`;
        const { data, error } = await db().storage.from(CSV_IMPORT_BUCKET).createSignedUploadUrl(filename);
        if (error) return jsonResponse({ error: 'Could not prepare upload.' }, { status: 500 });

        return jsonResponse({ uploadUrl: data.signedUrl, path: data.path });
    });

    router.post('/admin/users/import', async (request) => {
        const auth = await requirePermission(request, 'user_management.import', { pageTitle: 'Bulk Import Users' });
        if (auth.response) return auth.response;
        const { user } = auth;

        const form = await request.formData();
        if (!verifyCsrf(user.csrf, form.get('csrf_token'))) return notFound();

        const storagePath = form.get('storage_path');
        const duplicateMode = form.get('duplicate_mode') === 'update' ? 'update' : 'skip';
        if (!storagePath) {
            return redirectTo('/admin/users/import', { cookies: [auth.setCookie, flashSetCookie('error', 'Please choose a CSV file to upload.')].filter(Boolean) });
        }

        const { data: fileBlob, error: dlError } = await db().storage.from(CSV_IMPORT_BUCKET).download(storagePath);
        if (dlError) {
            return redirectTo('/admin/users/import', { cookies: [auth.setCookie, flashSetCookie('error', 'Could not retrieve the uploaded file - please try uploading again.')].filter(Boolean) });
        }
        const rawText = await fileBlob.text();

        const { fileError, rows } = await parseAndValidateCsv(rawText);
        if (fileError) {
            await db().storage.from(CSV_IMPORT_BUCKET).remove([storagePath]);
            return redirectTo('/admin/users/import', { cookies: [auth.setCookie, flashSetCookie('error', fileError)].filter(Boolean) });
        }

        // Not deleted yet - the confirm step re-downloads and re-validates
        // from scratch (never trust the preview render), then cleans up.
        const body = previewPageBody({ rows, storagePath, duplicateMode, csrfToken: user.csrf });
        return renderShellForRequest({ request, auth, pageTitle: 'Import Preview', path: '/admin/users/import', bodyHtml: body });
    });

    router.post('/admin/users/import/confirm', async (request) => {
        const auth = await requirePermission(request, 'user_management.import', { pageTitle: 'Bulk Import Users' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const duplicateMode = form.duplicate_mode === 'update' ? 'update' : 'skip';
        const storagePath = form.storage_path || '';
        if (!storagePath) {
            return redirectTo('/admin/users/import', { cookies: [auth.setCookie, flashSetCookie('error', 'Upload session expired - please upload the file again.')].filter(Boolean) });
        }

        const { data: fileBlob, error: dlError } = await db().storage.from(CSV_IMPORT_BUCKET).download(storagePath);
        if (dlError) {
            return redirectTo('/admin/users/import', { cookies: [auth.setCookie, flashSetCookie('error', 'Upload session expired - please upload the file again.')].filter(Boolean) });
        }
        const rawText = await fileBlob.text();

        // Re-parse and re-validate from scratch - never trust the preview render.
        const { fileError, rows } = await parseAndValidateCsv(rawText);
        // Done with the staged file either way - it's a temp upload, not a
        // permanent record (the import_history row below is the audit trail).
        await db().storage.from(CSV_IMPORT_BUCKET).remove([storagePath]);
        if (fileError) {
            return redirectTo('/admin/users/import', { cookies: [auth.setCookie, flashSetCookie('error', fileError)].filter(Boolean) });
        }

        let successCount = 0;
        const failedRows = [];
        // Every bulk-imported user gets the same fixed default password
        // (not a per-user random one) - must_change_password forces them
        // off it at first login, same as the single-user reset_password
        // action's forced-change behavior.
        const createdRows = [];
        let updatedCount = 0;
        // employee_id (lowercase) -> newly-created user_id, so rows whose
        // Reporting Manager pointed at another new employee in this same
        // file can be linked up in a second pass below, once that manager
        // actually has a user_id.
        const createdUserIdByEmployeeId = new Map();
        const rowsNeedingBatchLink = [];

        for (const r of rows) {
            if (r.mode === 'error') {
                failedRows.push({ row_number: r.rowNumber, employee_id: r.employeeId, errors: r.errors });
                continue;
            }

            if (r.mode === 'update' && duplicateMode === 'skip') {
                failedRows.push({ row_number: r.rowNumber, employee_id: r.employeeId, errors: ['Skipped: Employee ID already exists (skip mode).'] });
                continue;
            }

            try {
                if (r.mode === 'create') {
                    const hash = await hashPassword(DEFAULT_IMPORT_PASSWORD);
                    const inserted = unwrap(
                        await db()
                            .from('users')
                            .insert({
                                employee_id: r.employeeId,
                                full_name: r.fullName,
                                username: r.username,
                                password: hash,
                                must_change_password: true,
                                resort_id: r.resortId,
                                department_id: r.departmentId,
                                designation: r.designation || null,
                                role_id: r.roleId,
                                reporting_manager_id: r.reportingManagerId,
                                email: r.email || null,
                                phone: r.phone || null,
                                status: 'active',
                            })
                            .select('user_id')
                    );
                    const newUserId = inserted[0].user_id;
                    createdUserIdByEmployeeId.set(r.employeeId.toLowerCase(), newUserId);
                    if (r.reportingManagerBatchRef) rowsNeedingBatchLink.push({ userId: newUserId, managerEmployeeId: r.reportingManagerBatchRef });
                    createdRows.push({ employeeId: r.employeeId, username: r.username });
                    if (r.email) {
                        deferBestEffort(
                            sendTemplatedEmail('user_creation', r.email, {
                                full_name: r.fullName,
                                username: r.username,
                                temp_password: DEFAULT_IMPORT_PASSWORD,
                            }),
                            'sendTemplatedEmail:user_creation'
                        );
                    }
                } else {
                    // Update: never touch password.
                    unwrap(
                        await db()
                            .from('users')
                            .update({
                                full_name: r.fullName,
                                username: r.username,
                                resort_id: r.resortId,
                                department_id: r.departmentId,
                                designation: r.designation || null,
                                role_id: r.roleId,
                                reporting_manager_id: r.reportingManagerId,
                                email: r.email || null,
                                phone: r.phone || null,
                            })
                            .eq('user_id', r.existingUserId)
                    );
                    if (r.reportingManagerBatchRef) rowsNeedingBatchLink.push({ userId: r.existingUserId, managerEmployeeId: r.reportingManagerBatchRef });
                    updatedCount++;
                }
                successCount++;
            } catch (err) {
                failedRows.push({ row_number: r.rowNumber, employee_id: r.employeeId, errors: [`Database error: ${err.message}`] });
            }
        }

        // Second pass: link up rows whose Reporting Manager was another
        // employee being created in this same file - their manager didn't
        // have a user_id yet during the loop above.
        for (const { userId, managerEmployeeId } of rowsNeedingBatchLink) {
            const managerId = createdUserIdByEmployeeId.get(managerEmployeeId);
            if (!managerId) continue; // manager's own row failed to create - leave unlinked
            unwrap(await db().from('users').update({ reporting_manager_id: managerId }).eq('user_id', userId));
        }

        unwrap(
            await db().from('user_import_history').insert({
                imported_by: user.user_id,
                filename: null,
                total_count: rows.length,
                success_count: successCount,
                fail_count: failedRows.length,
                failed_rows: failedRows,
            })
        );
        await logActivity(user.user_id, 'Bulk-imported users', `total=${rows.length}, success=${successCount}, failed=${failedRows.length}`, clientIp(request));

        const resultBody = resultsPageBody({ createdRows, updatedCount, failedRows, totalCount: rows.length });
        return renderShellForRequest({
            request,
            auth,
            pageTitle: 'Import Complete',
            path: '/admin/users/import/confirm',
            bodyHtml: resultBody,
        });
    });
}
