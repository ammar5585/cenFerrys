// Port of auth/login.php, auth/logout.php, auth/change_password.php,
// auth/forgot_password.php.

import { db, unwrap } from '../db.js';
import { hashPassword, verifyPassword, signSessionToken, buildSessionCookie, clearSessionCookie, newCsrfToken } from '../auth.js';
import { mintPreAuthCsrf, readPreAuthCsrfCookie, verifyCsrf, csrfField } from '../csrf.js';
import { getSetting } from '../settings.js';
import { logActivity, clientIp } from '../activity.js';
import { createNotification } from '../notifications.js';
import { requireLogin } from '../guards.js';
import { redirectTo, htmlResponse, forbidden } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { publicShell } from '../templates/layout.js';
import { html, raw } from '../templates/html.js';
import { renderShellForRequest } from '../shellHelper.js';
import { ROLE_ADMIN, getSession } from '../session.js';

async function readFormBody(request) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
}

function loginPage({ error, timeout, csrfToken, companyName, username = '' }) {
    const body = html`
<div class="login-wrapper">
    <div class="card login-card">
        <div class="card-body p-4">
            <div class="text-center mb-4">
                <i class="bi bi-water" style="font-size:2.5rem;color:#0d6efd;"></i>
                <h4 class="mt-2 mb-0">${companyName}</h4>
                <p class="text-muted small">Staff Ferry Transfer Portal</p>
            </div>

            ${timeout ? html`<div class="alert alert-warning py-2">Your session expired. Please log in again.</div>` : ''}
            ${error ? html`<div class="alert alert-danger py-2">${error}</div>` : ''}

            <form method="post" novalidate>
                ${raw(csrfField(csrfToken))}
                <div class="mb-3">
                    <label class="form-label">Username</label>
                    <input type="text" class="form-control" name="username" required autofocus autocomplete="username" value="${username}">
                </div>
                <div class="mb-3">
                    <label class="form-label">Password</label>
                    <input type="password" class="form-control" name="password" required autocomplete="current-password">
                </div>
                <div class="mb-3 form-check">
                    <input type="checkbox" class="form-check-input" id="remember" name="remember">
                    <label class="form-check-label" for="remember">Keep me signed in</label>
                </div>
                <button type="submit" class="btn btn-primary w-100">Sign In</button>
            </form>
            <p class="text-center text-muted small mt-3 mb-0"><a href="/auth/forgot_password">Forgot your password?</a></p>
        </div>
    </div>
</div>`;
    return publicShell({ pageTitle: 'Login', companyName, bodyHtml: body });
}

