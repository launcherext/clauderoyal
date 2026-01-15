/**
 * Authentication and Rate Limiting Middleware
 * SECURITY: Protects API endpoints from abuse and unauthorized access
 */
const crypto = require('../services/crypto');

// Admin API key from environment - REQUIRED for admin endpoints
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_API_KEY) {
    console.warn('[SECURITY WARNING] ADMIN_API_KEY not set - admin endpoints will be DISABLED');
}

// In-memory rate limit store (use Redis in production for multi-instance)
const rateLimitStore = new Map();

// Clean up expired entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of rateLimitStore.entries()) {
        if (now > data.resetTime) {
            rateLimitStore.delete(key);
        }
    }
}, 5 * 60 * 1000);

/**
 * Create a rate limiter middleware
 * @param {Object} options - Rate limit options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.maxRequests - Max requests per window
 * @param {string} options.message - Error message when limit exceeded
 * @param {Function} options.keyGenerator - Function to generate rate limit key from req
 * @returns {Function} Express middleware
 */
function createRateLimiter(options) {
    const {
        windowMs = 15 * 60 * 1000, // 15 minutes default
        maxRequests = 100,
        message = 'Too many requests, please try again later',
        keyGenerator = (req) => req.ip || req.connection.remoteAddress
    } = options;

    return (req, res, next) => {
        const key = `rl:${keyGenerator(req)}`;
        const now = Date.now();

        let record = rateLimitStore.get(key);

        if (!record || now > record.resetTime) {
            record = {
                count: 0,
                resetTime: now + windowMs
            };
        }

        record.count++;
        rateLimitStore.set(key, record);

        // Set rate limit headers (RFC 6585 / draft-8)
        const remaining = Math.max(0, maxRequests - record.count);
        const resetSeconds = Math.ceil((record.resetTime - now) / 1000);

        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', remaining);
        res.setHeader('X-RateLimit-Reset', resetSeconds);

        if (record.count > maxRequests) {
            res.setHeader('Retry-After', resetSeconds);
            return res.status(429).json({
                success: false,
                error: message,
                retryAfter: resetSeconds
            });
        }

        next();
    };
}

/**
 * Global API rate limiter - 100 requests per 15 minutes
 */
const globalRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 100,
    message: 'Too many requests from this IP, please try again later'
});

/**
 * Strict rate limiter for claim endpoints - 10 requests per hour
 * Prevents brute-force attacks on claim tokens
 */
const claimRateLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 10,
    message: 'Too many claim attempts. Please wait before trying again.',
    keyGenerator: (req) => `claim:${req.ip || req.connection.remoteAddress}`
});

/**
 * Very strict rate limiter for admin endpoints - 20 requests per hour
 */
const adminRateLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    maxRequests: 20,
    message: 'Admin rate limit exceeded',
    keyGenerator: (req) => `admin:${req.ip || req.connection.remoteAddress}`
});

/**
 * Admin authentication middleware
 * Requires valid API key in Authorization header
 */
function adminAuth(req, res, next) {
    // If no admin key configured, deny all admin access
    if (!ADMIN_API_KEY) {
        console.warn(`[SECURITY] Admin endpoint access attempted without ADMIN_API_KEY configured: ${req.path}`);
        return res.status(503).json({
            success: false,
            error: 'Admin endpoints disabled - ADMIN_API_KEY not configured'
        });
    }

    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({
            success: false,
            error: 'Authorization header required'
        });
    }

    // Expect: "Bearer <api_key>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
        return res.status(401).json({
            success: false,
            error: 'Invalid authorization format. Use: Bearer <api_key>'
        });
    }

    const providedKey = parts[1];

    // Constant-time comparison to prevent timing attacks
    if (!crypto.secureCompare(providedKey, ADMIN_API_KEY)) {
        console.warn(`[SECURITY] Invalid admin API key attempt from ${req.ip}`);
        return res.status(403).json({
            success: false,
            error: 'Invalid API key'
        });
    }

    // Log successful admin access
    console.log(`[ADMIN] Authenticated request to ${req.path} from ${req.ip}`);
    next();
}

/**
 * Request logging middleware for security auditing
 */
function securityLogger(req, res, next) {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const logData = {
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.path,
            ip: req.ip || req.connection.remoteAddress,
            status: res.statusCode,
            duration: `${duration}ms`,
            userAgent: req.headers['user-agent']?.substring(0, 100)
        };

        // Log suspicious activity
        if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429) {
            console.warn('[SECURITY]', JSON.stringify(logData));
        }
    });

    next();
}

/**
 * Validate that required security environment variables are set
 * Call this at startup to fail fast if misconfigured
 */
function validateSecurityConfig() {
    const warnings = [];
    const errors = [];

    if (!process.env.CLAIM_TOKEN_SECRET) {
        warnings.push('CLAIM_TOKEN_SECRET not set - using random secret');
    }

    if (!process.env.ADMIN_API_KEY) {
        warnings.push('ADMIN_API_KEY not set - admin endpoints disabled');
    }

    if (!process.env.DATABASE_URL) {
        errors.push('DATABASE_URL not set - cannot connect to database');
    }

    // Private keys should NEVER be logged, just check they exist
    if (!process.env.MASTER_WALLET_PRIVATE_KEY) {
        warnings.push('MASTER_WALLET_PRIVATE_KEY not set - fee claiming disabled');
    }

    if (!process.env.PRIZE_POOL_WALLET_PRIVATE_KEY) {
        errors.push('PRIZE_POOL_WALLET_PRIVATE_KEY not set - payouts will fail');
    }

    if (warnings.length > 0) {
        console.warn('\n[SECURITY CONFIG WARNINGS]');
        warnings.forEach(w => console.warn(`  - ${w}`));
    }

    if (errors.length > 0) {
        console.error('\n[SECURITY CONFIG ERRORS]');
        errors.forEach(e => console.error(`  - ${e}`));
        // Don't throw in dev, but log prominently
        if (process.env.NODE_ENV === 'production') {
            throw new Error('Security configuration errors detected - refusing to start in production');
        }
    }

    return { warnings, errors };
}

module.exports = {
    createRateLimiter,
    globalRateLimiter,
    claimRateLimiter,
    adminRateLimiter,
    adminAuth,
    securityLogger,
    validateSecurityConfig
};
