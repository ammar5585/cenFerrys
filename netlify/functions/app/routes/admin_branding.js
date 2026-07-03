// Website Branding Management: logos, favicon, login background, banner,
// and portal title/name - all stored as rows in the existing flat
// settings key-value table (see settings.js), uploaded via the same
// Supabase Storage pattern as profile pictures (see uploads.js). No new
// database table. "Restore Default" just clears a setting key back to
// empty, since getSetting()'s fallback parameter already produces
// today's built-in look once a key is unset - there is no bundled
// default image asset to restore from.

import { requireRole } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getSetting, setSetting, resetSettingsCache } from '../settings.js';
import { uploadSiteLogo, uploadLoginLogo, uploadFavicon, uploadLoginBackground, uploadBannerImage } from '../uploads.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { ROLE_ADMIN } from '../session.js';

const TEXT_FIELDS = [
    { key: 'company_name', label: 'Portal Name', help: 'Shown on the login page, dashboard, and sidebar.' },
    { key: 'portal_title', label: 'Portal Title', help: 'Shown in the browser tab title. Falls back to Portal Name if left blank.' },
];

const IMAGE_FIELDS = [
    { key: 'site_logo', label: 'Site Logo', help: 'Shown in the sidebar header and on printed reports/manifests.', accept: '.jpg,.jpeg,.png,.svg,.webp', uploadFn: uploadSiteLogo },
    { key: 'login_logo', label: 'Login Page Logo', help: 'Shown above the login form.', accept: '.jpg,.jpeg,.png,.svg,.webp', uploadFn: uploadLoginLogo },
    { key: 'favicon', label: 'Favicon', help: 'Browser tab icon. PNG or SVG only.', accept: '.png,.svg', uploadFn: uploadFavicon },
    { key: 'login_background', label: 'Login Background Image', help: 'Background image behind the login card.', accept: '.jpg,.jpeg,.png,.webp', uploadFn: uploadLoginBackground },
    { key: 'banner_image', label: 'Banner Image', help: 'Shown below the top bar on every page after login.', accept: '.jpg,.jpeg,.png,.webp', uploadFn: uploadBannerImage },
];

async function brandingPageBody({ errors, csrfToken }) {
    const textValues = {};
    for (const f of TEXT_FIELDS) textValues[f.key] = await getSetting(f.key, '');

    const imageValues = {};
    for (const f of IMAGE_FIELDS) imageValues[f.key] = await getSetting(f.key, '');

    const textFieldsHtml = TEXT_FIELDS.map(
        (f) => html`
<div class="col-md-6">
    <label class="form-label">${f.label}</label>
    <input type="text" name="${f.key}" class="form-control" value="${textValues[f.key]}">
    <div class="form-text">${f.help}</div>
</div>`
    )
        .map((r) => r.toString())
        .join('');

    const imageFieldsHtml = IMAGE_FIELDS.map((f) => {
        const currentUrl = imageValues[f.key];
        return html`
<div class="col-md-6">
    <div class="card h-100">
        <div class="card-body">
            <label class="form-label fw-semibold">${f.label}</label>
            <div class="form-text mb-2">${f.help}</div>
            <img id="preview_${f.key}" src="${currentUrl}" alt="" class="mb-2 d-block border rounded" style="max-height:70px;max-width:100%;${currentUrl ? '' : 'display:none;'}">
            <input type="file" name="${f.key}" class="form-control form-control-sm" accept="${f.accept}" onchange="ferryPreviewBrandingImage(this, 'preview_${f.key}')">
        </div>
        <div class="card-footer bg-white border-top-0 pt-0">
            <button type="submit" form="restoreForm_${f.key}" class="btn btn-sm btn-outline-secondary" ${currentUrl ? '' : 'disabled'}>Restore Default</button>
        </div>
    </div>
</div>`;
    })
        .map((r) => r.toString())
        .join('');

    const restoreFormsHtml = IMAGE_FIELDS.map(
        (f) => `<form method="post" id="restoreForm_${f.key}" data-confirm="Restore ${h(f.label)} to its default (no custom image)?" style="display:none">${csrfField(csrfToken)}<input type="hidden" name="action" value="restore"><input type="hidden" name="key" value="${f.key}"></form>`
    ).join('');

    return html`
<h5 class="mb-3"><i class="bi bi-palette"></i> Website Branding</h5>
${errors.length ? html`<div class="alert alert-danger">${raw(errors.map((e) => `${e}<br>`).join(''))}</div>` : ''}
<form method="post" enctype="multipart/form-data">
    ${raw(csrfField(csrfToken))}
    <input type="hidden" name="action" value="save">
    <div class="card shadow-sm mb-3"><div class="card-header bg-white">Portal Text</div><div class="card-body"><div class="row g-3">${raw(textFieldsHtml)}</div></div></div>
    <div class="row g-3 mb-3">${raw(imageFieldsHtml)}</div>
    <button type="submit" class="btn btn-primary">Save Branding</button>
</form>
${raw(restoreFormsHtml)}
<script>
function ferryPreviewBrandingImage(input, previewId) {
    if (input.files && input.files[0]) {
        var img = document.getElementById(previewId);
        img.src = URL.createObjectURL(input.files[0]);
        img.style.display = 'block';
    }
}
</script>`;
}

export function registerAdminBrandingRoutes(router) {
    router.get('/admin/branding', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const body = await brandingPageBody({ errors: [], csrfToken: auth.user.csrf });
        return renderShellForRequest({ request, auth, pageTitle: 'Website Branding', path: '/admin/branding', bodyHtml: body });
    });

    router.post('/admin/branding', async (request) => {
        const auth = await requireRole(request, [ROLE_ADMIN]);
        if (auth.response) return auth.response;
        const { user } = auth;

        const form = await request.formData();
        if (!verifyCsrf(user.csrf, form.get('csrf_token'))) return notFound();

        const action = form.get('action') || 'save';

        if (action === 'restore') {
            const key = form.get('key');
            if (IMAGE_FIELDS.some((f) => f.key === key)) {
                await setSetting(key, '');
                resetSettingsCache();
                await logActivity(user.user_id, 'Restored default branding', `field=${key}`, clientIp(request));
            }
            return redirectTo('/admin/branding', { cookies: [auth.setCookie, flashSetCookie('success', 'Restored to default.')].filter(Boolean) });
        }

        const errors = [];
        const changedFields = [];

        for (const f of TEXT_FIELDS) {
            const newVal = (form.get(f.key) || '').toString().trim();
            const oldVal = await getSetting(f.key, '');
            if (newVal !== oldVal) changedFields.push(f.label);
            await setSetting(f.key, newVal);
        }

        for (const f of IMAGE_FIELDS) {
            const file = form.get(f.key);
            if (file && typeof file.arrayBuffer === 'function' && file.size > 0) {
                try {
                    const url = await f.uploadFn(file);
                    await setSetting(f.key, url);
                    changedFields.push(f.label);
                } catch (err) {
                    errors.push(`${f.label}: ${err.message}`);
                }
            }
        }

        resetSettingsCache();

        if (errors.length) {
            const body = await brandingPageBody({ errors, csrfToken: user.csrf });
            return renderShellForRequest({ request, auth, pageTitle: 'Website Branding', path: '/admin/branding', bodyHtml: body });
        }

        if (changedFields.length) {
            await logActivity(user.user_id, 'Updated branding settings', changedFields.join(', '), clientIp(request));
        }
        return redirectTo('/admin/branding', {
            cookies: [auth.setCookie, flashSetCookie('success', changedFields.length ? 'Branding updated.' : 'No changes made.')].filter(Boolean),
        });
    });
}
