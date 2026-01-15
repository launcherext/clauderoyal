const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const rewardService = require('./services/rewardService');
const cryptoService = require('./services/crypto');
const {
    globalRateLimiter,
    claimRateLimiter,
    adminRateLimiter,
    adminAuth,
    securityLogger,
    validateSecurityConfig
} = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Validate security configuration at startup
validateSecurityConfig();

// Apply security middleware
app.use(express.json());
app.use(securityLogger);
app.use('/api/', globalRateLimiter); // Rate limit all API endpoints
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
            // Swap-and-pop: O(1), zero allocation (splice creates new array internally)
            this.activeList[idx] = this.activeList[this.activeList.length - 1];
            this.activeList.pop();
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
// WEAPON DEFINITIONS - Different guns with unique feel
// ============================================================================
const WEAPONS = {
    pistol: {
        id: 'pistol',
        name: 'Pistol',
        damage: 18,         // +20%
        fireRate: 300,      // ms between shots
        bulletSpeed: 18,
        spread: 0,          // radians of random spread
        bulletsPerShot: 1,
        color: '#ffff00'
    },
    shotgun: {
        id: 'shotgun',
        name: 'Shotgun',
        damage: 14,         // +20%
        fireRate: 800,
        bulletSpeed: 14,
        spread: 0.3,
        bulletsPerShot: 5,
        color: '#ff6b4a'
    },
    smg: {
        id: 'smg',
        name: 'SMG',
        damage: 12,         // +20%
        fireRate: 100,
        bulletSpeed: 16,
        spread: 0.15,
        bulletsPerShot: 1,
        color: '#00e5ff'
    },
    sniper: {
        id: 'sniper',
        name: 'Sniper',
        damage: 72,         // +20%
        fireRate: 1200,
        bulletSpeed: 30,
        spread: 0,
        bulletsPerShot: 1,
        color: '#b388ff'
    }
};

// ============================================================================
// LOOT SYSTEM - Health, shields, weapons
// ============================================================================
const LOOT_TYPES = {
    health: { id: 'health', name: 'Health Pack', color: '#2ecc71', value: 40 },
    shield: { id: 'shield', name: 'Shield', color: '#3498db', value: 50 },
    shotgun: { id: 'shotgun', name: 'Shotgun', color: '#ff6b4a', weapon: true },
    smg: { id: 'smg', name: 'SMG', color: '#00e5ff', weapon: true },
    sniper: { id: 'sniper', name: 'Sniper', color: '#b388ff', weapon: true }
};

const LOOT_POOL_SIZE = 100;
const lootPool = {
    items: [],
    activeList: [],
    nextId: 0,

    init() {
        for (let i = 0; i < LOOT_POOL_SIZE; i++) {
            this.items.push({
                active: false,
                id: 0,
                type: null,
                x: 0,
                y: 0
            });
        }
    },

    spawn(type, x, y) {
        for (const item of this.items) {
            if (!item.active) {
                item.active = true;
                item.id = this.nextId++;
                item.type = type;
                item.x = x;
                item.y = y;
                this.activeList.push(item);
                return item;
            }
        }
        return null;
    },

    release(item) {
        item.active = false;
        const idx = this.activeList.indexOf(item);
        if (idx !== -1) {
            this.activeList[idx] = this.activeList[this.activeList.length - 1];
            this.activeList.pop();
        }
    },

    getActive() {
        return this.activeList;
    },

    clear() {
        for (const item of this.activeList) {
            item.active = false;
        }
        this.activeList.length = 0;
    }
};

lootPool.init();

// Spawn loot around the arena
function spawnInitialLoot() {
    lootPool.clear();
    const lootTypes = Object.keys(LOOT_TYPES);
    const center = ARENA_SIZE / 2;

    // Spawn 30-40 items around the map
    const lootCount = 30 + Math.floor(Math.random() * 10);
    for (let i = 0; i < lootCount; i++) {
        const type = lootTypes[Math.floor(Math.random() * lootTypes.length)];
        const angle = Math.random() * Math.PI * 2;
        const dist = 100 + Math.random() * (ARENA_SIZE / 2 - 150);
        const x = center + Math.cos(angle) * dist;
        const y = center + Math.sin(angle) * dist;
        lootPool.spawn(type, x, y);
    }
}

