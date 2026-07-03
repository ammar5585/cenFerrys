// Website Branding Management: logos, favicon, login background, banner,
// theme colors, typography, footer text, and login-page copy - all
// stored as rows in the existing flat settings key-value table (see
// settings.js), uploaded via the same Supabase Storage pattern as
// profile pictures (see uploads.js). No new database table.
//
// Each image field has exactly two actions: choose a file (labeled
// Upload/Replace - same underlying action either way) and "Remove /
// Restore Default" (clears the setting key - there's no separate
// bundled default asset in this app, so clearing IS the restore,
// exactly as getSetting()'s fallback parameter already implies).
// Oversized/incorrectly-formatted images are resized/re-encoded
// client-side (Canvas) before upload - see the inline script - so the
// server-side handleUpload() in uploads.js never changes and never sees
// an oversized original.

import { requireRole } from '../guards.js';
import { renderShellForRequest } from '../shellHelper.js';
import { html, raw, h } from '../templates/html.js';
import { csrfField, verifyCsrf } from '../csrf.js';
import { getSetting, setSetting, resetSettingsCache } from '../settings.js';
import { uploadSiteLogo, uploadLoginLogo, uploadFavicon, uploadLoginBackground, uploadBannerImage } from '../uploads.js';
import { FONT_FAMILIES, FONT_SIZES, HEX_COLOR_PATTERN } from '../branding.js';
import { logActivity, clientIp } from '../activity.js';
import { redirectTo, notFound } from '../response.js';
import { flashSetCookie } from '../flash.js';
import { ROLE_ADMIN } from '../session.js';

const TEXT_FIELDS = [
    { key: 'company_name', label: 'Portal Name', help: 'Shown on the login page, dashboard, and sidebar.' },
    { key: 'portal_title', label: 'Portal Title', help: 'Shown in the browser tab title. Falls back to Portal Name if left blank.' },
];

const IMAGE_FIELDS = [
    { key: 'site_logo', label: 'Site Logo', help: 'Shown in the sidebar header and on printed reports/manifests.', accept: '.jpg,.jpeg,.png,.svg,.webp', uploadFn: uploadSiteLogo, targetFormat: 'jpeg' },
    { key: 'login_logo', label: 'Login Logo', help: 'Shown above the login form.', accept: '.jpg,.jpeg,.png,.svg,.webp', uploadFn: uploadLoginLogo, targetFormat: 'jpeg' },
    { key: 'favicon', label: 'Favicon', help: 'Browser tab icon. PNG or SVG only.', accept: '.png,.svg', uploadFn: uploadFavicon, targetFormat: 'png' },
    { key: 'login_background', label: 'Login Background', help: 'Background image behind the login card.', accept: '.jpg,.jpeg,.png,.webp', uploadFn: uploadLoginBackground, targetFormat: 'jpeg' },
    { key: 'banner_image', label: 'Banner Image', help: 'Shown below the top bar on every page after login.', accept: '.jpg,.jpeg,.png,.webp', uploadFn: uploadBannerImage, targetFormat: 'jpeg' },
];

const COLOR_FIELDS = [
    { key: 'theme_sidebar_color', label: 'Sidebar Color', fallback: '#1b2434' },
    { key: 'theme_header_color', label: 'Header Color', fallback: '#ffffff' },
    { key: 'theme_primary_color', label: 'Primary Color', fallback: '#0d6efd' },
    { key: 'theme_secondary_color', label: 'Secondary Color', fallback: '#6c757d' },
];

const FOOTER_FIELDS = [
    { key: 'footer_text', label: 'Footer Text', help: 'Optional line of text shown in the footer on every page.' },
    { key: 'copyright_text', label: 'Copyright Text', help: 'Falls back to "© <year> <Portal Name>" if left blank.' },
];

const LOGIN_EXTRA_FIELDS = [
    { key: 'login_welcome_message', label: 'Welcome Message', help: 'Falls back to Portal Name if left blank.' },
    { key: 'login_description', label: 'Portal Description', help: 'Falls back to "Staff Ferry Transfer Portal" if left blank.' },
];

