// Shared branding constants - used by both the admin branding page (to
// render/validate the curated enum selects) and the page shell (to
// resolve the actual CSS font-family value + optional Google Fonts URL).
// Font choices are a closed set rather than free text: this app has no
// webfont-loading mechanism beyond a Google Fonts <link>, so an arbitrary
// admin-typed font name would just silently fail to render.

export const FONT_FAMILIES = {
    default: { label: 'System Default', css: "'Segoe UI', Roboto, system-ui, sans-serif", googleFont: null },
    inter: { label: 'Inter', css: "'Inter', sans-serif", googleFont: 'Inter:wght@400;600;700' },
    poppins: { label: 'Poppins', css: "'Poppins', sans-serif", googleFont: 'Poppins:wght@400;600;700' },
    opensans: { label: 'Open Sans', css: "'Open Sans', sans-serif", googleFont: 'Open+Sans:wght@400;600;700' },
    lato: { label: 'Lato', css: "'Lato', sans-serif", googleFont: 'Lato:wght@400;700' },
    roboto: { label: 'Roboto', css: "'Roboto', sans-serif", googleFont: 'Roboto:wght@400;500;700' },
    georgia: { label: 'Georgia (Serif)', css: "Georgia, 'Times New Roman', serif", googleFont: null },
};

export const FONT_SIZES = {
    small: { label: 'Small', px: '14px' },
    medium: { label: 'Medium (Default)', px: '16px' },
    large: { label: 'Large', px: '18px' },
};

export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function resolveFontFamily(key) {
    return FONT_FAMILIES[key] ?? FONT_FAMILIES.default;
}

export function resolveFontSize(key) {
    return FONT_SIZES[key] ?? FONT_SIZES.medium;
}

/** Returns `value` if it is a valid #rrggbb hex color, else `fallback` - a defense-in-depth
 *  check at render time even though values are already validated before being stored. */
export function safeHexColor(value, fallback) {
    return HEX_COLOR_PATTERN.test(value || '') ? value : fallback;
}
