const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const rewardService = require('./services/rewardService');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize reward service
rewardService.initialize().catch(console.error);

// ============================================================================
// GAME CONSTANTS - Tuned for fast-paced competitive play
// ============================================================================
const ARENA_SIZE = 2000;
const SHRINK_INTERVAL = 18000;  // 18 seconds between shrinks
const SHRINK_AMOUNT = 120;      // Moderate shrink amounts
const MIN_ARENA_SIZE = 300;
const ROUND_INTERMISSION = 30000; // 30 seconds between rounds
const TICK_RATE = 30;
const TICK_MS = 1000 / TICK_RATE;
const ROUND_DURATION = 120000;  // 2 minutes max round time

// ============================================================================
// BULLET OBJECT POOL - Zero allocation during gameplay
// ============================================================================
const BULLET_POOL_SIZE = 500;
const bulletPool = {
    pool: [],
    activeList: [],
    nextId: 0,

    init() {
        for (let i = 0; i < BULLET_POOL_SIZE; i++) {
            this.pool.push({
                active: false,
                id: 0,
                ownerId: null,
                ownerName: '',
                x: 0,
                y: 0,
                vx: 0,
                vy: 0,
                color: '#ffff00'
            });
        }
    },

    acquire(ownerId, ownerName, x, y, vx, vy, color) {
        for (let i = 0; i < BULLET_POOL_SIZE; i++) {
            const bullet = this.pool[i];
            if (!bullet.active) {
                bullet.active = true;
                bullet.id = this.nextId++;
                bullet.ownerId = ownerId;
                bullet.ownerName = ownerName;
                bullet.x = x;
                bullet.y = y;
                bullet.vx = vx;
                bullet.vy = vy;
                bullet.color = color;
                this.activeList.push(bullet);
                return bullet;
            }
        }
        return null; // Pool exhausted
    },

    release(bullet) {
        bullet.active = false;
        const idx = this.activeList.indexOf(bullet);
        if (idx !== -1) {
            this.activeList.splice(idx, 1);
        }
    },

    getActive() {
        return this.activeList;
    },

    clear() {
        for (const bullet of this.activeList) {
            bullet.active = false;
        }
        this.activeList.length = 0;
    }
};

bulletPool.init();

// ============================================================================
// PLAYER ID GENERATION - Simple incrementing counter, not UUID
// ============================================================================
let playerIdCounter = 0;
function generatePlayerId() {
    return `p${++playerIdCounter}`;
}

function generateSessionId() {
    return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// GAME STATE
// ============================================================================
let leaderboard = {};
let recentWinners = [];

let gameState = {
    players: {},
    arenaSize: ARENA_SIZE,
    phase: 'waiting',
    winner: null,
    minPlayers: 2,
    roundNumber: 0,
    nextRoundTime: null,
    roundStartTime: null,
    tick: 0
};

// ============================================================================
// CLAUDE AI COMMENTARY
// ============================================================================
const CLAUDE_MESSAGES = {
    join: [
        "Welcome to the arena, {player}. Try not to disappoint me.",
        "{player} has entered. The odds shift ever so slightly.",
        "Ah, {player}. Another challenger approaches."
    ],
    kill: [
        "{killer} has eliminated {victim}. {remaining} remain.",
        "{victim} has been deleted by {killer}. {remaining} contestants left.",
        "{killer} sends {victim} to the void. {remaining} still breathing."
    ],
    shrink: [
        "I grow impatient. The arena shrinks.",
        "Too slow. The walls close in.",
        "Time is a luxury you cannot afford."
    ],
    warning: [
        "The arena will shrink in 10 seconds. Move to the center.",
        "Warning: Contraction imminent."
    ],
    finalTwo: [
        "Two remain. Let the final battle begin.",
        "We're down to two. One will fall."
    ],
    winner: [
        "{winner} stands victorious! {kills} kills this round.",
        "It is done. {winner} claims the crown with {kills} eliminations."
    ],
    taunt: [
        "Is that the best you can do?",
        "I expected more from you all.",
        "Entertaining... in a primitive sort of way."
    ],
    gameStart: [
        "ROUND {round} BEGINS! May the odds be ever in your favor.",
        "Round {round} - The arena is sealed. Fight!"
    ],
    waiting: [
        "Waiting for challengers... {count}/{min} players."
    ],
    intermission: [
        "Round over. Next round in {seconds} seconds.",
        "Prepare yourselves. Round {round} begins in {seconds} seconds."
    ],
    spectator: [
        "{player} is watching. Don't mess up."
    ]
};

function getRandomMessage(type, replacements = {}) {
    const messages = CLAUDE_MESSAGES[type];
    let msg = messages[Math.floor(Math.random() * messages.length)];
    for (const [key, value] of Object.entries(replacements)) {
        msg = msg.replace(`{${key}}`, value);
    }
    return msg;
}

// ============================================================================
// OPTIMIZED BROADCASTING - Minimal allocations
// ============================================================================
function broadcast(type, data) {
    const message = JSON.stringify({ t: type, ...data });
    for (const client of wss.clients) {
        if (client.readyState === 1) {
            client.send(message);
        }
    }
}

function sendToPlayer(ws, type, data) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify({ t: type, ...data }));
    }
}

