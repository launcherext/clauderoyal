/**
 * Reward Service with security hardening
 * SECURITY: Uses cryptographic claim tokens, database locking, proper validation
 */
const cron = require('node-cron');
const db = require('./database');
const wallet = require('./walletService');
const pumpportal = require('./pumpportal');
const helius = require('./helius');
const crypto = require('./crypto');

const TOKEN_MINT = process.env.TOKEN_MINT_ADDRESS || '';

// Payout constants
const MIN_PRIZE_SOL = 0.005;      // Minimum prize (tx fees ~0.000005 SOL)
const MAX_PAYOUT_SOL = 50;        // Safety cap per payout
const WALLET_RESERVE_SOL = 0.001; // Keep in wallet for rent/fees

let isProcessingQueue = false;
let lastFeeClaimTime = 0;

// Unique processor ID for this instance (for distributed locking)
const PROCESSOR_ID = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

async function initialize() {
    try {
        await db.initDatabase();
        console.log('[REWARD] Database initialized');

        if (TOKEN_MINT) {
            await refreshTokenMetadata();
            pumpportal.connectWebSocket(TOKEN_MINT);
        }

        startAutoClaimCron();
        startPayoutProcessorCron();

        console.log('[REWARD] Service started');
        console.log('[REWARD] Processor ID:', PROCESSOR_ID);
        console.log('[REWARD] Master wallet:', wallet.getMasterPublicKey() || 'NOT CONFIGURED');
        console.log('[REWARD] Prize pool wallet:', wallet.getPrizePoolPublicKey() || 'NOT CONFIGURED');
        console.log('[REWARD] Reserve wallet:', wallet.getReservePublicKey() || 'NOT CONFIGURED');
    } catch (e) {
        console.error('[REWARD] Failed to initialize:', e.message);
    }
}

function startAutoClaimCron() {
    cron.schedule('0 * * * *', async () => {
        console.log('[REWARD] Running hourly fee claim...');
        await claimAndDistributeFees();
    });
    console.log('[REWARD] Auto-claim cron scheduled (hourly)');
}

function startPayoutProcessorCron() {
    cron.schedule('*/5 * * * *', async () => {
        await processPayoutQueue();
    });
    console.log('[REWARD] Payout processor cron scheduled (every 5 min)');
}

async function claimAndDistributeFees() {
    const now = Date.now();
    if (now - lastFeeClaimTime < 300000) {
        console.log('[REWARD] Fee claim cooldown active');
        return null;
    }

    try {
        const claimResult = await pumpportal.claimCreatorFees(0.0001);

        if (!claimResult || !claimResult.signature) {
            console.log('[REWARD] No fees claimed or claim failed');
            return null;
        }

        lastFeeClaimTime = now;

        await new Promise(r => setTimeout(r, 5000));

        const masterBalance = await wallet.getMasterWalletBalance();
        console.log('[REWARD] Master wallet balance after claim:', masterBalance, 'SOL');

        if (masterBalance > WALLET_RESERVE_SOL) {
            const distribution = await wallet.distributeClaimedFees(masterBalance - WALLET_RESERVE_SOL);

            await db.logFeeClaim(
                distribution.totalClaimed,
                distribution.creatorShare,
                distribution.prizeShare,
                distribution.reserveShare,
                claimResult.signature
            );

            await db.addToPrizePool(distribution.prizeShare);

            console.log('[REWARD] Fees distributed:', distribution);
            return distribution;
        }

        return null;
    } catch (e) {
        console.error('[REWARD] Fee claim/distribution error:', e.message);
        return null;
    }
}

/**
 * Create a winner claim with cryptographic token
 * SECURITY: Generates signed claim token that must be presented to redeem
 * @param {number} roundNumber - Round number
 * @param {string} playerName - Player name
 * @param {string} playerId - Player ID
 * @param {string} sessionId - Session ID
 * @returns {Object} Claim data including token
 */
