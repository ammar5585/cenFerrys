// Port of includes/navbar.php - top bar: sidebar toggle, dark mode,
// notifications dropdown, user menu. Takes pre-fetched data rather than
// querying the DB itself, keeping templates as pure rendering functions.

import { html, raw } from '../html.js';
import { timeAgo } from '../../format.js';

export function renderNavbar({ user, pageTitle, unreadCount, notifications }) {
    const notifItems = notifications.length
        ? notifications
              .map(
                  (n) => html`<li>
                            <span class="dropdown-item-text notif-item ${n.is_read ? '' : 'unread'}">
                                ${n.message}
                                <small class="d-block text-muted">${timeAgo(n.created_at)}</small>
                            </span>
                        </li>`
              )
              .map((i) => i.toString())
              .join('')
        : `<li><span class="dropdown-item-text text-muted">No notifications yet.</span></li>`;

    return html`
<header class="topbar">
    <button class="btn btn-icon d-lg-none" id="sidebarToggle" type="button" aria-label="Toggle menu">
        <i class="bi bi-list"></i>
    </button>

    <div class="topbar-title d-none d-md-block">
        ${pageTitle || 'Dashboard'}
    </div>

    <div class="topbar-actions">
        <button class="btn btn-icon" id="themeToggle" type="button" title="Toggle dark mode" aria-label="Toggle dark mode">
            <i class="bi bi-moon-stars" id="themeIcon"></i>
        </button>

        <div class="dropdown">
            <button class="btn btn-icon position-relative" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Notifications">
                <i class="bi bi-bell"></i>
                ${unreadCount > 0 ? raw(`<span class="badge rounded-pill bg-danger notif-badge">${unreadCount}</span>`) : ''}
            </button>
            <ul class="dropdown-menu dropdown-menu-end notif-dropdown">
                <li><h6 class="dropdown-header">Notifications</h6></li>
                ${raw(notifItems)}
                <li><hr class="dropdown-divider"></li>
                <li><a class="dropdown-item text-center mark-all-read" href="#" data-action="mark-all-read">Mark all as read</a></li>
            </ul>
        </div>

        <div class="dropdown">
            <button class="btn btn-icon btn-user-menu d-flex align-items-center gap-2" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="User menu for ${user.full_name}">
                <span class="avatar-circle">${user.full_name.charAt(0).toUpperCase()}</span>
                <span class="topbar-user-info d-none d-md-flex">
                    <span class="user-name">${user.full_name}</span>
                    <span class="user-role">${user.role_name}</span>
                </span>
            </button>
            <ul class="dropdown-menu dropdown-menu-end">
                <li><span class="dropdown-item-text text-muted small">${user.role_name}</span></li>
                <li><hr class="dropdown-divider"></li>
                <li><a class="dropdown-item" href="/auth/change_password"><i class="bi bi-key"></i> Change Password</a></li>
                <li><a class="dropdown-item" href="/auth/logout"><i class="bi bi-box-arrow-right"></i> Logout</a></li>
            </ul>
        </div>
    </div>
</header>`;
}