// Pre-allocated state buffer for broadcasting
const stateBuffer = {
    p: [], // players
    b: [], // bullets
    a: 0,  // arenaSize
    ph: '', // phase
    r: 0,  // roundNumber
    tk: 0, // tick (not 't' - conflicts with message type!)
    pc: 0, // playerCount
    ac: 0, // aliveCount
    tr: 0, // timeRemaining (seconds)
    nr: 0, // nextRoundIn (seconds until next round)
    lp: [] // lobby players (names of waiting players)
};

function getLeaderboardData() {
    const entries = Object.values(leaderboard);
    entries.sort((a, b) => b.wins - a.wins || b.kills - a.kills);
    return entries.slice(0, 10);
}

function broadcastGameState() {
    // Reuse buffer arrays
    stateBuffer.p.length = 0;
    stateBuffer.b.length = 0;

    let aliveCount = 0;

    for (const id in gameState.players) {
        const p = gameState.players[id];
        stateBuffer.p.push({
            i: p.id,
            n: p.name,
            x: Math.round(p.x * 10) / 10,
            y: Math.round(p.y * 10) / 10,
            a: Math.round(p.angle * 100) / 100,
            h: p.health,
            v: p.alive ? 1 : 0,
            c: p.color,
            k: p.kills || 0
        });
        if (p.alive) aliveCount++;
    }

    const activeBullets = bulletPool.getActive();
    for (const b of activeBullets) {
        stateBuffer.b.push({
            i: b.id,
            x: Math.round(b.x),
            y: Math.round(b.y),
            vx: b.vx,
            vy: b.vy,
            c: b.color
        });
    }

    stateBuffer.a = gameState.arenaSize;
    stateBuffer.ph = gameState.phase;
    stateBuffer.r = gameState.roundNumber;
    stateBuffer.tk = gameState.tick;
    stateBuffer.pc = Object.keys(gameState.players).length;
    stateBuffer.ac = aliveCount;

    // Calculate time remaining
    if (gameState.phase === 'active' && gameState.roundStartTime) {
        const elapsed = Date.now() - gameState.roundStartTime;
        stateBuffer.tr = Math.max(0, Math.ceil((ROUND_DURATION - elapsed) / 1000));
    } else {
        stateBuffer.tr = 0;
    }

    // Calculate next round countdown (for waiting/ended phases)
    if (gameState.nextRoundTime && (gameState.phase === 'ended' || gameState.phase === 'waiting')) {
        stateBuffer.nr = Math.max(0, Math.ceil((gameState.nextRoundTime - Date.now()) / 1000));
    } else {
        stateBuffer.nr = 0;
    }

    // Build lobby player list (spectators and dead players waiting for next round)
    stateBuffer.lp = [];
    for (const id in gameState.players) {
        const p = gameState.players[id];
        if (!p.alive || gameState.phase === 'waiting' || gameState.phase === 'ended') {
            stateBuffer.lp.push(p.name);
        }
    }

    broadcast('s', stateBuffer); // 's' for state
}