export function registerAuthRoutes(router) {
    router.get('/auth/login', async (request) => {
        const { user } = await getSession(request);
        if (user) return redirectTo('/dashboard');

        const companyName = await getSetting('company_name', 'Staff Ferry Transfer Portal');
        const url = new URL(request.url);
        const { token, setCookie } = mintPreAuthCsrf();
        const body = loginPage({
            error: null,
            timeout: url.searchParams.get('timeout') === '1',
            csrfToken: token,
            companyName,
        });
        return htmlResponse(body.toString(), { cookies: [setCookie] });
    });

    router.post('/auth/login', async (request) => {
        const companyName = await getSetting('company_name', 'Staff Ferry Transfer Portal');
        const form = await readFormBody(request);
        const submittedCsrf = form.csrf_token;
        const preAuthCsrf = readPreAuthCsrfCookie(request);

        if (!verifyCsrf(preAuthCsrf, submittedCsrf)) {
            return forbidden('Invalid or expired form submission. Please go back and try again.');
        }

        const username = (form.username || '').trim();
        const password = form.password || '';

        if (!username || !password) {
            const { token, setCookie } = mintPreAuthCsrf();
            const body = loginPage({ error: 'Please enter both username and password.', timeout: false, csrfToken: token, companyName, username });
            return htmlResponse(body.toString(), { cookies: [setCookie] });
        }

        const rows = unwrap(
            await db()
                .from('users')
                .select('user_id, employee_id, full_name, username, password, department_id, status, must_change_password, role_id, roles(role_name), departments(department_name)')
                .eq('username', username)
                .limit(1)
        );
        const user = rows[0];
        const passwordOk = user ? await verifyPassword(password, user.password) : false;

        if (!user || !passwordOk) {
            await logActivity(user?.user_id ?? null, 'Failed login attempt', `Username: ${username}`, clientIp(request));
            const { token, setCookie } = mintPreAuthCsrf();
            const body = loginPage({ error: 'Invalid username or password.', timeout: false, csrfToken: token, companyName, username });
            return htmlResponse(body.toString(), { cookies: [setCookie] });
        }

        if (user.status !== 'active') {
            const { token, setCookie } = mintPreAuthCsrf();
            const body = loginPage({ error: 'Your account is inactive. Please contact the Administrator.', timeout: false, csrfToken: token, companyName, username });
            return htmlResponse(body.toString(), { cookies: [setCookie] });
        }

        const maintenanceMode = await getSetting('maintenance_mode', '0');
        const roleName = user.roles?.role_name;
        if (maintenanceMode === '1' && roleName !== ROLE_ADMIN) {
            const { token, setCookie } = mintPreAuthCsrf();
            const body = loginPage({ error: 'The portal is currently under maintenance. Please try again later.', timeout: false, csrfToken: token, companyName, username });
            return htmlResponse(body.toString(), { cookies: [setCookie] });
        }

        const timeoutMinutes = Number(await getSetting('session_timeout_minutes', 30));
        const csrfToken = newCsrfToken();
        const sessionToken = signSessionToken(
            {
                user_id: user.user_id,
                employee_id: user.employee_id,
                full_name: user.full_name,
                username: user.username,
                role_id: user.role_id,
                role_name: roleName,
                department_name: user.departments?.department_name ?? null,
            },
            csrfToken,
            timeoutMinutes
        );
        const remember = form.remember ? { rememberDays: 30 } : {};
        const sessionCookie = buildSessionCookie(sessionToken, remember);

        await logActivity(user.user_id, 'Login', 'User logged in successfully', clientIp(request));

        if (user.must_change_password) {
            return redirectTo('/auth/change_password', {
                cookies: [sessionCookie, flashSetCookie('warning', 'Please change your password to continue.')],
            });
        }
        return redirectTo('/dashboard', { cookies: [sessionCookie] });
    });

    router.get('/auth/logout', async (request) => {
        const auth = await requireLogin(request);
        if (!auth.response) {
            await logActivity(auth.user.user_id, 'Logout', 'User logged out', clientIp(request));
        }
        return redirectTo('/auth/login', { cookies: [clearSessionCookie()] });
    });

    router.get('/auth/change_password', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;
        const url = new URL(request.url);
        const minLength = Number(await getSetting('password_min_length', 8));
        return renderShellForRequest({
            request,
            auth,
            pageTitle: 'Change Password',
            path: url.pathname,
            bodyHtml: changePasswordBody({ errors: [], minLength, csrfToken: auth.user.csrf }),
        });
    });

    router.post('/auth/change_password', async (request) => {
        const auth = await requireLogin(request);
        if (auth.response) return auth.response;
        const { user } = auth;
        const url = new URL(request.url);

        const form = await readFormBody(request);
        if (!verifyCsrf(user.csrf, form.csrf_token)) return forbidden();

        const minLength = Number(await getSetting('password_min_length', 8));
        const errors = [];

        const rows = unwrap(await db().from('users').select('password').eq('user_id', user.user_id).limit(1));
        const currentHash = rows[0]?.password;
        const currentOk = currentHash ? await verifyPassword(form.current_password || '', currentHash) : false;

        if (!currentOk) errors.push('Current password is incorrect.');
        if ((form.new_password || '').length < minLength) errors.push(`New password must be at least ${minLength} characters long.`);
        if (form.new_password !== form.confirm_password) errors.push('New password and confirmation do not match.');

        if (errors.length) {
            return renderShellForRequest({
                request,
                auth,
                pageTitle: 'Change Password',
                path: url.pathname,
                bodyHtml: changePasswordBody({ errors, minLength, csrfToken: user.csrf }),
            });
        }

        const newHash = await hashPassword(form.new_password);
        unwrap(
            await db()
                .from('users')
                .update({ password: newHash, must_change_password: false })
                .eq('user_id', user.user_id)
        );
        await logActivity(user.user_id, 'Changed password', null, clientIp(request));

        return redirectTo('/dashboard', {
            cookies: [auth.setCookie, flashSetCookie('success', 'Your password has been updated.')].filter(Boolean),
        });
    });

    router.get('/auth/forgot_password', async (request) => {
        const { user } = await getSession(request);
        if (user) return redirectTo('/dashboard');

        const companyName = await getSetting('company_name', 'Staff Ferry Transfer Portal');
        const { token, setCookie } = mintPreAuthCsrf();
        const body = forgotPasswordPage({ submitted: false, error: null, csrfToken: token, companyName });
        return htmlResponse(body.toString(), { cookies: [setCookie] });
    });

    router.post('/auth/forgot_password', async (request) => {
        const companyName = await getSetting('company_name', 'Staff Ferry Transfer Portal');
        const form = await readFormBody(request);
        const preAuthCsrf = readPreAuthCsrfCookie(request);
        if (!verifyCsrf(preAuthCsrf, form.csrf_token)) return forbidden();

        const identifier = (form.identifier || '').trim();
        if (!identifier) {
            const { token, setCookie } = mintPreAuthCsrf();
            const body = forgotPasswordPage({ submitted: false, error: 'Please enter your Username or Employee ID.', csrfToken: token, companyName });
            return htmlResponse(body.toString(), { cookies: [setCookie] });
        }

        // Two separate .eq() lookups rather than a single .or() filter -
        // Supabase's .or() takes a raw filter string that untrusted input
        // must not be interpolated into (it doesn't get the same safe
        // parameterization .eq() does).
        const byUsername = unwrap(await db().from('users').select('user_id, full_name').eq('username', identifier).limit(1));
        const byEmployeeId = byUsername.length
            ? []
            : unwrap(await db().from('users').select('user_id, full_name').eq('employee_id', identifier).limit(1));
        const matched = byUsername[0] || byEmployeeId[0];

        // Notify all admins regardless of match, so this can't be used to enumerate usernames.
        const admins = unwrap(
            await db()
                .from('users')
                .select('user_id, roles!inner(role_name)')
                .eq('status', 'active')
                .eq('roles.role_name', 'Administrator')
        );
        const message = matched
            ? `Password reset requested by ${matched.full_name} (${identifier}).`
            : `Password reset requested for unknown identifier: ${identifier}`;
        for (const admin of admins) {
            await createNotification(admin.user_id, message, 'password_reset');
        }
        await logActivity(matched?.user_id ?? null, 'Password reset requested', `Identifier: ${identifier}`, clientIp(request));

        const body = forgotPasswordPage({ submitted: true, error: null, csrfToken: null, companyName });
        return htmlResponse(body.toString());
    });
}

