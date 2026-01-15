/**
 * Database service with security hardening
 * SECURITY: No hardcoded credentials, row-level locking for race condition prevention
 */
const { Pool } = require('pg');

// SECURITY: Require DATABASE_URL from environment - NO FALLBACKS
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('[FATAL] DATABASE_URL environment variable is required');
    console.error('[FATAL] Set DATABASE_URL in your environment or .env file');
    // Don't crash immediately - let the app handle this gracefully
}

const pool = DATABASE_URL ? new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DATABASE_SSL !== 'false' ? { rejectUnauthorized: false } : false,
    max: 20, // Connection pool size
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
}) : null;

// Log connection status (not credentials!)
if (pool) {
    pool.on('connect', () => {
        console.log('[DB] New client connected to pool');
    });

    pool.on('error', (err) => {
        console.error('[DB] Unexpected pool error:', err.message);
    });
}

async function initDatabase() {
    if (!pool) {
        throw new Error('Database not configured - set DATABASE_URL environment variable');
    }

    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS pending_claims (
                id SERIAL PRIMARY KEY,
                round_id VARCHAR(50) UNIQUE NOT NULL,
                player_name VARCHAR(100) NOT NULL,
                winner_session_id VARCHAR(100),
                prize_amount_sol DECIMAL(18,9) DEFAULT 0,
                wallet_address VARCHAR(50),
                claim_token_hash VARCHAR(64),
                claim_status VARCHAR(20) DEFAULT 'eligible',
                attempts INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours',
                claimed_at TIMESTAMP,
                tx_signature VARCHAR(100),
                error_message TEXT,
                processing_locked_at TIMESTAMP,
                processing_locked_by VARCHAR(50)
            );

            CREATE TABLE IF NOT EXISTS fee_claims (
                id SERIAL PRIMARY KEY,
                claimed_at TIMESTAMP DEFAULT NOW(),
                total_claimed_sol DECIMAL(18,9),
                creator_share_sol DECIMAL(18,9),
                prize_pool_share_sol DECIMAL(18,9),
                reserve_share_sol DECIMAL(18,9),
                tx_signature VARCHAR(100),
                status VARCHAR(20) DEFAULT 'pending'
            );

            CREATE TABLE IF NOT EXISTS prize_pool (
                id SERIAL PRIMARY KEY,
                balance_sol DECIMAL(18,9) DEFAULT 0,
                last_updated TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS payouts (
                id SERIAL PRIMARY KEY,
                claim_id INT REFERENCES pending_claims(id),
                wallet_address VARCHAR(50) NOT NULL,
                amount_sol DECIMAL(18,9) NOT NULL,
                tx_signature VARCHAR(100),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW(),
                completed_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS token_metadata (
                id SERIAL PRIMARY KEY,
                mint_address VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(100),
                symbol VARCHAR(20),
                image_url TEXT,
                description TEXT,
                total_supply DECIMAL(30,9),
                last_updated TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS security_events (
                id SERIAL PRIMARY KEY,
                event_type VARCHAR(50) NOT NULL,
                ip_address VARCHAR(50),
                details JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            );

            INSERT INTO prize_pool (balance_sol)
            SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM prize_pool LIMIT 1);

            CREATE INDEX IF NOT EXISTS idx_claims_session ON pending_claims(winner_session_id);
            CREATE INDEX IF NOT EXISTS idx_claims_status ON pending_claims(claim_status);
            CREATE INDEX IF NOT EXISTS idx_claims_token_hash ON pending_claims(claim_token_hash);
        `);
        console.log('[DB] Database tables initialized');
    } finally {
        client.release();
    }
}

async function createPendingClaim(roundId, playerName, sessionId, prizeAmount, tokenHash = null) {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`
        INSERT INTO pending_claims (round_id, player_name, winner_session_id, prize_amount_sol, claim_token_hash)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (round_id) DO UPDATE SET
            player_name = $2,
            winner_session_id = $3,
            prize_amount_sol = $4,
            claim_token_hash = $5,
            claim_status = 'eligible',
            created_at = NOW(),
            expires_at = NOW() + INTERVAL '24 hours'
        RETURNING *
    `, [roundId, playerName, sessionId, prizeAmount, tokenHash]);
    return result.rows[0];
}

async function getPendingClaim(roundId) {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`
        SELECT * FROM pending_claims WHERE round_id = $1
    `, [roundId]);
    return result.rows[0];
}

async function getClaimBySession(sessionId) {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`
        SELECT * FROM pending_claims
        WHERE winner_session_id = $1
        AND claim_status = 'eligible'
        AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1
    `, [sessionId]);
    return result.rows[0];
}

/**
 * Get claim by token hash - more secure than session lookup
 * @param {string} tokenHash - SHA256 hash of the claim token
 */
async function getClaimByTokenHash(tokenHash) {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`
        SELECT * FROM pending_claims
        WHERE claim_token_hash = $1
        AND claim_status = 'eligible'
        AND expires_at > NOW()
    `, [tokenHash]);
    return result.rows[0];
}

async function updateClaimWallet(claimId, walletAddress) {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`
        UPDATE pending_claims
        SET wallet_address = $2, claim_status = 'queued'
        WHERE id = $1 AND claim_status = 'eligible'
        RETURNING *
    `, [claimId, walletAddress]);
    return result.rows[0];
}

async function updateClaimStatus(claimId, status, txSignature = null, errorMessage = null) {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`
        UPDATE pending_claims
        SET claim_status = $2,
            tx_signature = COALESCE($3, tx_signature),
            error_message = $4,
            claimed_at = CASE WHEN $2 = 'paid' THEN NOW() ELSE claimed_at END,
            attempts = attempts + 1,
            processing_locked_at = NULL,
            processing_locked_by = NULL
        WHERE id = $1
        RETURNING *
    `, [claimId, status, txSignature, errorMessage]);
    return result.rows[0];
}

async function getQueuedClaims() {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`
        SELECT * FROM pending_claims
        WHERE claim_status = 'queued'
        AND wallet_address IS NOT NULL
        ORDER BY created_at ASC
    `);
    return result.rows;
}

/**
 * SECURITY: Get and lock a single claim for processing
 * Uses FOR UPDATE SKIP LOCKED to prevent race conditions
 * Only one process can hold the lock at a time
 * @param {string} processorId - Unique ID of the processing instance
 * @returns {Object|null} Locked claim or null if none available
 */
async function getAndLockClaimForProcessing(processorId) {
    if (!pool) throw new Error('Database not configured');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // FOR UPDATE SKIP LOCKED - atomically select and lock one row
        // Skips rows locked by other processes
        const result = await client.query(`
            SELECT * FROM pending_claims
            WHERE claim_status = 'queued'
            AND wallet_address IS NOT NULL
            AND (processing_locked_at IS NULL OR processing_locked_at < NOW() - INTERVAL '5 minutes')
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }

        const claim = result.rows[0];

        // Mark as being processed
        await client.query(`
            UPDATE pending_claims
            SET claim_status = 'processing',
                processing_locked_at = NOW(),
                processing_locked_by = $2
            WHERE id = $1
        `, [claim.id, processorId]);

        await client.query('COMMIT');

        return { ...claim, claim_status: 'processing' };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * SECURITY: Complete a claim payout atomically
 * Updates claim status and prize pool in a single transaction
 */
async function completeClaimPayout(claimId, txSignature, amountSol) {
    if (!pool) throw new Error('Database not configured');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Update claim to paid
        await client.query(`
            UPDATE pending_claims
            SET claim_status = 'paid',
                tx_signature = $2,
                claimed_at = NOW(),
                processing_locked_at = NULL,
                processing_locked_by = NULL
            WHERE id = $1
        `, [claimId, txSignature]);

        // Subtract from prize pool
        await client.query(`
            UPDATE prize_pool
            SET balance_sol = GREATEST(0, balance_sol - $1),
                last_updated = NOW()
        `, [amountSol]);

        // Log payout
        const claimResult = await client.query(
            'SELECT wallet_address FROM pending_claims WHERE id = $1',
            [claimId]
        );

        if (claimResult.rows[0]) {
            await client.query(`
                INSERT INTO payouts (claim_id, wallet_address, amount_sol, tx_signature, status, completed_at)
                VALUES ($1, $2, $3, $4, 'completed', NOW())
            `, [claimId, claimResult.rows[0].wallet_address, amountSol, txSignature]);
        }

        await client.query('COMMIT');
        return true;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Release a claim lock if processing fails
 */
async function releaseClaimLock(claimId, errorMessage = null) {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`
        UPDATE pending_claims
        SET claim_status = CASE
                WHEN attempts >= 3 THEN 'failed'
                ELSE 'queued'
            END,
            error_message = $2,
            processing_locked_at = NULL,
            processing_locked_by = NULL,
            attempts = attempts + 1
        WHERE id = $1
        RETURNING *
    `, [claimId, errorMessage]);
    return result.rows[0];
}

async function getPrizePoolBalance() {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`SELECT balance_sol FROM prize_pool LIMIT 1`);
    return parseFloat(result.rows[0]?.balance_sol) || 0;
}

async function updatePrizePoolBalance(amount) {
    if (!pool) throw new Error('Database not configured');

    await pool.query(`
        UPDATE prize_pool SET balance_sol = $1, last_updated = NOW()
    `, [amount]);
}

async function addToPrizePool(amount) {
    if (!pool) throw new Error('Database not configured');

    await pool.query(`
        UPDATE prize_pool SET balance_sol = balance_sol + $1, last_updated = NOW()
    `, [amount]);
}

async function subtractFromPrizePool(amount) {
    if (!pool) throw new Error('Database not configured');

    await pool.query(`
        UPDATE prize_pool SET balance_sol = GREATEST(0, balance_sol - $1), last_updated = NOW()
    `, [amount]);
}

async function logFeeClaim(totalClaimed, creatorShare, prizeShare, reserveShare, txSignature) {
    if (!pool) throw new Error('Database not configured');

    await pool.query(`
        INSERT INTO fee_claims (total_claimed_sol, creator_share_sol, prize_pool_share_sol, reserve_share_sol, tx_signature, status)
        VALUES ($1, $2, $3, $4, $5, 'completed')
    `, [totalClaimed, creatorShare, prizeShare, reserveShare, txSignature]);
}

async function logPayout(claimId, walletAddress, amount, txSignature, status) {
    if (!pool) throw new Error('Database not configured');

    await pool.query(`
        INSERT INTO payouts (claim_id, wallet_address, amount_sol, tx_signature, status, completed_at)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'completed' THEN NOW() ELSE NULL END)
    `, [claimId, walletAddress, amount, txSignature, status]);
}

async function getRecentPayouts(limit = 10) {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`
        SELECT p.*, pc.player_name, pc.round_id
        FROM payouts p
        JOIN pending_claims pc ON p.claim_id = pc.id
        WHERE p.status = 'completed'
        ORDER BY p.completed_at DESC
        LIMIT $1
    `, [limit]);
    return result.rows;
}