// ============================================================================
// GAME LOGIC
// ============================================================================
function updateLeaderboard(playerId, playerName, won = false, kills = 0) {
    if (!leaderboard[playerId]) {
        leaderboard[playerId] = { name: playerName, wins: 0, kills: 0, gamesPlayed: 0 };
    }
    leaderboard[playerId].name = playerName;
    leaderboard[playerId].gamesPlayed++;
    leaderboard[playerId].kills += kills;
    if (won) {
        leaderboard[playerId].wins++;
    }
}

function checkWinner() {
    const players = Object.values(gameState.players);
    let aliveCount = 0;
    let lastAlive = null;

    for (const p of players) {
        if (p.alive) {
            aliveCount++;
            lastAlive = p;
        }
    }

    if (aliveCount === 2 && !gameState.finalTwoAnnounced) {
        gameState.finalTwoAnnounced = true;
        broadcast('c', { m: getRandomMessage('finalTwo') });
    }

    if (aliveCount === 1 && gameState.phase === 'active') {
        endRound(lastAlive);
    }

    if (aliveCount === 0 && gameState.phase === 'active') {
        endRound(null);
    }
}

async function endRound(winner) {
    gameState.phase = 'ended';
    bulletPool.clear();

    let winnerClaim = null;

    if (winner) {
        gameState.winner = winner.name;
        const kills = winner.kills || 0;

        updateLeaderboard(winner.id, winner.name, true, kills);

        recentWinners.unshift({
            name: winner.name,
            round: gameState.roundNumber,
            kills: kills,
            timestamp: Date.now()
        });
        if (recentWinners.length > 10) recentWinners.pop();

        // Create winner claim for SOL rewards
        try {
            winnerClaim = await rewardService.createWinnerClaim(
                gameState.roundNumber,
                winner.name,
                winner.sessionId || winner.id
            );
        } catch (e) {
            console.error('Failed to create winner claim:', e.message);
        }

        broadcast('c', { m: getRandomMessage('winner', { winner: winner.name, kills: kills }) });
        broadcast('re', {
            w: winner.name,
            wi: winner.id,
            k: kills,
            r: gameState.roundNumber,
            lb: getLeaderboardData(),
            claim: winnerClaim ? {
                roundId: winnerClaim.round_id,
                amount: parseFloat(winnerClaim.prize_amount_sol) || 0,
                expiresAt: winnerClaim.expires_at
            } : null
        });
    } else {
        broadcast('c', { m: "Everyone is dead. How disappointing." });
        broadcast('re', { w: null, r: gameState.roundNumber, lb: getLeaderboardData() });
    }

    for (const p of Object.values(gameState.players)) {
        if (p.id !== (winner ? winner.id : null)) {
            updateLeaderboard(p.id, p.name, false, p.kills || 0);
        }
    }

    gameState.nextRoundTime = Date.now() + ROUND_INTERMISSION;
    broadcast('c', { m: getRandomMessage('intermission', { seconds: ROUND_INTERMISSION / 1000, round: gameState.roundNumber + 1 }) });

    setTimeout(() => {
        if (Object.keys(gameState.players).length >= gameState.minPlayers) {
            startRound();
        } else {
            gameState.phase = 'waiting';
            broadcast('c', { m: getRandomMessage('waiting', { count: Object.keys(gameState.players).length, min: gameState.minPlayers }) });
        }
    }, ROUND_INTERMISSION);
}

function startRound() {
    gameState.roundNumber++;
    gameState.phase = 'active';
    gameState.arenaSize = ARENA_SIZE;
    gameState.finalTwoAnnounced = false;
    gameState.winner = null;
    gameState.nextRoundTime = null;
    gameState.roundStartTime = Date.now();
    bulletPool.clear();

    const players = Object.values(gameState.players);
    for (const p of players) {
        p.alive = true;
        p.health = 100;
        p.kills = 0;
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * (ARENA_SIZE / 2 - 100);
        p.x = ARENA_SIZE / 2 + Math.cos(angle) * dist;
        p.y = ARENA_SIZE / 2 + Math.sin(angle) * dist;
    }

    broadcast('c', { m: getRandomMessage('gameStart', { round: gameState.roundNumber }) });
    broadcast('rs', { r: gameState.roundNumber });

    // Start the dynamic shrink timer
    startShrinkTimer();
}

