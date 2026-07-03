// File upload handling - replaces the PHP app's local-disk uploads/
// (profile pictures, portal logo) with Supabase Storage, since Netlify
// Functions have no persistent writable disk between invocations.
// Validation order matches the PHP version: extension allowlist ->
// real magic-byte MIME sniff (not the browser-declared Content-Type) ->
// size cap -> random filename.

import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { db } from './db.js';

const MAX_BYTES = 2 * 1024 * 1024; // 2MB, matches the PHP app's cap

const PROFILE_PICTURE_TYPES = new Set(['jpg', 'jpeg', 'png', 'webp']);
const LOGO_TYPES = new Set(['jpg', 'jpeg', 'png', 'svg', 'webp']);

/**
 * Validates and uploads a File (from Request.formData()) to a public
 * Supabase Storage bucket. Returns the public URL, or throws an Error
 * with a user-facing message on validation failure.
 */
export async function handleUpload(file, { bucket, allowedExt, prefix }) {
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

    const buffer = Buffer.from(await file.arrayBuffer());

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

    const filename = `${prefix}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const { error } = await db()
        .storage.from(bucket)
        .upload(filename, buffer, { contentType: file.type || undefined, upsert: false });
    if (error) throw new Error(`Upload failed: ${error.message}`);

    const { data } = db().storage.from(bucket).getPublicUrl(filename);
    return data.publicUrl;
}

export function uploadProfilePicture(file, userId) {
    return handleUpload(file, {
        bucket: 'profile-pictures',
        allowedExt: PROFILE_PICTURE_TYPES,
        prefix: `user_${userId}`,
    });
}

export function uploadPortalLogo(file) {
    return handleUpload(file, {
        bucket: 'portal-assets',
        allowedExt: LOGO_TYPES,
        prefix: 'logo',
    });
}
