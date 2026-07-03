// Formatting helpers - port of the format_date/format_datetime/
// format_time/time_ago/status_badge_class functions in
// includes/functions.php. No date library dependency; PHP's date()
// format codes are replicated manually to match the original output
// exactly (e.g. "02 Jul 2026", "02 Jul 2026, 03:45 PM").

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) {
    return String(n).padStart(2, '0');
}

function to12Hour(hours) {
    const h = hours % 12 === 0 ? 12 : hours % 12;
    const ampm = hours < 12 ? 'AM' : 'PM';
    return { h, ampm };
}

export function formatDate(dateValue) {
    if (!dateValue) return '';
    const d = new Date(dateValue);
    return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatDateTime(datetimeValue) {
    if (!datetimeValue) return '';
    const d = new Date(datetimeValue);
    const { h, ampm } = to12Hour(d.getHours());
    return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad2(h)}:${pad2(d.getMinutes())} ${ampm}`;
}

/** Accepts either a plain "HH:MM:SS" TIME string or a full timestamp. */
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
    const { h, ampm } = to12Hour(hours);
    return `${pad2(h)}:${pad2(minutes)} ${ampm}`;
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