function tryStartGame() {
    const playerCount = Object.keys(gameState.players).length;
    if (gameState.phase === 'waiting' && playerCount >= gameState.minPlayers) {
        gameState.phase = 'starting';
        broadcast('c', { m: `Enough challengers! Round ${gameState.roundNumber + 1} starts in 5 seconds.` });
        setTimeout(() => {
            if (Object.keys(gameState.players).length >= gameState.minPlayers) {
                startRound();
            } else {
                gameState.phase = 'waiting';
            }
        }, 5000);
    }
}

// ============================================================================
// ARENA SHRINK - Dynamic scaling based on player count
// ============================================================================
let shrinkTimer = null;
let nextShrinkTime = 0;

function getDynamicShrinkInterval() {
    // Count alive players
    let alivePlayers = 0;
    for (const p of Object.values(gameState.players)) {
        if (p.alive) alivePlayers++;
    }

    // Scale shrink interval based on player count
    // 2-5 players: 18s base
    // 6-10 players: 22s
    // 11-20 players: 28s
    // 21-30 players: 35s
    // 30+ players: 45s
    if (alivePlayers <= 5) return 18000;
    if (alivePlayers <= 10) return 22000;
    if (alivePlayers <= 20) return 28000;
    if (alivePlayers <= 30) return 35000;
    return 45000;
}

function scheduleShrink() {
    if (shrinkTimer) clearTimeout(shrinkTimer);

    const interval = getDynamicShrinkInterval();
    nextShrinkTime = Date.now() + interval;

    shrinkTimer = setTimeout(() => {
        if (gameState.phase === 'active' && gameState.arenaSize > MIN_ARENA_SIZE) {
            broadcast('c', { m: getRandomMessage('warning') });

            setTimeout(() => {
                if (gameState.phase === 'active') {
                    gameState.arenaSize = Math.max(MIN_ARENA_SIZE, gameState.arenaSize - SHRINK_AMOUNT);
                    broadcast('c', { m: getRandomMessage('shrink') });
                    broadcast('as', { s: gameState.arenaSize });

                    // Schedule next shrink with updated interval
                    scheduleShrink();
                }
            }, 8000); // 8 second warning before shrink
        } else if (gameState.phase === 'active') {
            // Arena at min size, reschedule anyway
            scheduleShrink();
        }
    }, interval);
}

function startShrinkTimer() {
    scheduleShrink();
}

// Claude taunts
setInterval(() => {
    if (gameState.phase === 'active' && Math.random() < 0.3) {
        broadcast('c', { m: getRandomMessage('taunt') });
    }
}, 45000);

// ============================================================================
// WEBSOCKET CONNECTION HANDLING
// ============================================================================
const PLAYER_COLORS = ['#E07A5F', '#F4A261', '#E9C46A', '#2A9D8F', '#264653', '#9B5DE5', '#F15BB5', '#00BBF9'];