function changePasswordBody({ errors, minLength, csrfToken }) {
    return html`
<div class="row justify-content-center">
    <div class="col-md-6 col-lg-5">
        <div class="card shadow-sm">
            <div class="card-body p-4">
                <h5 class="card-title mb-3"><i class="bi bi-key"></i> Change Password</h5>
                ${errors.length
                    ? html`<div class="alert alert-danger"><ul class="mb-0">${raw(errors.map((e) => `<li>${e}</li>`).join(''))}</ul></div>`
                    : ''}
                <form method="post" novalidate>
                    ${raw(csrfField(csrfToken))}
                    <div class="mb-3">
                        <label class="form-label">Current Password</label>
                        <input type="password" name="current_password" class="form-control" required>
                    </div>
                    <div class="mb-3">
                        <label class="form-label">New Password</label>
                        <input type="password" name="new_password" class="form-control" required minlength="${minLength}">
                        <div class="form-text">Minimum ${minLength} characters.</div>
                    </div>
                    <div class="mb-3">
                        <label class="form-label">Confirm New Password</label>
                        <input type="password" name="confirm_password" class="form-control" required minlength="${minLength}">
                    </div>
                    <button type="submit" class="btn btn-primary">Update Password</button>
                </form>
            </div>
        </div>
    </div>
</div>`;
}

function forgotPasswordPage({ submitted, error, csrfToken, companyName }) {
    const body = html`
<div class="login-wrapper">
    <div class="card login-card">
        <div class="card-body p-4">
            <div class="text-center mb-4">
                <i class="bi bi-key" style="font-size:2.5rem;color:#0d6efd;"></i>
                <h4 class="mt-2 mb-0">Forgot Password</h4>
                <p class="text-muted small">This portal does not use email. Submitting this form notifies the Administrator to reset your password.</p>
            </div>
            ${submitted
                ? html`<div class="alert alert-success">Your request has been sent to the Administrator. Please contact them for your new password.</div>
                       <a href="/auth/login" class="btn btn-primary w-100">Back to Login</a>`
                : html`
                    ${error ? html`<div class="alert alert-danger py-2">${error}</div>` : ''}
                    <form method="post" novalidate>
                        ${raw(csrfField(csrfToken))}
                        <div class="mb-3">
                            <label class="form-label">Username or Employee ID</label>
                            <input type="text" class="form-control" name="identifier" required autofocus>
                        </div>
                        <button type="submit" class="btn btn-primary w-100">Notify Administrator</button>
                    </form>
                    <p class="text-center mt-3 mb-0"><a href="/auth/login">Back to Login</a></p>`}
        </div>
    </div>
</div>`;
    return publicShell({ pageTitle: 'Forgot Password', companyName, bodyHtml: body });
}