async function createWinnerClaim(roundNumber, playerName, playerId, sessionId) {
    try {
        const prizePoolBalance = await wallet.getPrizePoolWalletBalance();
        let prizeAmount = prizePoolBalance > WALLET_RESERVE_SOL ? prizePoolBalance - WALLET_RESERVE_SOL : 0;

        // Cap at maximum payout for safety
        if (prizeAmount > MAX_PAYOUT_SOL) {
            console.log(`[REWARD] Capping prize from ${prizeAmount} to ${MAX_PAYOUT_SOL} SOL`);
            prizeAmount = MAX_PAYOUT_SOL;
        }

        // Skip if prize is below minimum (not worth tx fees)
        if (prizeAmount < MIN_PRIZE_SOL) {
            console.log(`[REWARD] Prize pool too low (${prizeAmount} SOL) - skipping claim for ${playerName}`);
            return null;
        }

        const roundId = `round-${roundNumber}-${Date.now()}`;
        const expiresAt = Date.now() + (24 * 60 * 60 * 1000); // 24 hours

        // Generate cryptographic claim token
        const claimToken = crypto.generateClaimToken({
            roundId,
            playerId,
            sessionId,
            prizeAmount,
            expiresAt
        });

        // Store hash of token (not the token itself) in database
        const tokenHash = crypto.hashClaimToken(claimToken);

        const claim = await db.createPendingClaim(
            roundId,
            playerName,
            sessionId,
            prizeAmount,
            tokenHash
        );

        console.log(`[REWARD] Created claim for ${playerName}: ${prizeAmount} SOL (token hash: ${tokenHash.substring(0, 8)}...)`);

        return {
            ...claim,
            claimToken // Return token to be sent to client
        };
    } catch (e) {
        console.error('[REWARD] Failed to create winner claim:', e.message);
        return null;
    }
}

/**
 * Submit wallet address to claim prize
 * SECURITY: Requires valid claim token, uses atomic DB locking to prevent race conditions
 * @param {string} claimToken - Cryptographic claim token
 * @param {string} walletAddress - Solana wallet address
 * @returns {Object} Result
 */
async function submitWalletForClaim(claimToken, walletAddress) {
    // Validate wallet address first
    if (!wallet.validateSolanaAddress(walletAddress)) {
        console.warn('[SECURITY] Invalid Solana address submitted');
        return { success: false, error: 'Invalid Solana address' };
    }

    // Verify claim token cryptographic signature
    const tokenData = crypto.verifyClaimToken(claimToken);
    if (!tokenData) {
        console.warn('[SECURITY] Invalid or expired claim token submitted');
        await db.logSecurityEvent('invalid_claim_token', null, { walletAddress });
        return { success: false, error: 'Invalid or expired claim token' };
    }

    try {
        const tokenHash = crypto.hashClaimToken(claimToken);

        // SECURITY: Atomic lock-and-submit prevents race condition (CU-1 fix)
        // This uses FOR UPDATE to lock the row during validation + update
        const lockResult = await db.lockAndSubmitClaim(tokenHash, walletAddress);

        if (!lockResult.success) {
            if (lockResult.error === 'Claim not found or expired') {
                console.warn('[SECURITY] Claim token not found in database');
                await db.logSecurityEvent('claim_not_found', null, {
                    tokenHash: tokenHash.substring(0, 16),
                    walletAddress
                });
            }
            return { success: false, error: lockResult.error };
        }

        const claim = lockResult.claim;

        // Verify token data matches claim (defense in depth)
        if (claim.round_id !== tokenData.roundId) {
            console.warn('[SECURITY] Token round ID mismatch');
            await db.logSecurityEvent('token_mismatch', null, {
                claimRoundId: claim.round_id,
                tokenRoundId: tokenData.roundId
            });
            // Revert the claim status since validation failed
            await db.updateClaimStatus(claim.id, 'eligible');
            return { success: false, error: 'Invalid claim token' };
        }

        console.log(`[REWARD] Wallet submitted for claim ${claim.round_id}: ${walletAddress}`);

        // INSTANT PAYOUT - Send SOL immediately instead of queuing
        try {
            const prizeBalance = await wallet.getPrizePoolWalletBalance();
            let payoutAmount = Math.min(parseFloat(claim.prize_amount_sol), prizeBalance - WALLET_RESERVE_SOL);

            // Cap at maximum for safety
            if (payoutAmount > MAX_PAYOUT_SOL) {
                console.log(`[REWARD] Capping payout from ${payoutAmount} to ${MAX_PAYOUT_SOL} SOL`);
                payoutAmount = MAX_PAYOUT_SOL;
            }

            if (payoutAmount >= MIN_PRIZE_SOL) {
                console.log(`[REWARD] Processing instant payout: ${payoutAmount} SOL to ${walletAddress}`);

                const signature = await wallet.sendPrizeToWinner(walletAddress, payoutAmount);
                await db.completeClaimPayout(claim.id, signature, payoutAmount);

                console.log(`[REWARD] Instant payout complete: ${signature}`);

                return {
                    success: true,
                    claim: {
                        roundId: claim.round_id,
                        amount: payoutAmount,
                        status: 'paid',
                        txSignature: signature
                    }
                };
            } else {
                console.warn(`[REWARD] Prize too low for instant payout: ${payoutAmount} SOL (min: ${MIN_PRIZE_SOL})`);
            }
        } catch (payoutError) {
            console.error(`[REWARD] Instant payout failed, will retry via queue:`, payoutError.message);
            // Fall through to return queued status - cron will retry
        }

        return {
            success: true,
            claim: {
                roundId: claim.round_id,
                amount: parseFloat(claim.prize_amount_sol),
                status: 'queued'
            }
        };
    } catch (e) {
        console.error('[REWARD] Submit wallet error:', e.message);
        return { success: false, error: 'Server error' };
    }
}

