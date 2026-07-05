// Port of includes/header.php + footer.php combined into one shell()
// function (there's no PHP-style "include this file mid-response"
// mechanism here, so the whole page is assembled in one call).

import { html, raw } from './html.js';
import { renderNavbar } from './partials/navbar.js';
import { renderSidebar } from './partials/sidebar.js';
import { resolveFontFamily, resolveFontSize, safeHexColor } from '../branding.js';

// Zero-asset default favicon (nothing ships on disk today) - a simple
// inline SVG data URI, computed once at module load via encodeURIComponent
// rather than hand-escaped, to avoid a subtly-broken hand-encoded string.
const DEFAULT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#0d6efd"/><text x="50" y="70" font-size="60" text-anchor="middle">🌊</text></svg>`;
const DEFAULT_FAVICON = `data:image/svg+xml,${encodeURIComponent(DEFAULT_FAVICON_SVG)}`;

const DEFAULT_THEME = {
    sidebarColor: '#1b2434',
    headerColor: '#ffffff',
    primaryColor: '#0d6efd',
    secondaryColor: '#6c757d',
};

/**
 * Builds the per-request <style> override block + optional Google Fonts
 * <link>, both driven entirely by admin-configured settings. Color values
 * are re-validated here (defense in depth - they're already validated
 * before being stored) so this can never emit anything but a #rrggbb hex
 * literal, even if a bad value somehow reached the settings table another
 * way. Bootstrap 5.3's .btn-primary/.btn-secondary hardcode their own
 * scoped CSS vars rather than reading --bs-primary, so those must be
 * overridden explicitly - reassigning --bs-primary alone would not
 * actually recolor any button.
 */
function themeAssets({ sidebarColor, headerColor, primaryColor, secondaryColor, fontFamily, fontSize }) {
    const sidebar = safeHexColor(sidebarColor, DEFAULT_THEME.sidebarColor);
    const header = safeHexColor(headerColor, DEFAULT_THEME.headerColor);
    const primary = safeHexColor(primaryColor, DEFAULT_THEME.primaryColor);
    const secondary = safeHexColor(secondaryColor, DEFAULT_THEME.secondaryColor);
    const font = resolveFontFamily(fontFamily);
    const size = resolveFontSize(fontSize);

    const styleBlock = `
:root {
    --theme-sidebar-color: ${sidebar};
    --theme-header-color: ${header};
    --theme-primary-color: ${primary};
    --theme-secondary-color: ${secondary};
    --theme-font-size: ${size.px};
}
body { font-family: ${font.css}; }
.btn-primary {
    --bs-btn-bg: ${primary};
    --bs-btn-border-color: ${primary};
    --bs-btn-hover-bg: color-mix(in srgb, ${primary} 85%, black);
    --bs-btn-hover-border-color: color-mix(in srgb, ${primary} 80%, black);
    --bs-btn-active-bg: color-mix(in srgb, ${primary} 75%, black);
    --bs-btn-active-border-color: color-mix(in srgb, ${primary} 70%, black);
    --bs-btn-disabled-bg: ${primary};
    --bs-btn-disabled-border-color: ${primary};
}
.btn-secondary {
    --bs-btn-bg: ${secondary};
    --bs-btn-border-color: ${secondary};
    --bs-btn-hover-bg: color-mix(in srgb, ${secondary} 85%, black);
    --bs-btn-hover-border-color: color-mix(in srgb, ${secondary} 80%, black);
    --bs-btn-active-bg: color-mix(in srgb, ${secondary} 75%, black);
    --bs-btn-active-border-color: color-mix(in srgb, ${secondary} 70%, black);
    --bs-btn-disabled-bg: ${secondary};
    --bs-btn-disabled-border-color: ${secondary};
}`;

    const fontLink = font.googleFont
        ? `<link href="https://fonts.googleapis.com/css2?family=${font.googleFont}&display=swap" rel="stylesheet">`
        : '';

    return { styleBlock, fontLink };
}

