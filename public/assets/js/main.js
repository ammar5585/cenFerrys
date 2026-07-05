/* =====================================================================
   Staff Ferry Transfer Portal - Shared front-end behaviour
   Vanilla JS only (no frameworks). Loaded on every protected page.
   Ported verbatim from the original PHP app's assets/js/main.js, with
   one change: the notifications endpoint has no .php extension here.
   ===================================================================== */

document.addEventListener('DOMContentLoaded', function () {
    initSidebarToggle();
    initThemeToggle();
    initMarkAllRead();
    initConfirmDialogs();
});

/* ---------------- Sidebar (mobile) ---------------- */
function initSidebarToggle() {
    var btn = document.getElementById('sidebarToggle');
    var sidebar = document.getElementById('sidebar');
    if (!btn || !sidebar) return;
    btn.addEventListener('click', function () {
        sidebar.classList.toggle('show');
    });
    document.addEventListener('click', function (e) {
        if (window.innerWidth < 992 && sidebar.classList.contains('show') &&
            !sidebar.contains(e.target) && e.target !== btn) {
            sidebar.classList.remove('show');
        }
    });
}

/* ---------------- Dark mode toggle ---------------- */
function initThemeToggle() {
    var btn = document.getElementById('themeToggle');
    var icon = document.getElementById('themeIcon');
    var current = localStorage.getItem('ferry_theme') || 'light';
    updateThemeIcon(icon, current);

    if (!btn) return;
    btn.addEventListener('click', function () {
        var theme = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-bs-theme', theme);
        localStorage.setItem('ferry_theme', theme);
        updateThemeIcon(icon, theme);
    });
}

function updateThemeIcon(icon, theme) {
    if (!icon) return;
    icon.className = theme === 'dark' ? 'bi bi-sun' : 'bi bi-moon-stars';
}

/* ---------------- Toast notifications ---------------- */
function showToast(type, message) {
    var container = document.getElementById('toastContainer');
    if (!container) return;

    var colorMap = { success: 'text-bg-success', error: 'text-bg-danger', danger: 'text-bg-danger', warning: 'text-bg-warning', info: 'text-bg-info' };
    var cls = colorMap[type] || 'text-bg-primary';

    var el = document.createElement('div');
    el.className = 'toast align-items-center ' + cls + ' border-0';
    el.setAttribute('role', 'alert');
    el.innerHTML =
        '<div class="d-flex">' +
        '<div class="toast-body"></div>' +
        '<button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>' +
        '</div>';
    el.querySelector('.toast-body').textContent = message; // textContent avoids XSS
    container.appendChild(el);

    var toast = new bootstrap.Toast(el, { delay: 4000 });
    toast.show();
    el.addEventListener('hidden.bs.toast', function () { el.remove(); });
}

/* ---------------- Generic AJAX POST helper (JSON) ---------------- */
function postJSON(url, data) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(data).toString()
    }).then(function (res) { return res.json(); });
}

/* ---------------- Notifications: mark all as read ---------------- */
function initMarkAllRead() {
    document.addEventListener('click', function (e) {
        var target = e.target.closest('.mark-all-read');
        if (!target) return;
        e.preventDefault();
        postJSON((window.BASE_URL || '/') + 'ajax/mark_notifications_read', { csrf_token: window.CSRF_TOKEN })
            .then(function (res) {
                if (res.success) { location.reload(); }
            });
    });
}

/* ---------------- Confirmation dialogs for destructive actions ---------------- */
function initConfirmDialogs() {
    document.addEventListener('submit', function (e) {
        var form = e.target;
        if (form.hasAttribute('data-confirm')) {
            var msg = form.getAttribute('data-confirm') || 'Are you sure?';
            if (!confirm(msg)) {
                e.preventDefault();
            }
        }
    });
    document.addEventListener('click', function (e) {
        var link = e.target.closest('[data-confirm-link]');
        if (!link) return;
        var msg = link.getAttribute('data-confirm-link') || 'Are you sure?';
        if (!confirm(msg)) {
            e.preventDefault();
        }
    });
}

/* ---------------- Simple client-side table search filter ---------------- */
function initTableSearch(inputId, tableId) {
    var input = document.getElementById(inputId);
    var table = document.getElementById(tableId);
    if (!input || !table) return;
    input.addEventListener('keyup', function () {
        var term = input.value.toLowerCase();
        table.querySelectorAll('tbody tr').forEach(function (row) {
            row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
        });
    });
}
