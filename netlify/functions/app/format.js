// Formatting helpers - port of the format_date/format_datetime/
// format_time/time_ago/status_badge_class functions in
// includes/functions.php. No date library dependency; PHP's date()
// format codes are replicated manually to match the original output
// exactly (e.g. "02 Jul 2026", "02 Jul 2026, 03:45 PM").

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) {
    return String(n).padStart(2, '0');
}

/** Time-of-day greeting for dashboard headers, based on the server's local hour. */
export function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
}

export function formatDate(dateValue) {
    if (!dateValue) return '';
    const d = new Date(dateValue);
    return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatDateTime(datetimeValue) {
    if (!datetimeValue) return '';
    const d = new Date(datetimeValue);
    return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
