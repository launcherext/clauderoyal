# Claude Royale - Solana Reward System Architecture Plan

## Executive Summary

Integrate PumpFun creator rewards into Claude Royale so round winners receive SOL payouts. Winners paste their Solana wallet address (no wallet connection required).

### Reward Distribution
- **90%** - Kept by you (creator)
- **10%** - Prize pool for winners
  - **9%** - Paid to round winner
  - **1%** - Reserve to keep system operational

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLAUDE ROYALE REWARD SYSTEM                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │   PumpFun    │───▶│  PumpPortal  │───▶│   Treasury   │                   │
│  │   Trading    │    │   Auto-Claim │    │    Wallet    │                   │
│  │   Fees       │    │     API      │    │   (Master)   │                   │
│  └──────────────┘    └──────────────┘    └──────┬───────┘                   │
│                                                  │                           │
│                            ┌─────────────────────┼─────────────────────┐     │
│                            │                     │                     │     │
│                            ▼                     ▼                     ▼     │
│                     ┌──────────────┐      ┌──────────────┐      ┌──────────┐│
│                     │   Creator    │      │  Prize Pool  │      │ Reserve  ││
│                     │    (90%)     │      │    (9%)      │      │   (1%)   ││
│                     └──────────────┘      └──────┬───────┘      └──────────┘│
│                                                  │                           │
│                                                  ▼                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │  Game Round  │───▶│   Winner     │───▶│   Winner     │                   │
│  │    Ends      │    │   Declared   │    │   Payout     │                   │
│  └──────────────┘    └──────────────┘    └──────────────┘                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## State Diagrams

### 1. Game Round State Machine

```
                              ┌─────────────────┐
                              │                 │
                              │    WAITING      │◀──────────────────────┐
                              │  (Lobby Open)   │                       │
                              │                 │                       │
                              └────────┬────────┘                       │
                                       │                                │
                                       │ min_players >= 2               │
                                       ▼                                │
                              ┌─────────────────┐                       │
                              │                 │                       │
                              │    STARTING     │                       │
                              │  (15s Countdown)│                       │
                              │                 │                       │
                              └────────┬────────┘                       │
                                       │                                │
                                       │ countdown = 0                  │
                                       ▼                                │
                              ┌─────────────────┐                       │
                              │                 │                       │
                              │     ACTIVE      │                       │
                              │  (Game Running) │                       │
                              │                 │                       │
                              └────────┬────────┘                       │
                                       │                                │
                                       │ alive_players = 1              │
                                       ▼                                │
                              ┌─────────────────┐                       │
                              │                 │                       │
                              │     ENDED       │───────────────────────┘
                              │ (Winner Shown)  │    after 15s intermission
                              │                 │
                              └────────┬────────┘
                                       │
                                       │ winner exists
                                       ▼
                              ┌─────────────────┐
                              │                 │
                              │  CLAIM_OPEN     │
                              │ (24hr window)   │
                              │                 │
                              └─────────────────┘
```

### 2. Winner Claim State Machine

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WINNER CLAIM STATE MACHINE                           │
└─────────────────────────────────────────────────────────────────────────────┘

    ┌──────────────┐
    │              │
    │   ELIGIBLE   │  Winner declared, has 24 hours to claim
    │              │
    └──────┬───────┘
           │
           │ winner submits wallet address
           ▼
    ┌──────────────┐
    │              │
    │  VALIDATING  │  Validate Solana address format
    │              │
    └──────┬───────┘
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
┌─────────┐  ┌──────────┐
│ INVALID │  │  VALID   │
│ ADDRESS │  │ ADDRESS  │
└────┬────┘  └────┬─────┘
     │            │
     │            │ add to payout queue
     ▼            ▼
┌─────────┐  ┌──────────────┐
│  RETRY  │  │   QUEUED     │
│ (3 max) │  │  (Pending)   │
└─────────┘  └──────┬───────┘
                    │
                    │ cron job processes queue
                    ▼
             ┌──────────────┐
             │              │
             │  PROCESSING  │  Building & sending transaction
             │              │
             └──────┬───────┘
                    │
              ┌─────┴─────┐
              │           │
              ▼           ▼
       ┌──────────┐  ┌──────────┐
       │  FAILED  │  │   PAID   │
       │  (Retry) │  │ (Final)  │
       └──────────┘  └──────────┘
