// Reversible encryption for the one secret Email Settings needs to
// store and later re-use to actually send mail (the SMTP password) -
// bcryptjs (auth.js) is one-way and can't be used here. AES-256-GCM via
// Node's built-in crypto, keyed by sha256(JWT_SECRET) so no additional
// environment variable needs to be provisioned - rotating JWT_SECRET
// would require re-entering the SMTP password, an acceptable tradeoff
// for not needing a second secret configured in Vercel.

import crypto from 'crypto';

function encryptionKey() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set. See .env.example.');
    return crypto.createHash('sha256').update(secret).digest();
}

/** Returns "iv:authTag:ciphertext", each base64 - safe to store as a settings_value string. */
export function encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/** Inverse of encrypt(). Returns null (rather than throwing) for empty/malformed input. */
export function decrypt(stored) {
    if (!stored) return null;
    const parts = stored.split(':');
    if (parts.length !== 3) return null;
    const [ivB64, authTagB64, ciphertextB64] = parts;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
        decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
        return plaintext.toString('utf8');
    } catch {
        return null;
    }
}