wss.on('connection', (ws) => {
    const odplayerId = generatePlayerId();
    const sessionId = generateSessionId();
    let registered = false;
    let lastInputSeq = 0;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            switch (msg.t) {
                case 'j': // join
                    const player = {
                        id: odplayerId,
                        sessionId: sessionId,
                        name: (msg.n || 'Anonymous').substring(0, 15),
                        x: ARENA_SIZE / 2 + (Math.random() - 0.5) * 400,
                        y: ARENA_SIZE / 2 + (Math.random() - 0.5) * 400,
                        angle: 0,
                        health: 100,
                        alive: gameState.phase === 'waiting' || gameState.phase === 'starting',
                        color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)],
                        kills: 0,
                        ws: ws
                    };

                    if (gameState.phase === 'active' || gameState.phase === 'ended') {
                        player.alive = false;
                        player.spectator = true;
                        broadcast('c', { m: getRandomMessage('spectator', { player: player.name }) });
                    }

                    gameState.players[odplayerId] = player;
                    registered = true;

                    sendToPlayer(ws, 'j', {
                        i: odplayerId,
                        sid: sessionId,
                        p: {
                            i: player.id,
                            n: player.name,
                            x: player.x,
                            y: player.y,
                            h: player.health,
                            v: player.alive ? 1 : 0,
                            c: player.color,
                            sp: player.spectator || false
                        },
                        lb: getLeaderboardData(),
                        rw: recentWinners.slice(0, 5),
                        ph: gameState.phase,
                        r: gameState.roundNumber
                    });

                    if (!player.spectator) {
                        broadcast('c', { m: getRandomMessage('join', { player: player.name }) });
                    }

                    tryStartGame();

                    if (gameState.phase === 'waiting') {
                        const playerCount = Object.keys(gameState.players).length;
                        broadcast('c', { m: getRandomMessage('waiting', { count: playerCount, min: gameState.minPlayers }) });
                    }
                    break;

                case 'm': // move
                    if (gameState.players[odplayerId] && gameState.players[odplayerId].alive) {
                        const p = gameState.players[odplayerId];

                        // Basic validation
                        const newX = Math.max(20, Math.min(ARENA_SIZE - 20, msg.x));
                        const newY = Math.max(20, Math.min(ARENA_SIZE - 20, msg.y));

                        // Speed check (allow some tolerance for network jitter)
                        const maxDist = 10; // ~2 frames worth at speed 5
                        const dist = Math.sqrt((newX - p.x) ** 2 + (newY - p.y) ** 2);

                        if (dist <= maxDist) {
                            p.x = newX;
                            p.y = newY;
                        } else {
                            // Teleport attempt, interpolate to valid position
                            const ratio = maxDist / dist;
                            p.x += (newX - p.x) * ratio;
                            p.y += (newY - p.y) * ratio;
                        }

                        p.angle = msg.a;

                        // Acknowledge input sequence for client prediction
                        if (msg.seq > lastInputSeq) {
                            lastInputSeq = msg.seq;
                            sendToPlayer(ws, 'ack', { seq: msg.seq, x: p.x, y: p.y });
                        }
                    }
                    break;

                case 'sh': // shoot
                    if (gameState.players[odplayerId] && gameState.players[odplayerId].alive) {
                        const shooter = gameState.players[odplayerId];
                        bulletPool.acquire(
                            odplayerId,
                            shooter.name,
                            shooter.x,
                            shooter.y,
                            Math.cos(shooter.angle) * 15,
                            Math.sin(shooter.angle) * 15,
                            shooter.color
                        );
                    }
                    break;

                case 'sp': // spectate
                    if (gameState.players[odplayerId]) {
                        gameState.players[odplayerId].spectateTarget = msg.ti;
                    }
                    break;
            }
        } catch (e) {
            // Silent fail for malformed messages
        }
    });

    ws.on('close', () => {
        if (registered && gameState.players[odplayerId]) {
            const player = gameState.players[odplayerId];
            broadcast('c', { m: `${player.name} has disconnected.` });
            delete gameState.players[odplayerId];
            checkWinner();
        }
    });
});

// ============================================================================
// AUTHORITATIVE GAME LOOP - 30 FPS
// ============================================================================
let lastTick = Date.now();

