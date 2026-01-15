const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:NajctWeCLYaSywSNHKxkWElcSbTsDSPc@caboose.proxy.rlwy.net:58182/railway',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
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
                claim_status VARCHAR(20) DEFAULT 'eligible',
                attempts INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours',
                claimed_at TIMESTAMP,
                tx_signature VARCHAR(100),
                error_message TEXT
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

            INSERT INTO prize_pool (balance_sol)
            SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM prize_pool LIMIT 1);
        `);
        console.log('Database tables initialized');
    } finally {
        client.release();
    }
}

async function createPendingClaim(roundId, playerName, sessionId, prizeAmount) {
    const result = await pool.query(`
        INSERT INTO pending_claims (round_id, player_name, winner_session_id, prize_amount_sol)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (round_id) DO UPDATE SET
            player_name = $2,
            winner_session_id = $3,
            prize_amount_sol = $4,
            claim_status = 'eligible',
            created_at = NOW(),
            expires_at = NOW() + INTERVAL '24 hours'
        RETURNING *
    `, [roundId, playerName, sessionId, prizeAmount]);
    return result.rows[0];
}

async function getPendingClaim(roundId) {
    const result = await pool.query(`
        SELECT * FROM pending_claims WHERE round_id = $1
    `, [roundId]);
    return result.rows[0];
}

async function getClaimBySession(sessionId) {
    const result = await pool.query(`
        SELECT * FROM pending_claims
        WHERE winner_session_id = $1
        AND claim_status = 'eligible'
        AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1
    `, [sessionId]);
    return result.rows[0];
}

async function updateClaimWallet(claimId, walletAddress) {
    const result = await pool.query(`
        UPDATE pending_claims
        SET wallet_address = $2, claim_status = 'queued'
        WHERE id = $1 AND claim_status = 'eligible'
        RETURNING *
    `, [claimId, walletAddress]);
    return result.rows[0];
}

async function updateClaimStatus(claimId, status, txSignature = null, errorMessage = null) {
    const result = await pool.query(`
        UPDATE pending_claims
        SET claim_status = $2,
            tx_signature = COALESCE($3, tx_signature),
            error_message = $4,
            claimed_at = CASE WHEN $2 = 'paid' THEN NOW() ELSE claimed_at END,
            attempts = attempts + 1
        WHERE id = $1
        RETURNING *
    `, [claimId, status, txSignature, errorMessage]);
    return result.rows[0];
}

async function getQueuedClaims() {
    const result = await pool.query(`
        SELECT * FROM pending_claims
        WHERE claim_status = 'queued'
        AND wallet_address IS NOT NULL
        ORDER BY created_at ASC
    `);
    return result.rows;
}

async function getPrizePoolBalance() {
    const result = await pool.query(`SELECT balance_sol FROM prize_pool LIMIT 1`);
    return result.rows[0]?.balance_sol || 0;
}

async function updatePrizePoolBalance(amount) {
    await pool.query(`
        UPDATE prize_pool SET balance_sol = $1, last_updated = NOW()
    `, [amount]);
}

async function addToPrizePool(amount) {
    await pool.query(`
        UPDATE prize_pool SET balance_sol = balance_sol + $1, last_updated = NOW()
    `, [amount]);
}

async function subtractFromPrizePool(amount) {
    await pool.query(`
        UPDATE prize_pool SET balance_sol = GREATEST(0, balance_sol - $1), last_updated = NOW()
    `, [amount]);
}

async function logFeeClaim(totalClaimed, creatorShare, prizeShare, reserveShare, txSignature) {
    await pool.query(`
        INSERT INTO fee_claims (total_claimed_sol, creator_share_sol, prize_pool_share_sol, reserve_share_sol, tx_signature, status)
        VALUES ($1, $2, $3, $4, $5, 'completed')
    `, [totalClaimed, creatorShare, prizeShare, reserveShare, txSignature]);
}

async function logPayout(claimId, walletAddress, amount, txSignature, status) {
    await pool.query(`
        INSERT INTO payouts (claim_id, wallet_address, amount_sol, tx_signature, status, completed_at)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'completed' THEN NOW() ELSE NULL END)
    `, [claimId, walletAddress, amount, txSignature, status]);
}

async function getRecentPayouts(limit = 10) {
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
    await pool.query(`
        INSERT INTO token_metadata (mint_address, name, symbol, image_url, description, total_supply, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (mint_address) DO UPDATE SET
            name = $2, symbol = $3, image_url = $4, description = $5, total_supply = $6, last_updated = NOW()
    `, [mintAddress, name, symbol, imageUrl, description, totalSupply]);
}

async function getTokenMetadata(mintAddress) {
    const result = await pool.query(`SELECT * FROM token_metadata WHERE mint_address = $1`, [mintAddress]);
    return result.rows[0];
}

module.exports = {
    pool,
    initDatabase,
    createPendingClaim,
    getPendingClaim,
    getClaimBySession,
    updateClaimWallet,
    updateClaimStatus,
    getQueuedClaims,
    getPrizePoolBalance,
    updatePrizePoolBalance,
    addToPrizePool,
    subtractFromPrizePool,
    logFeeClaim,
    logPayout,
    getRecentPayouts,
    saveTokenMetadata,
    getTokenMetadata
};
