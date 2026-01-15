const https = require('https');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function rpcCall(method, params) {
    const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 'drop-zone',
        method,
        params
    });

    return new Promise((resolve, reject) => {
        const url = new URL(HELIUS_RPC_URL);

        const req = https.request({
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.error) {
                        reject(new Error(result.error.message));
                    } else {
                        resolve(result.result);
                    }
                } catch (e) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function getTokenMetadata(mintAddress) {
    try {
        const result = await rpcCall('getAsset', { id: mintAddress });

        if (!result) return null;

        return {
            mint: mintAddress,
            name: result.content?.metadata?.name || 'Unknown',
            symbol: result.content?.metadata?.symbol || '???',
            image: result.content?.links?.image || result.content?.files?.[0]?.uri || null,
            description: result.content?.metadata?.description || '',
            supply: result.supply?.print_current_supply || 0,
            decimals: result.token_info?.decimals || 9,
            price: result.token_info?.price_info?.price_per_token || 0,
            owner: result.ownership?.owner || null
        };
    } catch (e) {
        console.error('Error fetching token metadata:', e.message);
        return null;
    }
}

async function getTokenHolders(mintAddress, limit = 100) {
    try {
        const result = await rpcCall('getTokenAccounts', {
            mint: mintAddress,
            limit,
            displayOptions: { showZeroBalance: false }
        });
        return result?.token_accounts || [];
    } catch (e) {
        console.error('Error fetching token holders:', e.message);
        return [];
    }
}

async function getTransactionHistory(address, limit = 20) {
    try {
        const result = await rpcCall('getSignaturesForAddress', [
            address,
            { limit }
        ]);
        return result || [];
    } catch (e) {
        console.error('Error fetching transaction history:', e.message);
        return [];
    }
}

async function getPriorityFeeEstimate(accountKeys) {
    try {
        const result = await rpcCall('getPriorityFeeEstimate', [{
            accountKeys,
            options: { recommended: true }
        }]);
        return result?.priorityFeeEstimate || 1000;
    } catch (e) {
        console.log('Using default priority fee');
        return 1000;
    }
}

async function getBalance(address) {
    try {
        const result = await rpcCall('getBalance', [address]);
        return (result?.value || 0) / 1e9;
    } catch (e) {
        console.error('Error fetching balance:', e.message);
        return 0;
    }
}

module.exports = {
    getTokenMetadata,
    getTokenHolders,
    getTransactionHistory,
    getPriorityFeeEstimate,
    getBalance,
    rpcCall
};