async function saveTokenMetadata(mintAddress, name, symbol, imageUrl, description, totalSupply) {
    if (!pool) throw new Error('Database not configured');

    await pool.query(`
        INSERT INTO token_metadata (mint_address, name, symbol, image_url, description, total_supply, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (mint_address) DO UPDATE SET
            name = $2, symbol = $3, image_url = $4, description = $5, total_supply = $6, last_updated = NOW()
    `, [mintAddress, name, symbol, imageUrl, description, totalSupply]);
}

async function getTokenMetadata(mintAddress) {
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(`SELECT * FROM token_metadata WHERE mint_address = $1`, [mintAddress]);
    return result.rows[0];
}

/**
 * Log security events for auditing
 */
async function logSecurityEvent(eventType, ipAddress, details) {
    if (!pool) return; // Don't fail if DB not ready

    try {
        await pool.query(`
            INSERT INTO security_events (event_type, ip_address, details)
            VALUES ($1, $2, $3)
        `, [eventType, ipAddress, JSON.stringify(details)]);
    } catch (e) {
        console.error('[DB] Failed to log security event:', e.message);
    }
}

/**
 * Check database health
 */
async function healthCheck() {
    if (!pool) return { healthy: false, error: 'Database not configured' };

    try {
        const result = await pool.query('SELECT NOW()');
        return { healthy: true, timestamp: result.rows[0].now };
    } catch (e) {
        return { healthy: false, error: e.message };
    }
}

module.exports = {
    pool,
    initDatabase,
    createPendingClaim,
    getPendingClaim,
    getClaimBySession,
    getClaimByTokenHash,
    updateClaimWallet,
    updateClaimStatus,
    getQueuedClaims,
    getAndLockClaimForProcessing,
    completeClaimPayout,
    releaseClaimLock,
    getPrizePoolBalance,
    updatePrizePoolBalance,
    addToPrizePool,
    subtractFromPrizePool,
    logFeeClaim,
    logPayout,
    getRecentPayouts,
    saveTokenMetadata,
    getTokenMetadata,
    logSecurityEvent,
    healthCheck
};
