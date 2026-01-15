const {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    SystemProgram,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction
} = require('@solana/web3.js');
const bs58 = require('bs58').default;

const HELIUS_RPC = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`;
const connection = new Connection(HELIUS_RPC, 'confirmed');

const WALLETS = {
    MASTER: process.env.MASTER_WALLET_PRIVATE_KEY,
    CREATOR: process.env.CREATOR_WALLET_ADDRESS,
    PRIZE_POOL: process.env.PRIZE_POOL_WALLET_PRIVATE_KEY,
    RESERVE: process.env.RESERVE_WALLET_PRIVATE_KEY
};

function getKeypairFromPrivateKey(privateKeyBase58) {
    try {
        const decoded = bs58.decode(privateKeyBase58);
        return Keypair.fromSecretKey(decoded);
    } catch (e) {
        console.error('Invalid private key format');
        return null;
    }
}

function validateSolanaAddress(address) {
    try {
        new PublicKey(address);
        return address.length >= 32 && address.length <= 44;
    } catch {
        return false;
    }
}

async function getWalletBalance(publicKeyString) {
    try {
        const publicKey = new PublicKey(publicKeyString);
        const balance = await connection.getBalance(publicKey);
        return balance / LAMPORTS_PER_SOL;
    } catch (e) {
        console.error('Error getting balance:', e.message);
        return 0;
    }
}

async function getMasterWalletBalance() {
    if (!WALLETS.MASTER) return 0;
    const keypair = getKeypairFromPrivateKey(WALLETS.MASTER);
    if (!keypair) return 0;
    return getWalletBalance(keypair.publicKey.toBase58());
}

async function getPrizePoolWalletBalance() {
    if (!WALLETS.PRIZE_POOL) return 0;
    const keypair = getKeypairFromPrivateKey(WALLETS.PRIZE_POOL);
    if (!keypair) return 0;
    return getWalletBalance(keypair.publicKey.toBase58());
}

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

    const balance = await connection.getBalance(fromKeypair.publicKey);
    if (balance < lamports + 5000) {
        throw new Error(`Insufficient balance. Have: ${balance / LAMPORTS_PER_SOL} SOL, Need: ${amountSol} SOL + fees`);
    }

    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: fromKeypair.publicKey,
            toPubkey: toPublicKey,
            lamports
        })
    );

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromKeypair.publicKey;

    const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [fromKeypair],
        { commitment: 'confirmed' }
    );

    return signature;
}

async function sendPrizeToWinner(winnerAddress, amountSol) {
    if (!WALLETS.PRIZE_POOL) {
        throw new Error('Prize pool wallet not configured');
    }
    console.log(`Sending ${amountSol} SOL to winner: ${winnerAddress}`);
    return sendSol(WALLETS.PRIZE_POOL, winnerAddress, amountSol);
}

async function distributeClaimedFees(totalAmountSol) {
    if (!WALLETS.MASTER) {
        throw new Error('Master wallet not configured');
    }
    const masterKeypair = getKeypairFromPrivateKey(WALLETS.MASTER);
    if (!masterKeypair) {
        throw new Error('Invalid master wallet');
    }

    const creatorShare = totalAmountSol * 0.90;
    const prizeShare = totalAmountSol * 0.09;
    const reserveShare = totalAmountSol * 0.01;

    const prizePoolKeypair = WALLETS.PRIZE_POOL ? getKeypairFromPrivateKey(WALLETS.PRIZE_POOL) : null;
    const reserveKeypair = WALLETS.RESERVE ? getKeypairFromPrivateKey(WALLETS.RESERVE) : null;

    const results = {
        creator: null,
        prizePool: null,
        reserve: null
    };

    try {
        if (creatorShare > 0.0001) {
            results.creator = await sendSol(WALLETS.MASTER, WALLETS.CREATOR, creatorShare);
            console.log(`Sent ${creatorShare} SOL to creator: ${results.creator}`);
        }
    } catch (e) {
        console.error('Failed to send to creator:', e.message);
    }

    try {
        if (prizeShare > 0.0001 && prizePoolKeypair) {
            results.prizePool = await sendSol(WALLETS.MASTER, prizePoolKeypair.publicKey.toBase58(), prizeShare);
            console.log(`Sent ${prizeShare} SOL to prize pool: ${results.prizePool}`);
        }
    } catch (e) {
        console.error('Failed to send to prize pool:', e.message);
    }

    try {
        if (reserveShare > 0.0001 && reserveKeypair) {
            results.reserve = await sendSol(WALLETS.MASTER, reserveKeypair.publicKey.toBase58(), reserveShare);
            console.log(`Sent ${reserveShare} SOL to reserve: ${results.reserve}`);
        }
    } catch (e) {
        console.error('Failed to send to reserve:', e.message);
    }

    return {
        totalClaimed: totalAmountSol,
        creatorShare,
        prizeShare,
        reserveShare,
        signatures: results
    };
}

function getMasterPublicKey() {
    if (!WALLETS.MASTER) return null;
    const keypair = getKeypairFromPrivateKey(WALLETS.MASTER);
    return keypair ? keypair.publicKey.toBase58() : null;
}

function getPrizePoolPublicKey() {
    if (!WALLETS.PRIZE_POOL) return null;
    const keypair = getKeypairFromPrivateKey(WALLETS.PRIZE_POOL);
    return keypair ? keypair.publicKey.toBase58() : null;
}

function getReservePublicKey() {
    if (!WALLETS.RESERVE) return null;
    const keypair = getKeypairFromPrivateKey(WALLETS.RESERVE);
    return keypair ? keypair.publicKey.toBase58() : null;
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
    WALLETS
};
