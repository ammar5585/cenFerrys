// File upload handling - replaces the PHP app's local-disk uploads/
// (profile pictures, portal logo) with Supabase Storage, since Netlify
// Functions have no persistent writable disk between invocations.
// Validation order matches the PHP version: extension allowlist ->
// real magic-byte MIME sniff (not the browser-declared Content-Type) ->
// size cap -> random filename.

import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { Jimp, JimpMime } from 'jimp';
import { db } from './db.js';

const MAX_BYTES = 2 * 1024 * 1024; // 2MB, matches the PHP app's cap

// Only jpg/png go through Jimp: svg is vector (no raster resize needed),
// and the bundled `jimp` package ships no webp encoder (that's a separate
// wasm plugin) - webp uploads are passed through unresized rather than
// pulling in that extra dependency for a format that's already efficient.
const RESIZABLE_EXT = new Set(['jpg', 'jpeg', 'png']);

/**
 * Downscales an image to fit within maxWidth x maxHeight (preserving
 * aspect ratio, never upscaling) before it's stored. Branding logos are
 * commonly uploaded at their original multi-megapixel resolution despite
 * rendering at a few dozen CSS pixels - this keeps the stored file close
 * to what's actually served instead of shipping the original every load.
 */
async function resizeIfLarger(buffer, ext, maxWidth, maxHeight) {
    if (!RESIZABLE_EXT.has(ext)) return buffer;
    const img = await Jimp.fromBuffer(buffer);
    const { width, height } = img.bitmap;
    if (width <= maxWidth && height <= maxHeight) return buffer;
    const scale = Math.min(maxWidth / width, maxHeight / height);
    img.resize({ w: Math.round(width * scale), h: Math.round(height * scale) });
    return img.getBuffer(ext === 'png' ? JimpMime.png : JimpMime.jpeg);
}

const PROFILE_PICTURE_TYPES = new Set(['jpg', 'jpeg', 'png', 'webp']);
const LOGO_TYPES = new Set(['jpg', 'jpeg', 'png', 'svg', 'webp']);
// Favicons: PNG/SVG only (not full .ico support) - every target browser
// accepts either via <link rel="icon">, and this reuses the LOGO_TYPES
// SVG-skip-sniff branch in handleUpload with no new logic.
const FAVICON_TYPES = new Set(['png', 'svg']);
// Login background / banner images are photographic, not vector.
const BACKGROUND_TYPES = new Set(['jpg', 'jpeg', 'png', 'webp']);

/**
 * Validates and uploads a File (from Request.formData()) to a public
 * Supabase Storage bucket. Returns the public URL, or throws an Error
 * with a user-facing message on validation failure.
 */
export async function handleUpload(file, { bucket, allowedExt, prefix, maxWidth, maxHeight }) {
    if (!file || typeof file.arrayBuffer !== 'function') {
        throw new Error('No file was uploaded.');
    }
    if (file.size > MAX_BYTES) {
        throw new Error('File must be smaller than 2MB.');
    }

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!allowedExt.has(ext)) {
        throw new Error(`File type not allowed. Accepted: ${[...allowedExt].join(', ')}`);
    }

    let buffer = Buffer.from(await file.arrayBuffer());

    // SVGs have no reliable magic-byte signature (they're plain-text XML) -
    // file-type intentionally can't sniff them, so only enforce the
    // sniff check for the raster formats.
    if (ext !== 'svg') {
        const sniffed = await fileTypeFromBuffer(buffer);
        const sniffedExt = sniffed?.ext === 'jpg' ? 'jpg' : sniffed?.ext;
        if (!sniffed || !allowedExt.has(sniffedExt)) {
            throw new Error('File content does not match an allowed image type.');
        }
    }

    if (maxWidth && maxHeight) {
        buffer = await resizeIfLarger(buffer, ext, maxWidth, maxHeight);
    }

    const filename = `${prefix}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const { error } = await db()
        .storage.from(bucket)
        // cacheControl is safe at a long duration (1 year): filenames are
        // randomized and never overwritten (upsert: false), so a given
        // URL's content can never change under a cached response.
        .upload(filename, buffer, { contentType: file.type || undefined, upsert: false, cacheControl: '31536000' });
    if (error) throw new Error(`Upload failed: ${error.message}`);

    const { data } = db().storage.from(bucket).getPublicUrl(filename);
    return data.publicUrl;
}

export function uploadProfilePicture(file, userId) {
    return handleUpload(file, {
        bucket: 'profile-pictures',
        allowedExt: PROFILE_PICTURE_TYPES,
        prefix: `user_${userId}`,
        // Largest on-screen use is the 100x100 staff profile picture;
        // doubled for retina, with headroom since object-fit:cover may crop.
        maxWidth: 400,
        maxHeight: 400,
    });
}

export function uploadSiteLogo(file) {
    return handleUpload(file, {
        bucket: 'portal-assets',
        allowedExt: LOGO_TYPES,
        prefix: 'site_logo',
        // .sidebar-brand-logo caps at 140x32 CSS px; doubled for retina.
        maxWidth: 280,
        maxHeight: 64,
    });
}

export function uploadLoginLogo(file) {
    return handleUpload(file, {
        bucket: 'portal-assets',
        allowedExt: LOGO_TYPES,
        prefix: 'login_logo',
        // .login-logo caps at 220x64 CSS px; doubled for retina.
        maxWidth: 440,
        maxHeight: 128,
    });
}

export function uploadFavicon(file) {
    return handleUpload(file, {
        bucket: 'portal-assets',
        allowedExt: FAVICON_TYPES,
        prefix: 'favicon',
    });
}

export function uploadLoginBackground(file) {
    return handleUpload(file, {
        bucket: 'portal-assets',
        allowedExt: BACKGROUND_TYPES,
        prefix: 'login_bg',
    });
}

export function uploadBannerImage(file) {
    return handleUpload(file, {
        bucket: 'portal-assets',
        allowedExt: BACKGROUND_TYPES,
        prefix: 'banner',
    });
}