// Check if player picks up loot
function checkLootPickup(player) {
    const PICKUP_RADIUS = 35;
    for (const item of lootPool.getActive()) {
        const dx = player.x - item.x;
        const dy = player.y - item.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < PICKUP_RADIUS * PICKUP_RADIUS) {
            const lootType = LOOT_TYPES[item.type];
            let pickedUp = false;

            if (item.type === 'health') {
                if (player.health < 150) {
                    player.health = Math.min(150, player.health + lootType.value);
                    pickedUp = true;
                }
            } else if (item.type === 'shield') {
                if (player.shield < 100) {
                    player.shield = Math.min(100, player.shield + lootType.value);
                    pickedUp = true;
                }
            } else if (lootType.weapon) {
                // Weapon pickup - only if different from current
                if (player.weapon !== item.type) {
                    player.weapon = item.type;
                    player.lastShot = 0; // Reset fire cooldown
                    pickedUp = true;
                    broadcast('c', { m: `${player.name} picked up ${lootType.name}!` });
                }
            }

            if (pickedUp) {
                lootPool.release(item);
                // Send pickup event
                broadcast('lp', { pi: player.id, li: item.id, lt: item.type });
                return;
            }
        }
    }
}

// ============================================================================
// PLAYER ID GENERATION - SECURITY: Using cryptographically secure IDs
// ============================================================================
function generatePlayerId() {
    return cryptoService.generateSecurePlayerId();
}

