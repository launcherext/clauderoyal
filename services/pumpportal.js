const https = require('https');
const WebSocket = require('ws');
const { Connection, Keypair, VersionedTransaction, PublicKey, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58').default;

const PUMPPORTAL_LOCAL_API_URL = 'https://pumpportal.fun/api/trade-local';
const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';
const HELIUS_RPC = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`;

// Known safe program IDs for pump.fun operations
// SECURITY: Only sign transactions that interact with these programs
const ALLOWED_PROGRAMS = [
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun program
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
    '11111111111111111111111111111111',              // System Program
    'ComputeBudget111111111111111111111111111111',   // Compute Budget
].map(addr => new PublicKey(addr));

/**
 * SECURITY: Verify transaction only contains allowed programs
 * Prevents blind signing of malicious transactions from external APIs
 * @param {VersionedTransaction} tx - Transaction to verify
 * @param {PublicKey} expectedSigner - Expected signer public key
 * @returns {{ valid: boolean, reason: string }}
 */
function verifyTransactionSafety(tx, expectedSigner) {
    try {
        const message = tx.message;
        const accountKeys = message.staticAccountKeys;

        // Check each instruction's program ID
        for (const ix of message.compiledInstructions) {
            const programId = accountKeys[ix.programIdIndex];
            const isAllowed = ALLOWED_PROGRAMS.some(allowed => allowed.equals(programId));

            if (!isAllowed) {
                return {
                    valid: false,
                    reason: `Unauthorized program: ${programId.toBase58()}`
                };
            }
        }

        // Verify the signer is who we expect
        const signerKey = accountKeys[0]; // First account is typically fee payer/signer
        if (!signerKey.equals(expectedSigner)) {
            return {
                valid: false,
                reason: `Unexpected signer: ${signerKey.toBase58()}, expected: ${expectedSigner.toBase58()}`
            };
        }

        // Check for suspicious SOL transfers to unknown addresses
        for (const ix of message.compiledInstructions) {
            const programId = accountKeys[ix.programIdIndex];

            // If it's a System Program transfer, verify recipient isn't draining us
            if (programId.equals(SystemProgram.programId)) {
                // System program instruction 2 = Transfer
                if (ix.data.length >= 12 && ix.data[0] === 2) {
                    // Decode lamports from instruction data (bytes 4-12)
                    const lamports = Buffer.from(ix.data.slice(4, 12)).readBigUInt64LE();
                    const solAmount = Number(lamports) / 1e9;

                    // Flag any transfer over 1 SOL as suspicious
                    if (solAmount > 1) {
                        const destIndex = ix.accountKeyIndexes[1];
                        const destKey = accountKeys[destIndex];
                        return {
                            valid: false,
                            reason: `Suspicious large transfer: ${solAmount} SOL to ${destKey.toBase58()}`
                        };
                    }
                }
            }
        }

        return { valid: true, reason: 'Transaction verified safe' };
    } catch (e) {
        return { valid: false, reason: `Verification error: ${e.message}` };
    }
}

let wsConnection = null;
let tradeCallbacks = [];

function getKeypairFromPrivateKey(privateKeyBase58) {
    try {
        const decoded = bs58.decode(privateKeyBase58);
        return Keypair.fromSecretKey(decoded);
    } catch (e) {
        return null;
    }
}

const HTTP_TIMEOUT_MS = 30000; // 30 second timeout for external API calls

async function claimCreatorFees(priorityFee = 0.0001) {
    const masterPrivateKey = process.env.MASTER_WALLET_PRIVATE_KEY;
    if (!masterPrivateKey) {
        console.log('Master wallet not configured for fee claiming');
        return null;
    }

    const keypair = getKeypairFromPrivateKey(masterPrivateKey);
    if (!keypair) {
        console.log('Invalid master wallet key');
        return null;
    }

    const payload = JSON.stringify({
        publicKey: keypair.publicKey.toBase58(),
        action: 'collectCreatorFee',
        priorityFee: priorityFee,
        pool: 'pump'
    });

    return new Promise((resolve, reject) => {
        const req = https.request(PUMPPORTAL_LOCAL_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: HTTP_TIMEOUT_MS // M-1 fix: Add timeout
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                try {
                    // Response is raw transaction bytes
                    if (res.statusCode !== 200) {
                        const errorData = JSON.parse(data);
                        console.log('PumpPortal error:', errorData.error || data);
                        resolve(null);
                        return;
                    }

                    // Deserialize the transaction
                    const txBuffer = Buffer.from(data, 'base64');
                    const tx = VersionedTransaction.deserialize(txBuffer);

                    // SECURITY (CU-2 fix): Verify transaction before signing
                    // Never blindly sign transactions from external APIs
                    const verification = verifyTransactionSafety(tx, keypair.publicKey);
                    if (!verification.valid) {
                        console.error('[SECURITY] BLOCKED MALICIOUS TRANSACTION:', verification.reason);
                        console.error('[SECURITY] Transaction rejected - potential wallet drain attempt');
                        resolve(null);
                        return;
                    }

                    console.log('[SECURITY] Transaction verified safe:', verification.reason);

                    // Now safe to sign
                    tx.sign([keypair]);

                    const connection = new Connection(HELIUS_RPC, 'confirmed');
                    const signature = await connection.sendTransaction(tx, {
                        skipPreflight: false,
                        maxRetries: 3
                    });

                    await connection.confirmTransaction(signature, 'confirmed');
                    console.log('Creator fees claimed:', signature);
                    resolve({ signature, success: true });
                } catch (e) {
                    // Might be JSON error response
                    try {
                        const errorData = JSON.parse(data);
                        console.log('No fees to claim:', errorData.error || 'Unknown');
                    } catch {
                        console.log('Fee claim error:', e.message);
                    }
                    resolve(null);
                }
            });
        });

        // M-1 fix: Handle timeout
        req.on('timeout', () => {
            console.error('[PUMPPORTAL] Request timeout after', HTTP_TIMEOUT_MS, 'ms');
            req.destroy();
            resolve(null);
        });

        req.on('error', (e) => {
            console.error('PumpPortal claim error:', e.message);
            resolve(null);
        });

        req.write(payload);
        req.end();
    });
}

function connectWebSocket(tokenMint = null) {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        return wsConnection;
    }

    wsConnection = new WebSocket(PUMPPORTAL_WS_URL);

    wsConnection.on('open', () => {
        console.log('Connected to PumpPortal WebSocket');

        if (tokenMint) {
            wsConnection.send(JSON.stringify({
                method: 'subscribeTokenTrade',
                keys: [tokenMint]
            }));
        }

        wsConnection.send(JSON.stringify({
            method: 'subscribeNewToken'
        }));
    });

    wsConnection.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());

            if (message.txType === 'buy' || message.txType === 'sell') {
                for (const callback of tradeCallbacks) {
                    callback(message);
                }
            }
        } catch (e) {
            // Ignore parse errors
        }
    });

    wsConnection.on('close', () => {
        console.log('PumpPortal WebSocket closed, reconnecting in 5s...');
        setTimeout(() => connectWebSocket(tokenMint), 5000);
    });

    wsConnection.on('error', (e) => {
        console.error('PumpPortal WebSocket error:', e.message);
    });

    return wsConnection;
}

function subscribeToTokenTrades(tokenMint) {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify({
            method: 'subscribeTokenTrade',
            keys: [tokenMint]
        }));
    }
}

function onTrade(callback) {
    tradeCallbacks.push(callback);
}

function disconnectWebSocket() {
    if (wsConnection) {
        wsConnection.close();
        wsConnection = null;
    }
}

module.exports = {
    claimCreatorFees,
    connectWebSocket,
    subscribeToTokenTrades,
    onTrade,
    disconnectWebSocket
};
