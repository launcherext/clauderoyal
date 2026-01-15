/**
 * Cryptographic utilities for secure token generation and verification
 * SECURITY: Uses Node.js crypto module - NOT Math.random()
 */
const crypto = require('crypto');

// Claim token secret - MUST be set in production
const CLAIM_SECRET = process.env.CLAIM_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.CLAIM_TOKEN_SECRET) {
    console.warn('[SECURITY WARNING] CLAIM_TOKEN_SECRET not set - using random secret (claims will not survive restarts)');
}

/**
 * Generate a cryptographically secure session ID
 * Uses 256 bits of entropy - impossible to brute force
 * @returns {string} Base64url encoded session ID
 */
function generateSecureSessionId() {
    const timestamp = Date.now().toString(36);
    const randomBytes = crypto.randomBytes(32).toString('base64url');
    return `sess_${timestamp}_${randomBytes}`;
}

/**
 * Generate a cryptographically secure player ID
 * @returns {string} Secure player ID
 */
function generateSecurePlayerId() {
    return `p_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Generate a signed claim token for prize redemption
 * Structure: base64url(payload).signature
 * @param {Object} claimData - Claim details
 * @param {string} claimData.roundId - Round identifier
 * @param {string} claimData.playerId - Player identifier
 * @param {string} claimData.sessionId - Session identifier
 * @param {number} claimData.prizeAmount - Prize amount in SOL
 * @param {number} claimData.expiresAt - Expiration timestamp (ms)
 * @returns {string} Signed claim token
 */
function generateClaimToken(claimData) {
    const payload = {
        rid: claimData.roundId,
        pid: claimData.playerId,
        sid: claimData.sessionId,
        amt: claimData.prizeAmount,
        exp: claimData.expiresAt,
        iat: Date.now(),
        nonce: crypto.randomBytes(16).toString('hex')
    };

    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
        .createHmac('sha256', CLAIM_SECRET)
        .update(payloadStr)
        .digest('base64url');

    return `${payloadStr}.${signature}`;
}

/**
 * Verify and decode a claim token
 * @param {string} token - The claim token to verify
 * @returns {Object|null} Decoded payload if valid, null if invalid
 */
function verifyClaimToken(token) {
    if (!token || typeof token !== 'string') {
        return null;
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
        return null;
    }

    const [payloadStr, providedSignature] = parts;

    // Verify signature using constant-time comparison
    const expectedSignature = crypto
        .createHmac('sha256', CLAIM_SECRET)
        .update(payloadStr)
        .digest('base64url');

    if (!crypto.timingSafeEqual(
        Buffer.from(providedSignature),
        Buffer.from(expectedSignature)
    )) {
        console.warn('[SECURITY] Invalid claim token signature detected');
        return null;
    }

    // Decode payload
    try {
        const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());

        // Check expiration
        if (payload.exp && Date.now() > payload.exp) {
            console.log('[CLAIM] Token expired');
            return null;
        }

        return {
            roundId: payload.rid,
            playerId: payload.pid,
            sessionId: payload.sid,
            prizeAmount: payload.amt,
            expiresAt: payload.exp,
            issuedAt: payload.iat,
            nonce: payload.nonce
        };
    } catch (e) {
        console.warn('[SECURITY] Malformed claim token payload');
        return null;
    }
}

/**
 * Generate a hash of the claim token for database storage
 * This allows us to verify token hasn't been reused without storing the full token
 * @param {string} token - The claim token
 * @returns {string} SHA256 hash of the token
 */
function hashClaimToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a secure API key for admin authentication
 * @returns {string} 256-bit API key
 */
function generateApiKey() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if equal
 */
function secureCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }

    if (a.length !== b.length) {
        return false;
    }

    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = {
    generateSecureSessionId,
    generateSecurePlayerId,
    generateClaimToken,
    verifyClaimToken,
    hashClaimToken,
    generateApiKey,
    secureCompare,
    CLAIM_SECRET
};