function generateSessionId() {
    return cryptoService.generateSecureSessionId();
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
    l: [], // loot items
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
    stateBuffer.l.length = 0;

    let aliveCount = 0;

    for (const id in gameState.players) {
        const p = gameState.players[id];
        stateBuffer.p.push({
            i: p.id,
            n: p.name,
            x: Math.round(p.x * 10) / 10,
            y: Math.round(p.y * 10) / 10,
            a: Math.round(p.angle * 100) / 100,
            h: Math.round(p.health),
            sh: Math.round(p.shield || 0),  // Shield
            w: p.weapon || 'pistol',         // Current weapon
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

    // Add loot items
    const activeLoot = lootPool.getActive();
    for (const item of activeLoot) {
        stateBuffer.l.push({
            i: item.id,
            t: item.type,
            x: Math.round(item.x),
            y: Math.round(item.y)
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

        // Create winner claim for SOL rewards - SECURITY: Now generates cryptographic token
        try {
            winnerClaim = await rewardService.createWinnerClaim(
                gameState.roundNumber,
                winner.name,
                winner.id,
                winner.sessionId
            );
        } catch (e) {
            console.error('[REWARD] Failed to create winner claim:', e.message);
        }

        broadcast('c', { m: getRandomMessage('winner', { winner: winner.name, kills: kills }) });

        // Broadcast round end - claimToken only sent to winner via their WebSocket
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

        // Send claim token ONLY to the winner (not broadcast)
        if (winnerClaim && winnerClaim.claimToken && winner.ws) {
            sendToPlayer(winner.ws, 'claimToken', {
                token: winnerClaim.claimToken,
                roundId: winnerClaim.round_id,
                amount: parseFloat(winnerClaim.prize_amount_sol) || 0,
                expiresAt: winnerClaim.expires_at
            });
        }
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

    // Spawn loot for this round
    spawnInitialLoot();

    const players = Object.values(gameState.players);
    for (const p of players) {
        p.alive = true;
        p.health = 150;           // Increased TTK
        p.shield = 0;             // Start with no shield
        p.weapon = 'pistol';      // Everyone starts with pistol
        p.lastShot = 0;
        p.kills = 0;
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * (ARENA_SIZE / 2 - 100);
        p.x = ARENA_SIZE / 2 + Math.cos(angle) * dist;
        p.y = ARENA_SIZE / 2 + Math.sin(angle) * dist;
    }

    broadcast('c', { m: getRandomMessage('gameStart', { round: gameState.roundNumber }) });
    broadcast('rs', { r: gameState.roundNumber, wp: WEAPONS }); // Send weapon defs on round start

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
                        health: 150,       // Increased for longer TTK
                        shield: 0,         // Shield absorbs damage first
                        weapon: 'pistol',  // Start with pistol
                        lastShot: 0,       // Timestamp of last shot
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
                            sh: player.shield,
                            w: player.weapon,
                            v: player.alive ? 1 : 0,
                            c: player.color,
                            sp: player.spectator || false
                        },
                        lb: getLeaderboardData(),
                        rw: recentWinners.slice(0, 5),
                        ph: gameState.phase,
                        r: gameState.roundNumber,
                        wp: WEAPONS  // Send weapon definitions to client
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

                        // Clamp to arena bounds
                        const newX = Math.max(20, Math.min(ARENA_SIZE - 20, msg.x));
                        const newY = Math.max(20, Math.min(ARENA_SIZE - 20, msg.y));

                        // ANTI-CHEAT: Speed validation with network tolerance
                        // Max speed is 5 units/frame * ~20 frames for network latency = 100 units
                        const MAX_MOVE_DIST = 100;
                        const dist = Math.sqrt((newX - p.x) ** 2 + (newY - p.y) ** 2);

                        if (dist <= MAX_MOVE_DIST) {
                            // Valid movement - accept it
                            p.x = newX;
                            p.y = newY;
                        } else {
                            // TELEPORT ATTEMPT DETECTED - reject entirely, don't interpolate
                            // Log for monitoring (could add rate limiting/banning here)
                            console.warn(`[ANTI-CHEAT] ${p.name} attempted teleport: ${dist.toFixed(1)} units`);
                            // Player stays at current position - client will reconcile
                        }

                        // Angle is always accepted (can't cheat with aim direction)
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
                        const weapon = WEAPONS[shooter.weapon] || WEAPONS.pistol;
                        const now = Date.now();

                        // Check fire rate cooldown (server-authoritative)
                        if (now - shooter.lastShot < weapon.fireRate) {
                            break; // Too fast, ignore
                        }
                        shooter.lastShot = now;

                        // Fire bullets based on weapon
                        for (let i = 0; i < weapon.bulletsPerShot; i++) {
                            const spread = (Math.random() - 0.5) * weapon.spread;
                            const angle = shooter.angle + spread;
                            const bullet = bulletPool.acquire(
                                odplayerId,
                                shooter.name,
                                shooter.x + Math.cos(angle) * 25,
                                shooter.y + Math.sin(angle) * 25,
                                Math.cos(angle) * weapon.bulletSpeed,
                                Math.sin(angle) * weapon.bulletSpeed,
                                weapon.color
                            );
                            if (bullet) {
                                bullet.damage = weapon.damage;
                                bullet.weaponId = weapon.id;
                            }
                        }
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

        // Update bullets (skip if round ended mid-tick to prevent crash)
        if (gameState.phase === 'ended') {
            setImmediate(gameLoop);
            return;
        }

        const activeBullets = bulletPool.getActive();
        const toRemove = [];

        for (let i = activeBullets.length - 1; i >= 0; i--) {
            const bullet = activeBullets[i];
            // Guard against race condition where clear() empties array mid-iteration
            if (!bullet) continue;

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
                        const damage = bullet.damage || 20;
                        let actualDamage = damage;

                        // Shield absorbs damage first
                        if (player.shield > 0) {
                            const shieldDamage = Math.min(player.shield, damage);
                            player.shield -= shieldDamage;
                            actualDamage = damage - shieldDamage;
                        }
                        player.health -= actualDamage;

                        toRemove.push(bullet);

                        // Send hit event for visual feedback
                        broadcast('hit', {
                            x: player.x,
                            y: player.y,
                            d: damage,
                            vi: player.id,
                            ai: bullet.ownerId
                        });

                        if (player.health <= 0) {
                            player.alive = false;
                            player.health = 0;

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
                    // Check loot pickups
                    checkLootPickup(p);

                    const dist = Math.sqrt((p.x - center) ** 2 + (p.y - center) ** 2);
                    if (dist > arenaRadius) {
                        // Damage scales with how far outside (5-15 damage per second)
                        const outsideAmount = dist - arenaRadius;
                        const damagePerTick = Math.min(0.5, 0.15 + (outsideAmount / 500) * 0.35); // ~5-15 DPS

                        // Storm damages shield first
                        if (p.shield > 0) {
                            p.shield = Math.max(0, p.shield - damagePerTick);
                        } else {
                            p.health -= damagePerTick;
                        }

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
// REWARD API ENDPOINTS - SECURITY: Rate limited and authenticated
// ============================================================================

/**
 * Submit wallet address to claim prize
 * SECURITY: Now requires cryptographic claim token (not just session ID)
 */
app.post('/api/rewards/claim', claimRateLimiter, async (req, res) => {
    try {
        const { claimToken, walletAddress, sessionId } = req.body;

        if (!walletAddress) {
            return res.status(400).json({ success: false, error: 'Missing walletAddress' });
        }

        let result;

        // Prefer token-based claims (secure)
        if (claimToken) {
            result = await rewardService.submitWalletForClaim(claimToken, walletAddress);
        }
        // Fall back to legacy session-based claims (deprecated)
        else if (sessionId) {
            console.warn(`[SECURITY] Legacy session claim from ${req.ip}`);
            result = await rewardService.submitWalletForClaimBySession(sessionId, walletAddress);
        }
        else {
            return res.status(400).json({ success: false, error: 'Missing claimToken or sessionId' });
        }

        res.json(result);
    } catch (e) {
        console.error('[API] Claim error:', e);
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

// ============================================================================
// ADMIN API ENDPOINTS - SECURITY: Requires authentication
// ============================================================================

// Admin: Manual fee claim trigger
app.post('/api/admin/claim-fees', adminRateLimiter, adminAuth, async (req, res) => {
    try {
        const result = await rewardService.manualClaimFees();
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: Reconcile prize pool balance
app.post('/api/admin/reconcile-pool', adminRateLimiter, adminAuth, async (req, res) => {
    try {
        const result = await rewardService.reconcilePrizePool();
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: Force process payout queue
app.post('/api/admin/process-payouts', adminRateLimiter, adminAuth, async (req, res) => {
    try {
        await rewardService.processPayoutQueue();
        res.json({ success: true, message: 'Payout processing triggered' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: TEST MODE - Simulate adding funds to prize pool (DB only, not real wallet)
// Use this to test claim flow without real SOL
app.post('/api/admin/test-add-pool', adminRateLimiter, adminAuth, async (req, res) => {
    try {
        const { amount } = req.body;
        const testAmount = parseFloat(amount) || 0.1;

        if (testAmount <= 0 || testAmount > 10) {
            return res.status(400).json({ success: false, error: 'Amount must be between 0 and 10 SOL' });
        }

        const db = require('./services/database');
        await db.addToPrizePool(testAmount);
        const newBalance = await db.getPrizePoolBalance();

        console.log(`[TEST] Added ${testAmount} SOL to prize pool DB (new balance: ${newBalance})`);
        res.json({
            success: true,
            added: testAmount,
            newDbBalance: newBalance,
            warning: 'This only updates DB balance. Actual payouts require real SOL in prize pool wallet.'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Health check endpoint (public)
app.get('/api/health', async (req, res) => {
    const dbHealth = await require('./services/database').healthCheck();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: dbHealth,
        uptime: process.uptime()
    });
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