const ALL_TEXT_FIELDS = [...TEXT_FIELDS, ...FOOTER_FIELDS, ...LOGIN_EXTRA_FIELDS];
const ALL_RESTORABLE_KEYS = [
    ...IMAGE_FIELDS.map((f) => f.key),
    ...COLOR_FIELDS.map((f) => f.key),
    'font_family', 'font_size',
    ...ALL_TEXT_FIELDS.map((f) => f.key),
];

function textFieldCard(title, fields, values) {
    const fieldsHtml = fields
        .map(
            (f) => html`
<div class="col-12">
    <label class="form-label">${f.label}</label>
    <input type="text" name="${f.key}" class="form-control" value="${values[f.key]}">
    <div class="form-text">${f.help}</div>
</div>`
        )
        .map((r) => r.toString())
        .join('');
    return html`
<div class="col-12 col-md-6">
    <div class="card h-100">
        <div class="card-header bg-white">${title}</div>
        <div class="card-body"><div class="row g-3">${raw(fieldsHtml)}</div></div>
    </div>
</div>`;
}

function imageFieldCard(f, currentUrl) {
    return html`
<div class="col-12 col-md-6">
    <div class="card h-100">
        <div class="card-body">
            <label class="form-label fw-semibold">${f.label}</label>
            <div class="form-text mb-2">${f.help}</div>
            <img id="preview_${f.key}" src="${currentUrl}" alt="Current ${f.label}" class="mb-2 d-block border rounded" style="max-height:80px;max-width:100%;${currentUrl ? '' : 'display:none;'}">
            <input type="file" name="${f.key}" class="form-control form-control-sm mb-2" accept="${f.accept}" onchange="ferryHandleBrandingFile(this, 'preview_${f.key}', '${f.targetFormat}')">
            <div class="form-text text-danger" id="error_${f.key}"></div>
        </div>
        <div class="card-footer bg-white border-top-0 pt-0">
            <button type="submit" form="restoreForm_${f.key}" class="btn btn-sm btn-outline-secondary" ${currentUrl ? '' : 'disabled'}><i class="bi bi-arrow-counterclockwise"></i> Remove / Restore Default</button>
        </div>
    </div>
</div>`;
}

function themeSettingsCard(values) {
    const pickersHtml = COLOR_FIELDS.map(
        (f) => html`
<div class="col-6">
    <label class="form-label small">${f.label}</label>
    <div class="input-group input-group-sm">
        <input type="color" class="form-control form-control-color" id="picker_${f.key}" value="${values[f.key] || f.fallback}" title="${f.label}">
        <input type="text" class="form-control" id="text_${f.key}" name="${f.key}" value="${values[f.key] || f.fallback}" maxlength="7" pattern="^#[0-9a-fA-F]{6}$">
    </div>
</div>`
    )
        .map((r) => r.toString())
        .join('');

    return html`
<div class="col-12 col-md-6">
    <div class="card h-100">
        <div class="card-header bg-white">Theme Settings</div>
        <div class="card-body"><div class="row g-3">${raw(pickersHtml)}</div></div>
    </div>
</div>`;
}

function typographyCard(values) {
    const familyOptions = Object.entries(FONT_FAMILIES)
        .map(([key, f]) => `<option value="${key}" ${values.font_family === key ? 'selected' : ''}>${h(f.label)}</option>`)
        .join('');
    const sizeOptions = Object.entries(FONT_SIZES)
        .map(([key, s]) => `<option value="${key}" ${values.font_size === key ? 'selected' : ''}>${h(s.label)}</option>`)
        .join('');

    return html`
<div class="col-12 col-md-6">
    <div class="card h-100">
        <div class="card-header bg-white">Typography</div>
        <div class="card-body"><div class="row g-3">
            <div class="col-12">
                <label class="form-label">Font Family</label>
                <select name="font_family" class="form-select">${raw(familyOptions)}</select>
            </div>
            <div class="col-12">
                <label class="form-label">Font Size</label>
                <select name="font_size" class="form-select">${raw(sizeOptions)}</select>
            </div>
        </div></div>
    </div>
</div>`;
}

