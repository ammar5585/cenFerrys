// Formatting helpers - port of the format_date/format_datetime/
// format_time/time_ago/status_badge_class functions in
// includes/functions.php. No date library dependency; PHP's date()
// format codes are replicated manually to match the original output
// exactly (e.g. "02 Jul 2026", "02 Jul 2026, 03:45 PM").

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Maldives Time (UTC+5, no DST) - the resort's local timezone. Server
// runtimes (Vercel's Node functions) run in UTC, so every genuine
// TIMESTAMPTZ instant (created_at, action_at, etc.) needs this fixed
// offset applied before display, or timestamps silently show 5 hours
// behind actual local time. Computed via UTC math + a fixed offset
// (not the server's local getters) so this is correct regardless of
// the runtime's own TZ setting.
const MALDIVES_OFFSET_MS = 5 * 60 * 60 * 1000;

function toMaldivesTime(value) {
    return new Date(new Date(value).getTime() + MALDIVES_OFFSET_MS);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

/** Time-of-day greeting for dashboard headers, based on the current hour in Maldives Time. */
export function greeting() {
    const hour = toMaldivesTime(new Date()).getUTCHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
}

export function formatDate(dateValue) {
    if (!dateValue) return '';
    const d = new Date(dateValue);
    return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `datetimeValue` must be a genuine UTC instant (e.g. a TIMESTAMPTZ column) - never a synthetic "date+time" string built from separate DATE/TIME columns, which was never in UTC to begin with. */
export function formatDateTime(datetimeValue) {
    if (!datetimeValue) return '';
    const d = toMaldivesTime(datetimeValue);
    return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Accepts either a plain "HH:MM:SS" TIME string or a full timestamp. 24-hour format (HH:MM), per user request. */
export function formatTime(timeValue) {
    if (!timeValue) return '';
    let hours, minutes;
    if (typeof timeValue === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(timeValue)) {
        [hours, minutes] = timeValue.split(':').map(Number);
    } else {
        const d = new Date(timeValue);
        hours = d.getHours();
        minutes = d.getMinutes();
    }
    return `${pad2(hours)}:${pad2(minutes)}`;
}

export function timeAgo(datetimeValue) {
    const diffSeconds = Math.floor((Date.now() - new Date(datetimeValue).getTime()) / 1000);
    if (diffSeconds < 60) return 'just now';
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
    return `${Math.floor(diffSeconds / 86400)}d ago`;
}

const BADGE_CLASS_MAP = {
    secondary: 'bg-secondary',
    warning: 'bg-warning text-dark',
    success: 'bg-success',
    danger: 'bg-danger',
    dark: 'bg-dark',
    info: 'bg-info text-dark',
};

export function statusBadgeClass(color) {
    return BADGE_CLASS_MAP[color] || 'bg-secondary';
}

/**
 * Ferry Schedule label for dropdowns/checkboxes. `schedule` must have
 * `service_name` and a joined `ferry_routes(route_name, direction)`.
 * service_name wins whenever it's set - it's the name managed today
 * from the Ferry Services admin page, which never even reads
 * ferry_routes. A schedule kept its legacy ferry_routes link when it
 * was migrated into a Ferry Service (0028_ferry_service_routes.sql),
 * so both can be populated at once with the ferry_routes side now
 * stale/vestigial (its own admin page was deliberately unlinked from
 * the sidebar) - showing it instead of the current service_name is
 * exactly the bug reported ("CMLM To Hulhumale" shown instead of the
 * ferry's real current name "The Atollia"). Only falls through to
 * ferry_routes for a schedule that somehow has no service_name at all.
 */
export function scheduleLabel(schedule) {
    if (schedule.service_name) return schedule.service_name;
    const routeName = schedule.ferry_routes?.route_name ?? null;
    const direction = schedule.ferry_routes?.direction ?? null;
    if (routeName && direction) {
        return routeName.trim().toLowerCase() === direction.trim().toLowerCase() ? routeName : `${routeName} - ${direction}`;
    }
    return routeName || direction || '-';
}
