/**
 * Wallet Service with security hardening and optimized transactions
 * SECURITY: Uses VersionedTransaction, priority fees, proper CU management
 */
const {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    LAMPORTS_PER_SOL,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram
} = require('@solana/web3.js');
const bs58 = require('bs58').default;
const helius = require('./helius');

// RPC Configuration
const HELIUS_RPC = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`;
const connection = new Connection(HELIUS_RPC, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000
});

// SECURITY: Wallet keys loaded from environment only - NO EXPORTS of raw keys
const WALLET_KEYS = {
    MASTER: process.env.MASTER_WALLET_PRIVATE_KEY,
    CREATOR: process.env.CREATOR_WALLET_ADDRESS,
    PRIZE_POOL: process.env.PRIZE_POOL_WALLET_PRIVATE_KEY,
    RESERVE: process.env.RESERVE_WALLET_PRIVATE_KEY
};

// Cache keypairs to avoid repeated decoding (still in memory, but not exported)
const keypairCache = new Map();

/**
 * Securely decode a private key and cache the keypair
 * @param {string} privateKeyBase58 - Base58 encoded private key
 * @returns {Keypair|null}
 */
function getKeypairFromPrivateKey(privateKeyBase58) {
    if (!privateKeyBase58) return null;

    // Check cache first
    const cacheKey = privateKeyBase58.substring(0, 8); // Use prefix as cache key
    if (keypairCache.has(cacheKey)) {
        return keypairCache.get(cacheKey);
    }

    try {
        const decoded = bs58.decode(privateKeyBase58);
        const keypair = Keypair.fromSecretKey(decoded);
        keypairCache.set(cacheKey, keypair);
        return keypair;
    } catch (e) {
        console.error('[WALLET] Invalid private key format');
        return null;
    }
}

/**
 * Validate a Solana address
 * @param {string} address - Address to validate
 * @returns {boolean}
 */
function validateSolanaAddress(address) {
    if (!address || typeof address !== 'string') return false;

    try {
        const pubkey = new PublicKey(address);
        // Additional validation - must be on curve for normal accounts
        return PublicKey.isOnCurve(pubkey.toBytes()) &&
            address.length >= 32 &&
            address.length <= 44;
    } catch {
        return false;
    }
}

/**
 * Get wallet balance in SOL
 * @param {string} publicKeyString - Public key as string
 * @returns {Promise<number>}
 */
async function getWalletBalance(publicKeyString) {
    try {
        const publicKey = new PublicKey(publicKeyString);
        const balance = await connection.getBalance(publicKey);
        return balance / LAMPORTS_PER_SOL;
    } catch (e) {
        console.error('[WALLET] Error getting balance:', e.message);
        return 0;
    }
}

async function getMasterWalletBalance() {
    if (!WALLET_KEYS.MASTER) return 0;
    const keypair = getKeypairFromPrivateKey(WALLET_KEYS.MASTER);
    if (!keypair) return 0;
    return getWalletBalance(keypair.publicKey.toBase58());
}

async function getPrizePoolWalletBalance() {
    if (!WALLET_KEYS.PRIZE_POOL) return 0;
    const keypair = getKeypairFromPrivateKey(WALLET_KEYS.PRIZE_POOL);
    if (!keypair) return 0;
    return getWalletBalance(keypair.publicKey.toBase58());
}

/**
 * Estimate compute units for a transaction by simulation
 * @param {VersionedTransaction} transaction - Transaction to simulate
 * @returns {Promise<number>} Estimated CU
 */
async function estimateComputeUnits(transaction) {
    try {
        const simulation = await connection.simulateTransaction(transaction, {
            replaceRecentBlockhash: true,
            sigVerify: false
        });

        if (simulation.value.err) {
            console.warn('[WALLET] Simulation error:', simulation.value.err);
            return 200000; // Default CU limit
        }

        // Add 20% buffer to estimated CU
        const estimatedCU = simulation.value.unitsConsumed || 200000;
        return Math.min(Math.ceil(estimatedCU * 1.2), 400000);
    } catch (e) {
        console.warn('[WALLET] CU estimation failed:', e.message);
        return 200000; // Default
    }
}

/**
 * Get dynamic priority fee based on network conditions
 * @param {string[]} accountKeys - Account public keys involved in transaction
 * @returns {Promise<number>} Priority fee in micro-lamports
 */
async function getDynamicPriorityFee(accountKeys) {
    try {
        const estimate = await helius.getPriorityFeeEstimate(accountKeys);
        // Cap at 100k micro-lamports to prevent excessive fees
        return Math.min(estimate, 100000);
    } catch (e) {
        console.warn('[WALLET] Priority fee estimation failed, using default');
        return 5000; // 5k micro-lamports default
    }
}

/**
 * Build an optimized VersionedTransaction with priority fees
 * @param {Keypair} payer - Transaction fee payer
 * @param {TransactionInstruction[]} instructions - Transaction instructions
 * @param {Object} options - Options
 * @returns {Promise<VersionedTransaction>}
 */
async function buildOptimizedTransaction(payer, instructions, options = {}) {
    const {
        computeUnitLimit = null,
        priorityFeeMultiplier = 1.0
    } = options;

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    // Get account keys for priority fee estimation
    const accountKeys = instructions
        .flatMap(ix => ix.keys.map(k => k.pubkey.toBase58()))
        .filter((v, i, a) => a.indexOf(v) === i); // Unique

    // Get dynamic priority fee
    const basePriorityFee = await getDynamicPriorityFee(accountKeys);
    const priorityFee = Math.ceil(basePriorityFee * priorityFeeMultiplier);

    // Build initial message to estimate CU if not provided
    let estimatedCU = computeUnitLimit;

    if (!estimatedCU) {
        // Build preliminary transaction for simulation
        const prelimMessage = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions: instructions
        }).compileToV0Message();

        const prelimTx = new VersionedTransaction(prelimMessage);
        prelimTx.sign([payer]);

        estimatedCU = await estimateComputeUnits(prelimTx);
    }

    // Build final instructions with compute budget
    const finalInstructions = [
        // Set compute unit limit
        ComputeBudgetProgram.setComputeUnitLimit({
            units: estimatedCU
        }),
        // Set priority fee (micro-lamports per CU)
        ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFee
        }),
        // Original instructions
        ...instructions
    ];

    // Build final message
    const messageV0 = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: finalInstructions
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);

    console.log(`[WALLET] Built tx: ${estimatedCU} CU, ${priorityFee} micro-lamports/CU`);

    return {
        transaction,
        blockhash,
        lastValidBlockHeight,
        estimatedCU,
        priorityFee
    };
}

/**
 * Send SOL with optimized transaction
 * SECURITY: Uses VersionedTransaction with proper CU limits and priority fees
 * @param {string} fromPrivateKey - Sender private key
 * @param {string} toAddress - Recipient address
 * @param {number} amountSol - Amount in SOL
 * @returns {Promise<string>} Transaction signature
 */
async function sendSol(fromPrivateKey, toAddress, amountSol) {
    const fromKeypair = getKeypairFromPrivateKey(fromPrivateKey);
    if (!fromKeypair) {
        throw new Error('Invalid sender private key');
    }

    if (!validateSolanaAddress(toAddress)) {
        throw new Error('Invalid recipient address');
    }

    const toPublicKey = new PublicKey(toAddress);
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    // Check balance with buffer for fees
    const balance = await connection.getBalance(fromKeypair.publicKey);
    const estimatedFee = 10000; // ~10k lamports for fees (conservative)

    if (balance < lamports + estimatedFee) {
        throw new Error(`Insufficient balance. Have: ${balance / LAMPORTS_PER_SOL} SOL, Need: ${amountSol} SOL + fees`);
    }

    // Build transfer instruction
    const transferInstruction = SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey: toPublicKey,
        lamports
    });

    // Build optimized transaction
    const { transaction, lastValidBlockHeight } = await buildOptimizedTransaction(
        fromKeypair,
        [transferInstruction],
        { computeUnitLimit: 300, priorityFeeMultiplier: 1.5 } // Simple transfer needs ~200 CU
    );

    // Sign transaction
    transaction.sign([fromKeypair]);

    // Send with retry logic
    let signature;
    let retries = 3;

    while (retries > 0) {
        try {
            signature = await connection.sendTransaction(transaction, {
                skipPreflight: false,
                maxRetries: 0, // We handle retries ourselves
                preflightCommitment: 'confirmed'
            });

            // Wait for confirmation
            const confirmation = await connection.confirmTransaction({
                signature,
                blockhash: transaction.message.recentBlockhash,
                lastValidBlockHeight
            }, 'confirmed');

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            console.log(`[WALLET] Transfer confirmed: ${signature}`);
            return signature;

        } catch (e) {
            retries--;
            if (retries === 0) {
                throw new Error(`Transaction failed after retries: ${e.message}`);
            }
            console.warn(`[WALLET] Retry ${3 - retries}/3: ${e.message}`);
            await new Promise(r => setTimeout(r, 2000)); // Wait 2s between retries
        }
    }

    throw new Error('Transaction failed - retries exhausted');
}

/**
 * Send prize to winner
 * @param {string} winnerAddress - Winner's wallet address
 * @param {number} amountSol - Amount in SOL
 * @returns {Promise<string>} Transaction signature
 */
async function sendPrizeToWinner(winnerAddress, amountSol) {
    if (!WALLET_KEYS.PRIZE_POOL) {
        throw new Error('Prize pool wallet not configured');
    }

    console.log(`[WALLET] Sending ${amountSol} SOL prize to: ${winnerAddress}`);
    return sendSol(WALLET_KEYS.PRIZE_POOL, winnerAddress, amountSol);
}

/**
 * Distribute claimed fees to creator, prize pool, and reserve
 * @param {number} totalAmountSol - Total amount to distribute
 * @returns {Promise<Object>} Distribution results
 */
async function distributeClaimedFees(totalAmountSol) {
    if (!WALLET_KEYS.MASTER) {
        throw new Error('Master wallet not configured');
    }

    const masterKeypair = getKeypairFromPrivateKey(WALLET_KEYS.MASTER);
    if (!masterKeypair) {
        throw new Error('Invalid master wallet');
    }

    // Distribution percentages
    const creatorShare = totalAmountSol * 0.90;
    const prizeShare = totalAmountSol * 0.09;
    const reserveShare = totalAmountSol * 0.01;

    const prizePoolKeypair = WALLET_KEYS.PRIZE_POOL ? getKeypairFromPrivateKey(WALLET_KEYS.PRIZE_POOL) : null;
    const reserveKeypair = WALLET_KEYS.RESERVE ? getKeypairFromPrivateKey(WALLET_KEYS.RESERVE) : null;

    const results = {
        creator: null,
        prizePool: null,
        reserve: null
    };

    // Send to creator
    if (creatorShare > 0.0001 && WALLET_KEYS.CREATOR) {
        try {
            results.creator = await sendSol(WALLET_KEYS.MASTER, WALLET_KEYS.CREATOR, creatorShare);
            console.log(`[WALLET] Sent ${creatorShare} SOL to creator: ${results.creator}`);
        } catch (e) {
            console.error('[WALLET] Failed to send to creator:', e.message);
        }
    }

    // Send to prize pool
    if (prizeShare > 0.0001 && prizePoolKeypair) {
        try {
            results.prizePool = await sendSol(WALLET_KEYS.MASTER, prizePoolKeypair.publicKey.toBase58(), prizeShare);
            console.log(`[WALLET] Sent ${prizeShare} SOL to prize pool: ${results.prizePool}`);
        } catch (e) {
            console.error('[WALLET] Failed to send to prize pool:', e.message);
        }
    }

    // Send to reserve
    if (reserveShare > 0.0001 && reserveKeypair) {
        try {
            results.reserve = await sendSol(WALLET_KEYS.MASTER, reserveKeypair.publicKey.toBase58(), reserveShare);
            console.log(`[WALLET] Sent ${reserveShare} SOL to reserve: ${results.reserve}`);
        } catch (e) {
            console.error('[WALLET] Failed to send to reserve:', e.message);
        }
    }

    return {
        totalClaimed: totalAmountSol,
        creatorShare,
        prizeShare,
        reserveShare,
        signatures: results
    };
}

/**
 * Get public keys (safe to expose)
 */
function getMasterPublicKey() {
    if (!WALLET_KEYS.MASTER) return null;
    const keypair = getKeypairFromPrivateKey(WALLET_KEYS.MASTER);
    return keypair ? keypair.publicKey.toBase58() : null;
}

function getPrizePoolPublicKey() {
    if (!WALLET_KEYS.PRIZE_POOL) return null;
    const keypair = getKeypairFromPrivateKey(WALLET_KEYS.PRIZE_POOL);
    return keypair ? keypair.publicKey.toBase58() : null;
}

function getReservePublicKey() {
    if (!WALLET_KEYS.RESERVE) return null;
    const keypair = getKeypairFromPrivateKey(WALLET_KEYS.RESERVE);
    return keypair ? keypair.publicKey.toBase58() : null;
}

/**
 * Check if wallets are configured
 */
function getWalletStatus() {
    return {
        master: !!WALLET_KEYS.MASTER,
        creator: !!WALLET_KEYS.CREATOR,
        prizePool: !!WALLET_KEYS.PRIZE_POOL,
        reserve: !!WALLET_KEYS.RESERVE
    };
}

module.exports = {
    connection,
    validateSolanaAddress,
    getWalletBalance,
    getMasterWalletBalance,
    getPrizePoolWalletBalance,
    sendSol,
    sendPrizeToWinner,
    distributeClaimedFees,
    getMasterPublicKey,
    getPrizePoolPublicKey,
    getReservePublicKey,
    getWalletStatus,
    buildOptimizedTransaction,
    getDynamicPriorityFee
    // SECURITY: Do NOT export WALLET_KEYS or keypairs
};