async function brandingPageBody({ errors, csrfToken }) {
    const values = {};
    for (const f of ALL_TEXT_FIELDS) values[f.key] = await getSetting(f.key, '');
    for (const f of IMAGE_FIELDS) values[f.key] = await getSetting(f.key, '');
    for (const f of COLOR_FIELDS) values[f.key] = await getSetting(f.key, '') || f.fallback;
    values.font_family = (await getSetting('font_family', '')) || 'default';
    values.font_size = (await getSetting('font_size', '')) || 'medium';

    const imageCardsHtml = IMAGE_FIELDS.map((f) => imageFieldCard(f, values[f.key]))
        .map((r) => r.toString())
        .join('');

    const restoreFormsHtml = IMAGE_FIELDS.map(
        (f) => `<form method="post" id="restoreForm_${f.key}" data-confirm="Remove ${h(f.label)} and restore the default look?" style="display:none">${csrfField(csrfToken)}<input type="hidden" name="action" value="restore"><input type="hidden" name="key" value="${f.key}"></form>`
    ).join('');

    const cardsHtml = [
        textFieldCard('Portal Text', TEXT_FIELDS, values).toString(),
        imageCardsHtml,
        themeSettingsCard(values).toString(),
        typographyCard(values).toString(),
        textFieldCard('Footer Settings', FOOTER_FIELDS, values).toString(),
        textFieldCard('Login Page Extras', LOGIN_EXTRA_FIELDS, values).toString(),
    ].join('');

    return html`
<h5 class="mb-3"><i class="bi bi-palette"></i> Website Branding</h5>
${errors.length ? html`<div class="alert alert-danger">${raw(errors.map((e) => `${e}<br>`).join(''))}</div>` : ''}
<form method="post" enctype="multipart/form-data" id="brandingForm">
    ${raw(csrfField(csrfToken))}
    <input type="hidden" name="action" value="save">
    <div class="row g-3 mb-3">${raw(cardsHtml)}</div>
    <div class="sticky-save-bar">
        <button type="submit" class="btn btn-primary" id="brandingSaveBtn" disabled><i class="bi bi-check-lg"></i> <span class="btn-label">Save Changes</span></button>
        <button type="button" class="btn btn-outline-secondary" onclick="location.reload()">Cancel</button>
        <button type="submit" form="restoreAllForm" class="btn btn-outline-danger ms-auto"><i class="bi bi-arrow-counterclockwise"></i> Restore All Defaults</button>
    </div>
</form>
<form method="post" id="restoreAllForm" data-confirm="Restore ALL branding settings (logos, colors, fonts, footer, login text) to their defaults? This cannot be undone." style="display:none">
    ${raw(csrfField(csrfToken))}
    <input type="hidden" name="action" value="restore_all">
</form>
${raw(restoreFormsHtml)}
<script>
(function () {
    var form = document.getElementById('brandingForm');
    var saveBtn = document.getElementById('brandingSaveBtn');
    if (!form || !saveBtn) return;
    function markDirty() { saveBtn.disabled = false; }
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
    form.addEventListener('submit', function () {
        saveBtn.disabled = true;
        saveBtn.querySelector('.btn-label').textContent = 'Saving...';
        saveBtn.insertAdjacentHTML('afterbegin', '<span class="spinner-border spinner-border-sm me-1" role="status"></span>');
    });

    // Two-way sync between each color <input type=color> and its text fallback.
    document.querySelectorAll('input[type=color]').forEach(function (picker) {
        var text = document.getElementById(picker.id.replace('picker_', 'text_'));
        if (!text) return;
        picker.addEventListener('input', function () { text.value = picker.value; });
        text.addEventListener('input', function () {
            if (/^#[0-9a-fA-F]{6}$/.test(text.value)) picker.value = text.value;
        });
    });
})();

function ferryShowBrandingPreview(previewId, file) {
    var img = document.getElementById(previewId);
    if (!img) return;
    img.src = URL.createObjectURL(file);
    img.style.display = 'block';
}

/**
 * Resizes/re-encodes an uploaded image client-side before it is ever sent
 * to the server: caps the longest edge at 1600px and re-encodes as JPEG
 * (or PNG for the favicon field, which only accepts png/svg) so the
 * server's fixed extension allowlist is always satisfied. SVGs are passed
 * through unchanged (rasterizing a vector image would defeat its point).
 * If Canvas processing fails for any reason, falls back to uploading the
 * original file unmodified - the server independently re-validates
 * everything regardless.
 */
async function ferryHandleBrandingFile(input, previewId, targetFormat) {
    var file = input.files && input.files[0];
    var errorEl = document.getElementById(input.name ? 'error_' + input.name : null);
    if (errorEl) errorEl.textContent = '';
    if (!file) return;

    var isSvg = file.type === 'image/svg+xml' || /\\.svg$/i.test(file.name);
    if (isSvg) {
        ferryShowBrandingPreview(previewId, file);
        return;
    }

    try {
        var bitmap = await createImageBitmap(file);
        var maxDim = 1600;
        var scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        var ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

        var mimeType = targetFormat === 'png' ? 'image/png' : 'image/jpeg';
        var ext = targetFormat === 'png' ? 'png' : 'jpg';

        canvas.toBlob(function (blob) {
            if (!blob) { ferryShowBrandingPreview(previewId, file); return; }
            var newFile = new File([blob], 'upload.' + ext, { type: mimeType });
            var dt = new DataTransfer();
            dt.items.add(newFile);
            input.files = dt.files;
            ferryShowBrandingPreview(previewId, newFile);
        }, mimeType, 0.85);
    } catch (err) {
        ferryShowBrandingPreview(previewId, file);
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

        if (action === 'restore_all') {
            for (const key of ALL_RESTORABLE_KEYS) {
                await setSetting(key, '');
            }
            resetSettingsCache();
            await logActivity(user.user_id, 'Restored ALL default branding settings', null, clientIp(request));
            return redirectTo('/admin/branding', { cookies: [auth.setCookie, flashSetCookie('success', 'All branding settings restored to defaults.')].filter(Boolean) });
        }

        const errors = [];
        const changedFields = [];

        for (const f of ALL_TEXT_FIELDS) {
            const newVal = (form.get(f.key) || '').toString().trim();
            const oldVal = await getSetting(f.key, '');
            if (newVal !== oldVal) changedFields.push(f.label);
            await setSetting(f.key, newVal);
        }

        for (const f of COLOR_FIELDS) {
            const submitted = (form.get(f.key) || '').toString().trim();
            if (submitted && !HEX_COLOR_PATTERN.test(submitted)) {
                errors.push(`${f.label}: must be a valid hex color like #0d6efd.`);
                continue;
            }
            const newVal = submitted || '';
            const oldVal = await getSetting(f.key, '');
            if (newVal !== oldVal) changedFields.push(f.label);
            await setSetting(f.key, newVal);
        }

        const fontFamilySubmitted = form.get('font_family');
        if (fontFamilySubmitted && Object.prototype.hasOwnProperty.call(FONT_FAMILIES, fontFamilySubmitted)) {
            const oldVal = await getSetting('font_family', '');
            if (fontFamilySubmitted !== oldVal) changedFields.push('Font Family');
            await setSetting('font_family', fontFamilySubmitted);
        }
        const fontSizeSubmitted = form.get('font_size');
        if (fontSizeSubmitted && Object.prototype.hasOwnProperty.call(FONT_SIZES, fontSizeSubmitted)) {
            const oldVal = await getSetting('font_size', '');
            if (fontSizeSubmitted !== oldVal) changedFields.push('Font Size');
            await setSetting('font_size', fontSizeSubmitted);
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
