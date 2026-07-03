// Assembles a full authenticated page: fetches the small amount of
// per-request data every page needs (unread notification count, recent
// notifications, pending flash message), then renders the shared shell.
// Centralized here so every route handler doesn't repeat this wiring.

import { shell } from './templates/layout.js';
import { getUnreadNotificationCount, getRecentNotifications } from './notifications.js';
import { getSetting } from './settings.js';
import { flashGet, flashClearCookie } from './flash.js';
import { htmlResponse } from './response.js';

/**
 * `auth` is the object returned by requireLogin/requireRole ({ user, setCookie }).
 * Returns a ready-to-send Response.
 */
export async function renderShellForRequest({ request, auth, pageTitle, bodyHtml, path, extraScripts, extraCookies = [] }) {
    const { user, setCookie } = auth;
    const [
        companyName, portalTitle, siteLogo, favicon, bannerImage,
        sidebarColor, headerColor, primaryColor, secondaryColor, fontFamily, fontSize, footerText, copyrightText,
        unreadCount, notifications, flashMessages,
    ] = await Promise.all([
        getSetting('company_name', 'Staff Ferry Transfer Portal'),
        getSetting('portal_title', ''),
        getSetting('site_logo', ''),
        getSetting('favicon', ''),
        getSetting('banner_image', ''),
        getSetting('theme_sidebar_color', ''),
        getSetting('theme_header_color', ''),
        getSetting('theme_primary_color', ''),
        getSetting('theme_secondary_color', ''),
        getSetting('font_family', ''),
        getSetting('font_size', ''),
        getSetting('footer_text', ''),
        getSetting('copyright_text', ''),
        getUnreadNotificationCount(user.user_id),
        getRecentNotifications(user.user_id, 8),
        Promise.resolve(flashGet(request)),
    ]);

    const page = shell({
        user,
        pageTitle,
        companyName,
        portalTitle,
        siteLogo,
        favicon,
        bannerImage,
        sidebarColor,
        headerColor,
        primaryColor,
        secondaryColor,
        fontFamily,
        fontSize,
        footerText,
        copyrightText,
        flashMessages,
        csrfToken: user.csrf,
        unreadCount,
        notifications,
        currentPath: path,
        bodyHtml,
        extraScripts,
    });

    const cookies = [setCookie, flashMessages.length ? flashClearCookie() : null, ...extraCookies].filter(Boolean);
    return htmlResponse(page.toString(), { cookies });
}