```

### 3. Creator Fee Claiming State Machine (Auto-Claim Service)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CREATOR FEE AUTO-CLAIM STATE MACHINE                      │
└─────────────────────────────────────────────────────────────────────────────┘

                         ┌─────────────────┐
                         │                 │
              ┌─────────▶│      IDLE       │◀─────────┐
              │          │  (Waiting)      │          │
              │          └────────┬────────┘          │
              │                   │                   │
              │                   │ cron trigger      │
              │                   │ (every 1 hour)    │
              │                   ▼                   │
              │          ┌─────────────────┐          │
              │          │                 │          │
              │          │    CHECKING     │          │
              │          │ (Query Balance) │          │
              │          │                 │          │
              │          └────────┬────────┘          │
              │                   │                   │
              │            ┌──────┴──────┐            │
              │            │             │            │
              │            ▼             ▼            │
              │     ┌───────────┐  ┌───────────┐      │
              │     │ NO FEES   │  │ FEES      │      │
              │     │ AVAILABLE │  │ AVAILABLE │      │
              │     └─────┬─────┘  └─────┬─────┘      │
              │           │              │            │
              └───────────┘              ▼            │
                                 ┌─────────────────┐  │
                                 │                 │  │
                                 │    CLAIMING     │  │
                                 │  (PumpPortal)   │  │
                                 │                 │  │
                                 └────────┬────────┘  │
                                          │           │
                                    ┌─────┴─────┐     │
                                    │           │     │
                                    ▼           ▼     │
                             ┌──────────┐ ┌──────────┐│
                             │  FAILED  │ │ SUCCESS  ││
                             │  (Retry) │ │(Distribute││
                             └────┬─────┘ └────┬─────┘│
                                  │            │      │
                                  │            ▼      │
                                  │   ┌─────────────┐ │
                                  │   │ DISTRIBUTING│ │
                                  │   │  (Split %)  │ │
                                  │   └──────┬──────┘ │
                                  │          │        │
                                  └──────────┴────────┘
```

### 4. Fund Distribution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         FUND DISTRIBUTION FLOW                               │
└─────────────────────────────────────────────────────────────────────────────┘

    CLAIMED FEES FROM PUMPFUN
              │
              │ Total: X SOL
              ▼
    ┌─────────────────────────────────────────┐
    │         TREASURY WALLET (MASTER)         │
    │         ════════════════════════         │
    │                                          │
    │  Receives all claimed creator fees       │
    │                                          │
    └────────────────────┬────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │ CREATOR  │   │  PRIZE   │   │ RESERVE  │
    │  WALLET  │   │   POOL   │   │  WALLET  │
    │   90%    │   │    9%    │   │    1%    │
    │          │   │          │   │          │
    │ 0.9X SOL │   │ 0.09X SOL│   │ 0.01X SOL│
    └──────────┘   └────┬─────┘   └──────────┘
                        │
                        │ on round end
                        ▼
                  ┌───────────┐
                  │  WINNER   │
                  │  WALLET   │
                  │ (100% of  │
                  │  pool)    │
                  └───────────┘
```

---

## API Integration Details

### PumpPortal Integration

#### 1. Auto-Claim Creator Fees (Lightning API)
```javascript
// POST https://pumpportal.fun/api/trade?api-key=YOUR_API_KEY
{
    "action": "collectCreatorFee",
    "priorityFee": 0.0001,
    "pool": "pump"  // Claims ALL pump.fun fees at once
}
```

#### 2. Real-Time Token Monitoring (WebSocket)
```javascript
// Connect to: wss://pumpportal.fun/api/data
// Subscribe to token trades for activity display
{
    "method": "subscribeTokenTrade",
    "keys": ["YOUR_TOKEN_MINT_ADDRESS"]
}
```

### Helius Integration

#### 1. Get Token Metadata (DAS API)
```javascript
// POST https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
{
    "jsonrpc": "2.0",
    "id": "claude-royale",
    "method": "getAsset",
    "params": {
        "id": "YOUR_TOKEN_MINT_ADDRESS"
    }
}
```

#### 2. Send SOL to Winner (via Helius RPC)
```javascript
// Use Helius RPC for reliable transaction submission
// Build transaction with @solana/web3.js
// Submit via Helius enhanced RPC for priority
```

#### 3. Get Priority Fee Estimates
```javascript
// POST https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "getPriorityFeeEstimate",
    "params": [{
        "accountKeys": ["DESTINATION_WALLET"],
        "options": { "recommended": true }
    }]
}
```

---

## Database Schema

```sql
-- Pending Winners (claimable prizes)
CREATE TABLE pending_claims (
    id SERIAL PRIMARY KEY,
    round_id VARCHAR(50) UNIQUE NOT NULL,
    player_name VARCHAR(100) NOT NULL,
    winner_session_id VARCHAR(100),
    prize_amount_sol DECIMAL(18,9),
    wallet_address VARCHAR(50),
    claim_status VARCHAR(20) DEFAULT 'eligible',
    -- eligible, validating, queued, processing, paid, expired, failed
    attempts INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours',
    claimed_at TIMESTAMP,
    tx_signature VARCHAR(100),
    error_message TEXT
);

-- Fee Collection Log
CREATE TABLE fee_claims (
    id SERIAL PRIMARY KEY,
    claimed_at TIMESTAMP DEFAULT NOW(),
    total_claimed_sol DECIMAL(18,9),
    creator_share_sol DECIMAL(18,9),      -- 90%
    prize_pool_share_sol DECIMAL(18,9),   -- 9%
    reserve_share_sol DECIMAL(18,9),      -- 1%
    tx_signature VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending'
);