/**
 * Legacy session-based claim - DEPRECATED but still functional during transition
 * @deprecated Use submitWalletForClaim with claimToken instead
 * Session-based claims are less secure than token-based claims.
 * This function logs a security warning but still processes the claim.
 */
async function submitWalletForClaimBySession(sessionId, walletAddress) {
    // SECURITY (H-2): Log warning for legacy claims - helps track migration
    console.warn('[SECURITY] Legacy session-based claim used - client should upgrade to token-based claims');
    await db.logSecurityEvent('legacy_claim_warning', null, {
        sessionId: sessionId ? sessionId.substring(0, 16) + '...' : 'none',
        walletAddress,
        recommendation: 'Upgrade client to use claimToken'
    });

    // Still process the claim (soft block - log but allow)
    if (!wallet.validateSolanaAddress(walletAddress)) {
        return { success: false, error: 'Invalid Solana address' };
    }

    try {
        const claim = await db.getClaimBySession(sessionId);

        if (!claim) {
            return { success: false, error: 'No eligible claim found or claim expired' };
        }

        if (claim.claim_status !== 'eligible') {
            return { success: false, error: 'Claim already processed' };
        }

        const updated = await db.updateClaimWallet(claim.id, walletAddress);

        if (!updated) {
            return { success: false, error: 'Failed to update claim' };
        }

        console.log(`[REWARD] Wallet submitted for claim ${claim.round_id}: ${walletAddress}`);

        // INSTANT PAYOUT - Send SOL immediately instead of queuing
        try {
            const prizeBalance = await wallet.getPrizePoolWalletBalance();
            let payoutAmount = Math.min(parseFloat(claim.prize_amount_sol), prizeBalance - WALLET_RESERVE_SOL);

            // Cap at maximum for safety
            if (payoutAmount > MAX_PAYOUT_SOL) {
                console.log(`[REWARD] Capping payout from ${payoutAmount} to ${MAX_PAYOUT_SOL} SOL`);
                payoutAmount = MAX_PAYOUT_SOL;
            }

            if (payoutAmount >= MIN_PRIZE_SOL) {
                console.log(`[REWARD] Processing instant payout: ${payoutAmount} SOL to ${walletAddress}`);

                const signature = await wallet.sendPrizeToWinner(walletAddress, payoutAmount);
                await db.completeClaimPayout(claim.id, signature, payoutAmount);

                console.log(`[REWARD] Instant payout complete: ${signature}`);

                return {
                    success: true,
                    claim: {
                        roundId: claim.round_id,
                        amount: payoutAmount,
                        status: 'paid',
                        txSignature: signature
                    }
                };
            } else {
                console.warn(`[REWARD] Prize too low for instant payout: ${payoutAmount} SOL`);
            }
        } catch (payoutError) {
            console.error(`[REWARD] Instant payout failed, will retry via queue:`, payoutError.message);
        }

        return {
            success: true,
            claim: {
                roundId: claim.round_id,
                amount: parseFloat(claim.prize_amount_sol),
                status: 'queued'
            }
        };
    } catch (e) {
        console.error('[REWARD] Submit wallet error:', e.message);
        return { success: false, error: 'Server error' };
    }
}

/**
 * Process payout queue with database locking
 * SECURITY: Uses FOR UPDATE SKIP LOCKED to prevent race conditions
 */