function gameLoop() {
    const now = Date.now();
    const delta = now - lastTick;

    if (delta >= TICK_MS) {
        lastTick = now - (delta % TICK_MS);
        gameState.tick++;

        // Update bullets
        const activeBullets = bulletPool.getActive();
        const toRemove = [];

        for (let i = activeBullets.length - 1; i >= 0; i--) {
            const bullet = activeBullets[i];

            bullet.x += bullet.vx;
            bullet.y += bullet.vy;

            // Out of bounds
            if (bullet.x < 0 || bullet.x > ARENA_SIZE || bullet.y < 0 || bullet.y > ARENA_SIZE) {
                toRemove.push(bullet);
                continue;
            }

            // Collision check
            for (const player of Object.values(gameState.players)) {
                if (player.id !== bullet.ownerId && player.alive) {
                    const dx = player.x - bullet.x;
                    const dy = player.y - bullet.y;
                    const distSq = dx * dx + dy * dy;

                    if (distSq < 625) { // 25^2
                        player.health -= 20;
                        toRemove.push(bullet);

                        if (player.health <= 0) {
                            player.alive = false;

                            const shooter = gameState.players[bullet.ownerId];
                            if (shooter) {
                                shooter.kills = (shooter.kills || 0) + 1;
                            }

                            let remaining = 0;
                            for (const p of Object.values(gameState.players)) {
                                if (p.alive) remaining++;
                            }

                            broadcast('c', {
                                m: getRandomMessage('kill', {
                                    killer: bullet.ownerName,
                                    victim: player.name,
                                    remaining: remaining
                                })
                            });
                            broadcast('k', {
                                kr: bullet.ownerName,
                                kri: bullet.ownerId,
                                v: player.name,
                                vi: player.id
                            });
                            checkWinner();
                        }
                        break;
                    }
                }
            }
        }

        for (const bullet of toRemove) {
            bulletPool.release(bullet);
        }

        // Storm damage - continuous damage when outside the circle
        if (gameState.phase === 'active') {
            const center = ARENA_SIZE / 2;
            const arenaRadius = gameState.arenaSize / 2;

            for (const p of Object.values(gameState.players)) {
                if (p.alive) {
                    const dist = Math.sqrt((p.x - center) ** 2 + (p.y - center) ** 2);
                    if (dist > arenaRadius) {
                        // Damage scales with how far outside (5-15 damage per second)
                        const outsideAmount = dist - arenaRadius;
                        const damagePerTick = Math.min(0.5, 0.15 + (outsideAmount / 500) * 0.35); // ~5-15 DPS
                        p.health -= damagePerTick;

                        if (p.health <= 0) {
                            p.alive = false;
                            p.health = 0;
                            broadcast('c', { m: `${p.name} was consumed by the storm!` });
                            broadcast('k', { kr: 'Storm', kri: null, v: p.name, vi: p.id });
                            checkWinner();
                        }
                    }
                }
            }
        }

        broadcastGameState();
    }

    setImmediate(gameLoop);
}

gameLoop();

// ============================================================================
// REWARD API ENDPOINTS
// ============================================================================

// Submit wallet address to claim prize
app.post('/api/rewards/claim', async (req, res) => {
    try {
        const { sessionId, walletAddress } = req.body;

        if (!sessionId || !walletAddress) {
            return res.status(400).json({ success: false, error: 'Missing sessionId or walletAddress' });
        }

        const result = await rewardService.submitWalletForClaim(sessionId, walletAddress);
        res.json(result);
    } catch (e) {
        console.error('Claim error:', e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// Get claim status
app.get('/api/rewards/status/:roundId', async (req, res) => {
    try {
        const status = await rewardService.getClaimStatus(req.params.roundId);
        if (!status) {
            return res.status(404).json({ error: 'Claim not found' });
        }
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get token metadata and prize pool info
app.get('/api/token/info', async (req, res) => {
    try {
        const info = await rewardService.getTokenInfo();
        res.json(info);
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get current prize pool status
app.get('/api/rewards/pool', async (req, res) => {
    try {
        const status = await rewardService.getPrizePoolStatus();
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin: Manual fee claim trigger (protected in production)
app.post('/api/admin/claim-fees', async (req, res) => {
    try {
        const result = await rewardService.manualClaimFees();
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================================
// SERVER START
// ============================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    CLAUDE ROYALE                          ║
║         High-Performance Battle Royale Server             ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                  ║
║  Tick Rate: ${TICK_RATE} FPS | Bullet Pool: ${BULLET_POOL_SIZE}             ║
║  Zero-allocation game loop initialized                    ║
╚═══════════════════════════════════════════════════════════╝
    `);
});
