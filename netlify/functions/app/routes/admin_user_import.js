// CSV bulk user import: upload -> parse/validate -> preview -> confirm,
// with an import history log. The working data is never staged in the
// database - the raw CSV text is carried through the preview page's
// hidden form field and re-parsed/re-validated from scratch on confirm
// (never trust the preview render's results, same discipline used by
// admin_department_approval.js's server-side active-user re-check).

import { parse } from 'csv-parse/sync';
import { db, unwrap } from '../db.js';
import { requirePermission } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { hashPassword } from '../auth.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound, csvResponse } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { formatDateTime } from '../format.js';
import { getAllResorts, getActiveDepartments } from '../refData.js';

const MAX_ROWS = 1500;
const MAX_BYTES = 1.5 * 1024 * 1024;

// Fixed default password for every bulk-imported user (per user request) -
// must_change_password: true forces a change at their first login.
const DEFAULT_IMPORT_PASSWORD = 'Welcome@123';

// Never let a CSV grant Administrator/GM/RM/HR Manager - only these
// three, matching how Role is otherwise treated as an explicit
// admin-only choice everywhere else in the app.
const ALLOWED_ROLES = ['Staff', 'Department Manager', 'Transport Coordinator'];

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

    const roles = unwrap(await db().from('roles').select('role_id, role_name').in('role_name', ALLOWED_ROLES));
    const roleByName = new Map(roles.map((r) => [r.role_name.toLowerCase(), r.role_id]));

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
            roleId = roleByName.get(roleName.toLowerCase()) ?? null;
            if (!roleId) {
                errors.push(`Role must be one of: ${ALLOWED_ROLES.join(', ')}.`);
            } else {
                resolvedRoleName = ALLOWED_ROLES.find((r) => r.toLowerCase() === roleName.toLowerCase());
            }
        }

        let reportingManagerId = null;
        if (reportingManagerRef) {
            const byEmp = existingByEmployeeId.get(reportingManagerRef.toLowerCase());
            const byUser = existingByUsername.get(reportingManagerRef.toLowerCase());
            const match = byEmp ?? byUser;
            if (!match) {
                errors.push(`Reporting Manager "${reportingManagerRef}" does not match any existing user's Employee ID or username.`);
            } else {
                reportingManagerId = match.user_id;
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
            existingUserId: existing?.user_id ?? null,
            mode,
            errors,
            warnings,
        };
    });

    return { rows };
}

function previewPageBody({ rows, rawText, duplicateMode, csrfToken }) {
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
    <textarea name="csv_text" style="display:none">${rawText}</textarea>
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
    return html`
<h5 class="mb-3"><i class="bi bi-file-earmark-arrow-up"></i> Bulk Import Users</h5>
<p class="text-muted">Upload a CSV file to create or update multiple users at once. <a href="/admin/users/import/template">Download the CSV template</a>. <a href="/admin/users/import/history">View import history</a>.</p>
<div class="card shadow-sm"><div class="card-body">
    <form method="post" enctype="multipart/form-data">
        ${raw(csrfField(csrfToken))}
        <div class="mb-3"><label class="form-label">CSV File *</label><input type="file" name="csv_file" accept=".csv" class="form-control" required></div>
        <div class="mb-3">
            <label class="form-label d-block">If an Employee ID already exists</label>
            <div class="form-check"><input class="form-check-input" type="radio" name="duplicate_mode" value="skip" id="dupSkip" checked><label class="form-check-label" for="dupSkip">Skip (do not modify the existing user) - recommended</label></div>
            <div class="form-check"><input class="form-check-input" type="radio" name="duplicate_mode" value="update" id="dupUpdate"><label class="form-check-label" for="dupUpdate">Update the existing user's details (password is never changed by import)</label></div>
        </div>
        <button type="submit" class="btn btn-primary"><i class="bi bi-upload"></i> Upload &amp; Preview</button>
    </form>
</div></div>`;
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

    router.post('/admin/users/import', async (request) => {
        const auth = await requirePermission(request, 'user_management.import', { pageTitle: 'Bulk Import Users' });
        if (auth.response) return auth.response;
        const { user } = auth;

        const form = await request.formData();
        if (!verifyCsrf(user.csrf, form.get('csrf_token'))) return notFound();

        const file = form.get('csv_file');
        const duplicateMode = form.get('duplicate_mode') === 'update' ? 'update' : 'skip';
        if (!file || typeof file.text !== 'function') {
            return redirectTo('/admin/users/import', { cookies: [auth.setCookie, flashSetCookie('error', 'Please choose a CSV file to upload.')].filter(Boolean) });
        }

        const rawText = await file.text();
        const { fileError, rows } = await parseAndValidateCsv(rawText);
        if (fileError) {
            return redirectTo('/admin/users/import', { cookies: [auth.setCookie, flashSetCookie('error', fileError)].filter(Boolean) });
        }

        const body = previewPageBody({ rows, rawText, duplicateMode, csrfToken: user.csrf });
        return renderShellForRequest({ request, auth, pageTitle: 'Import Preview', path: '/admin/users/import', bodyHtml: body });
    });

    router.post('/admin/users/import/confirm', async (request) => {
        const auth = await requirePermission(request, 'user_management.import', { pageTitle: 'Bulk Import Users' });
        if (auth.response) return auth.response;
        const { user } = auth;
        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return notFound();

        const duplicateMode = form.duplicate_mode === 'update' ? 'update' : 'skip';
        const rawText = form.csv_text || '';

        // Re-parse and re-validate from scratch - never trust the preview render.
        const { fileError, rows } = await parseAndValidateCsv(rawText);
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
                    unwrap(
                        await db().from('users').insert({
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
                    );
                    createdRows.push({ employeeId: r.employeeId, username: r.username });
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
                    updatedCount++;
                }
                successCount++;
            } catch (err) {
                failedRows.push({ row_number: r.rowNumber, employee_id: r.employeeId, errors: [`Database error: ${err.message}`] });
            }
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