-- Prize Pool Balance Tracking
CREATE TABLE prize_pool (
    id SERIAL PRIMARY KEY,
    balance_sol DECIMAL(18,9) DEFAULT 0,
    last_updated TIMESTAMP DEFAULT NOW()
);

-- Payout History
CREATE TABLE payouts (
    id SERIAL PRIMARY KEY,
    claim_id INT REFERENCES pending_claims(id),
    wallet_address VARCHAR(50) NOT NULL,
    amount_sol DECIMAL(18,9) NOT NULL,
    tx_signature VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Token Metadata Cache
CREATE TABLE token_metadata (
    id SERIAL PRIMARY KEY,
    mint_address VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100),
    symbol VARCHAR(20),
    image_url TEXT,
    description TEXT,
    total_supply DECIMAL(30,9),
    last_updated TIMESTAMP DEFAULT NOW()
);
```

---

## Implementation Phases

### Phase 1: Core Infrastructure
1. Set up environment variables for API keys
2. Create database tables
3. Implement wallet management service
4. Create PumpPortal integration module

### Phase 2: Auto-Claim Service
1. Implement cron job for hourly fee claiming
2. Build fee distribution logic (90/9/1 split)
3. Create claim logging and monitoring

### Phase 3: Winner Payout System
1. Add wallet submission UI to game client
2. Build address validation service
3. Implement payout queue processor
4. Add transaction confirmation handling

### Phase 4: Token Display
1. Integrate Helius DAS API for metadata
2. Create token info component for frontend
3. Add real-time price/activity via WebSocket

---

## Security Considerations

1. **Private Keys**: Store in environment variables, never in code
2. **Address Validation**: Strict Solana address format validation
3. **Rate Limiting**: Prevent spam wallet submissions
4. **Claim Window**: 24-hour expiry prevents abandoned claims
5. **Transaction Monitoring**: Log all payouts with signatures

---

## Environment Variables Needed

```env
# PumpPortal
PUMPPORTAL_API_KEY=your_api_key

# Helius
HELIUS_API_KEY=your_api_key
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Wallets (Base58 private keys)
TREASURY_WALLET_PRIVATE_KEY=your_private_key
CREATOR_WALLET_ADDRESS=your_public_address

# Token
TOKEN_MINT_ADDRESS=your_token_mint

# Database
DATABASE_URL=postgresql://postgres:NajctWeCLYaSywSNHKxkWElcSbTsDSPc@caboose.proxy.rlwy.net:58182/railway
```

---

## File Structure (New Files)

```
claude-royale/
├── server.js                    # (modify) Add reward endpoints
├── services/
│   ├── rewardService.js         # Core reward logic
│   ├── pumpportal.js            # PumpPortal API wrapper
│   ├── helius.js                # Helius API wrapper
│   ├── walletService.js         # SOL transfer logic
│   └── claimProcessor.js        # Cron job for payouts
├── routes/
│   └── rewards.js               # REST API endpoints
├── public/
│   ├── game.js                  # (modify) Add claim UI
│   └── components/
│       ├── claimModal.js        # Winner claim modal
│       └── tokenInfo.js         # Token metadata display
└── migrations/
    └── 001_rewards_tables.sql   # Database migrations
```

---

## API Endpoints (New)

```
POST   /api/rewards/claim          # Submit wallet address for claim
GET    /api/rewards/status/:roundId # Check claim status
GET    /api/token/metadata         # Get token metadata for display
GET    /api/token/activity         # Get recent trading activity
POST   /api/admin/claim-fees       # Manual trigger fee claim (protected)
GET    /api/admin/prize-pool       # Check current prize pool balance
```

---

## Frontend Flow (Winner Experience)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           WINNER CLAIM UI FLOW                               │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │                         GAME END SCREEN                                  │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │                                                                   │  │
  │  │                    🏆 WINNER: PlayerName 🏆                       │  │
  │  │                                                                   │  │
  │  │              Prize Available: 0.05 SOL                           │  │
  │  │                                                                   │  │
  │  │  ┌─────────────────────────────────────────────────────────────┐ │  │
  │  │  │  Enter your Solana wallet address to claim:                 │ │  │
  │  │  │  ┌───────────────────────────────────────────────────────┐  │ │  │
  │  │  │  │                                                       │  │ │  │
  │  │  │  └───────────────────────────────────────────────────────┘  │ │  │
  │  │  │                    [ CLAIM PRIZE ]                          │ │  │
  │  │  └─────────────────────────────────────────────────────────────┘ │  │
  │  │                                                                   │  │
  │  │              Claim expires in: 23:59:45                          │  │
  │  │                                                                   │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  │                                                                         │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │  $CROYALE Token Info                                             │  │
  │  │  Price: $0.00123  |  24h Vol: $45,234  |  Holders: 1,234        │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
```

---

## Next Steps

1. **Confirm token mint address** - Need your Claude Royale token's mint address
2. **Set up PumpPortal API key** - Register at pumpportal.fun
3. **Set up Helius API key** - Register at helius.dev
4. **Create treasury wallet** - New Solana keypair for holding prize pool
5. **Begin implementation** - Start with Phase 1

Ready to proceed with implementation?
