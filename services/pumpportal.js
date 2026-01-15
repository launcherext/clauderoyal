const https = require('https');
const WebSocket = require('ws');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

const PUMPPORTAL_LOCAL_API_URL = 'https://pumpportal.fun/api/trade-local';
const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';
const HELIUS_RPC = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`;

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
            }
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

                    // Deserialize, sign, and send the transaction
                    const txBuffer = Buffer.from(data, 'base64');
                    const tx = VersionedTransaction.deserialize(txBuffer);
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
