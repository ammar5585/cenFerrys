// Escaping tagged-template helper - port of includes/functions.php's
// h() (htmlspecialchars). `html\`...${value}...\`` auto-escapes every
// interpolated value; wrap already-safe/composed markup with raw() to
// skip escaping (e.g. embedding the output of another html`` call).

class SafeString {
    constructor(value) {
        this.value = value;
    }
    toString() {
        return this.value;
    }
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** Marks a string as already-safe HTML so html`` won't re-escape it. */
export function raw(value) {
    return new SafeString(value == null ? '' : String(value));
}

function stringifyValue(value) {
    if (value instanceof SafeString) return value.value;
    if (Array.isArray(value)) return value.map(stringifyValue).join('');
    if (value === null || value === undefined || value === false) return '';
    return escapeHtml(value);
}

/**
 * Tagged template: html`<p>${userInput}</p>` - userInput is escaped.
 * The return value is itself a SafeString, so nesting html`` calls
 * inside other html`` calls composes without double-escaping.
 */
export function html(strings, ...values) {
    let result = strings[0];
    for (let i = 0; i < values.length; i++) {
        result += stringifyValue(values[i]) + strings[i + 1];
    }
    return new SafeString(result);
}

/** Escapes a single value the way PHP's h() did - for use outside html``. */
export function h(value) {
    return escapeHtml(value ?? '');
}
