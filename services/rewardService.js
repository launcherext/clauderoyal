const cron = require('node-cron');
const db = require('./database');
const wallet = require('./walletService');
const pumpportal = require('./pumpportal');
const helius = require('./helius');

const TOKEN_MINT = process.env.TOKEN_MINT_ADDRESS || '';
let isProcessingQueue = false;
let lastFeeClaimTime = 0;

async function initialize() {
    try {
        await db.initDatabase();
        console.log('Reward service database initialized');

        if (TOKEN_MINT) {
            await refreshTokenMetadata();
            pumpportal.connectWebSocket(TOKEN_MINT);
        }

        startAutoClaimCron();
        startPayoutProcessorCron();

        console.log('Reward service started');
        console.log('Master wallet:', wallet.getMasterPublicKey());
        console.log('Prize pool wallet:', wallet.getPrizePoolPublicKey());
        console.log('Reserve wallet:', wallet.getReservePublicKey());
    } catch (e) {
        console.error('Failed to initialize reward service:', e.message);
    }
}

function startAutoClaimCron() {
    cron.schedule('0 * * * *', async () => {
        console.log('Running hourly fee claim...');
        await claimAndDistributeFees();
    });
    console.log('Auto-claim cron scheduled (hourly)');
}

function startPayoutProcessorCron() {
    cron.schedule('*/5 * * * *', async () => {
        await processPayoutQueue();
    });
    console.log('Payout processor cron scheduled (every 5 min)');
}

async function claimAndDistributeFees() {
    const now = Date.now();
    if (now - lastFeeClaimTime < 300000) {
        console.log('Fee claim cooldown active');
        return null;
    }

    try {
        const claimResult = await pumpportal.claimCreatorFees(0.0001);

        if (!claimResult || !claimResult.signature) {
            console.log('No fees claimed or claim failed');
            return null;
        }

        lastFeeClaimTime = now;

        await new Promise(r => setTimeout(r, 5000));

        const masterBalance = await wallet.getMasterWalletBalance();
        console.log('Master wallet balance after claim:', masterBalance, 'SOL');

        if (masterBalance > 0.001) {
            const distribution = await wallet.distributeClaimedFees(masterBalance - 0.001);

            await db.logFeeClaim(
                distribution.totalClaimed,
                distribution.creatorShare,
                distribution.prizeShare,
                distribution.reserveShare,
                claimResult.signature
            );

            await db.addToPrizePool(distribution.prizeShare);

            console.log('Fees distributed:', distribution);
            return distribution;
        }

        return null;
    } catch (e) {
        console.error('Fee claim/distribution error:', e.message);
        return null;
    }
}

async function createWinnerClaim(roundNumber, playerName, sessionId) {
    try {
        const prizePoolBalance = await wallet.getPrizePoolWalletBalance();
        const prizeAmount = prizePoolBalance > 0.001 ? prizePoolBalance - 0.001 : 0;

        const roundId = `round-${roundNumber}-${Date.now()}`;

        const claim = await db.createPendingClaim(
            roundId,
            playerName,
            sessionId,
            prizeAmount
        );

        console.log(`Created claim for ${playerName}: ${prizeAmount} SOL`);
        return claim;
    } catch (e) {
        console.error('Failed to create winner claim:', e.message);
        return null;
    }
}

async function submitWalletForClaim(sessionId, walletAddress) {
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

        console.log(`Wallet submitted for claim ${claim.round_id}: ${walletAddress}`);

        return {
            success: true,
            claim: {
                roundId: claim.round_id,
                amount: claim.prize_amount_sol,
                status: 'queued'
            }
        };
    } catch (e) {
        console.error('Submit wallet error:', e.message);
        return { success: false, error: 'Server error' };
    }
}

async function processPayoutQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        const queuedClaims = await db.getQueuedClaims();

        for (const claim of queuedClaims) {
            try {
                await db.updateClaimStatus(claim.id, 'processing');

                const prizeBalance = await wallet.getPrizePoolWalletBalance();
                const payoutAmount = Math.min(claim.prize_amount_sol, prizeBalance - 0.001);

                if (payoutAmount < 0.001) {
                    await db.updateClaimStatus(claim.id, 'failed', null, 'Insufficient prize pool balance');
                    continue;
                }

                const signature = await wallet.sendPrizeToWinner(claim.wallet_address, payoutAmount);

                await db.updateClaimStatus(claim.id, 'paid', signature);
                await db.logPayout(claim.id, claim.wallet_address, payoutAmount, signature, 'completed');
                await db.subtractFromPrizePool(payoutAmount);

                console.log(`Paid ${payoutAmount} SOL to ${claim.wallet_address}: ${signature}`);
            } catch (e) {
                console.error(`Payout failed for claim ${claim.id}:`, e.message);
                await db.updateClaimStatus(claim.id, claim.attempts >= 2 ? 'failed' : 'queued', null, e.message);
            }
        }
    } catch (e) {
        console.error('Queue processing error:', e.message);
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
        console.error('Failed to refresh token metadata:', e.message);
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
            amount: p.amount_sol,
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
        amount: claim.prize_amount_sol,
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
        walletAddress: wallet.getPrizePoolPublicKey()
    };
}

module.exports = {
    initialize,
    createWinnerClaim,
    submitWalletForClaim,
    processPayoutQueue,
    claimAndDistributeFees,
    getTokenInfo,
    getClaimStatus,
    manualClaimFees,
    getPrizePoolStatus,
    refreshTokenMetadata
};