async function processPayoutQueue() {
    if (isProcessingQueue) {
        console.log('[REWARD] Already processing queue, skipping');
        return;
    }
    isProcessingQueue = true;

    try {
        // Process one claim at a time with proper locking
        let processedCount = 0;
        const maxPerRun = 10;

        while (processedCount < maxPerRun) {
            // Get and lock a single claim atomically
            const claim = await db.getAndLockClaimForProcessing(PROCESSOR_ID);

            if (!claim) {
                // No more claims to process
                break;
            }

            try {
                // Check actual wallet balance
                const prizeBalance = await wallet.getPrizePoolWalletBalance();
                const payoutAmount = Math.min(parseFloat(claim.prize_amount_sol), prizeBalance - WALLET_RESERVE_SOL);

                if (payoutAmount < MIN_PRIZE_SOL) {
                    console.warn(`[REWARD] Prize too low (${payoutAmount} SOL) for claim ${claim.id} - min is ${MIN_PRIZE_SOL}`);
                    await db.releaseClaimLock(claim.id, 'Prize below minimum threshold');
                    continue;
                }

                // Send the prize
                const signature = await wallet.sendPrizeToWinner(claim.wallet_address, payoutAmount);

                // Complete the payout atomically
                await db.completeClaimPayout(claim.id, signature, payoutAmount);

                console.log(`[REWARD] Paid ${payoutAmount} SOL to ${claim.wallet_address}: ${signature}`);
                processedCount++;

            } catch (e) {
                console.error(`[REWARD] Payout failed for claim ${claim.id}:`, e.message);
                await db.releaseClaimLock(claim.id, e.message);
            }

            // Small delay between payouts to avoid RPC rate limits
            await new Promise(r => setTimeout(r, 1000));
        }

        if (processedCount > 0) {
            console.log(`[REWARD] Processed ${processedCount} payouts`);
        }
    } catch (e) {
        console.error('[REWARD] Queue processing error:', e.message);
    } finally {
        isProcessingQueue = false;
    }
}

async function refreshTokenMetadata() {
    if (!TOKEN_MINT) return null;

    try {
        const metadata = await helius.getTokenMetadata(TOKEN_MINT);

        if (metadata) {
            await db.saveTokenMetadata(
                TOKEN_MINT,
                metadata.name,
                metadata.symbol,
                metadata.image,
                metadata.description,
                metadata.supply
            );
            return metadata;
        }
    } catch (e) {
        console.error('[REWARD] Failed to refresh token metadata:', e.message);
    }

    return null;
}

async function getTokenInfo() {
    if (!TOKEN_MINT) {
        return { error: 'Token not configured' };
    }

    let metadata = await db.getTokenMetadata(TOKEN_MINT);

    if (!metadata || Date.now() - new Date(metadata.last_updated).getTime() > 300000) {
        metadata = await refreshTokenMetadata();
    }

    const prizePool = await db.getPrizePoolBalance();
    const recentPayouts = await db.getRecentPayouts(5);

    return {
        token: metadata,
        prizePool: prizePool,
        recentPayouts: recentPayouts.map(p => ({
            player: p.player_name,
            amount: parseFloat(p.amount_sol),
            round: p.round_id,
            date: p.completed_at
        }))
    };
}

async function getClaimStatus(roundId) {
    const claim = await db.getPendingClaim(roundId);
    if (!claim) return null;

    return {
        roundId: claim.round_id,
        playerName: claim.player_name,
        amount: parseFloat(claim.prize_amount_sol),
        status: claim.claim_status,
        walletAddress: claim.wallet_address ? `${claim.wallet_address.slice(0, 4)}...${claim.wallet_address.slice(-4)}` : null,
        txSignature: claim.tx_signature,
        expiresAt: claim.expires_at
    };
}

async function manualClaimFees() {
    return claimAndDistributeFees();
}

async function getPrizePoolStatus() {
    const dbBalance = await db.getPrizePoolBalance();
    const walletBalance = await wallet.getPrizePoolWalletBalance();

    return {
        databaseBalance: dbBalance,
        actualWalletBalance: walletBalance,
        walletAddress: wallet.getPrizePoolPublicKey(),
        discrepancy: Math.abs(dbBalance - walletBalance) > 0.0001 ?
            'WARNING: Database and wallet balance mismatch' : 'OK'
    };
}

/**
 * Force reconcile prize pool balance with actual wallet
 * Use with caution - only for fixing desync issues
 */
async function reconcilePrizePool() {
    const walletBalance = await wallet.getPrizePoolWalletBalance();
    await db.updatePrizePoolBalance(walletBalance);
    console.log(`[REWARD] Prize pool reconciled to ${walletBalance} SOL`);
    return { newBalance: walletBalance };
}

module.exports = {
    initialize,
    createWinnerClaim,
    submitWalletForClaim,
    submitWalletForClaimBySession, // Legacy support
    processPayoutQueue,
    claimAndDistributeFees,
    getTokenInfo,
    getClaimStatus,
    manualClaimFees,
    getPrizePoolStatus,
    refreshTokenMetadata,
    reconcilePrizePool
};