function footerHtml({ companyName, footerText, copyrightText }) {
    if (!footerText && !copyrightText) return '';
    const year = new Date().getFullYear();
    return html`
<footer class="portal-footer">
    ${footerText ? html`<p>${footerText}</p>` : ''}
    <p>${copyrightText || `© ${year} ${companyName}`}</p>
</footer>`;
}

/**
 * Renders a full authenticated page.
 * `bodyHtml` is the page's <main> content (a SafeString from html``).
 * `extraScripts` (optional) is raw JS appended after main.js loads,
 * for page-specific behaviour (e.g. staff/book.php's live seat widget).
 */
export function shell({
    user,
    pageTitle,
    companyName,
    portalTitle = '',
    siteLogo = '',
    favicon = '',
    bannerImage = '',
    sidebarColor = '',
    headerColor = '',
    primaryColor = '',
    secondaryColor = '',
    fontFamily = '',
    fontSize = '',
    footerText = '',
    copyrightText = '',
    flashMessages = [],
    csrfToken,
    unreadCount = 0,
    notifications = [],
    currentPath,
    bodyHtml,
    extraScripts = '',
}) {
    const navbarHtml = renderNavbar({ user, pageTitle, unreadCount, notifications });
    const sidebarHtml = renderSidebar(user.role_name, currentPath, user.is_dept_approver, companyName, siteLogo);
    const { styleBlock, fontLink } = themeAssets({ sidebarColor, headerColor, primaryColor, secondaryColor, fontFamily, fontSize });

    const flashScript = flashMessages
        .map((m) => `showToast(${JSON.stringify(m.type)}, ${JSON.stringify(m.message)});`)
        .join('\n');

    return html`<!DOCTYPE html>
<html lang="en" data-bs-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pageTitle ? pageTitle + ' - ' : ''}${portalTitle || companyName}</title>
<link rel="icon" href="${favicon || DEFAULT_FAVICON}">

<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css">
<link href="/assets/css/style.css" rel="stylesheet">
${raw(fontLink)}
<style>${raw(styleBlock)}</style>
</head>
<body>
<script>
  (function () {
    var theme = localStorage.getItem('ferry_theme') || 'light';
    document.documentElement.setAttribute('data-bs-theme', theme);
  })();
</script>

<div class="app-wrapper">
${raw(sidebarHtml)}
${raw(navbarHtml)}
${bannerImage ? html`<div class="portal-banner"><img src="${bannerImage}" alt="${companyName} banner" loading="lazy"></div>` : ''}
<main class="main-content">
${raw(bodyHtml)}
${footerHtml({ companyName, footerText, copyrightText })}
</main>
</div>

<div class="toast-container position-fixed bottom-0 end-0 p-3" id="toastContainer" style="z-index: 1080;"></div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<script>
    window.BASE_URL = "/";
    window.CSRF_TOKEN = ${raw(JSON.stringify(csrfToken))};
</script>
<script src="/assets/js/main.js"></script>
<script>
${raw(flashScript)}
${raw(extraScripts)}
</script>
</body>
</html>`;
}

/** Standalone page shell for public pages (login, forgot-password) with no sidebar/navbar. */
export function publicShell({
    pageTitle,
    companyName,
    portalTitle = '',
    favicon = '',
    sidebarColor = '',
    headerColor = '',
    primaryColor = '',
    secondaryColor = '',
    fontFamily = '',
    fontSize = '',
    footerText = '',
    copyrightText = '',
    bodyHtml,
}) {
    const { styleBlock, fontLink } = themeAssets({ sidebarColor, headerColor, primaryColor, secondaryColor, fontFamily, fontSize });
    return html`<!DOCTYPE html>
<html lang="en" data-bs-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pageTitle ? pageTitle + ' - ' : ''}${portalTitle || companyName}</title>
<link rel="icon" href="${favicon || DEFAULT_FAVICON}">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css">
<link href="/assets/css/style.css" rel="stylesheet">
${raw(fontLink)}
<style>${raw(styleBlock)}</style>
</head>
<body>
${raw(bodyHtml)}
${footerHtml({ companyName, footerText, copyrightText })}
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>`;
}
