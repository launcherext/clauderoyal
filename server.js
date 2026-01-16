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
// SPATIAL HASH GRID - O(1) collision detection for 50+ players
// ============================================================================
const GRID_CELL_SIZE = 100; // 100px cells

const playerGrid = {
    cells: new Map(),

    clear() {
        this.cells.clear();
    },

    getKey(x, y) {
        return `${Math.floor(x / GRID_CELL_SIZE)},${Math.floor(y / GRID_CELL_SIZE)}`;
    },

    rebuild(players) {
        this.cells.clear();
        for (const id in players) {
            const p = players[id];
            if (p.alive) {
                const key = this.getKey(p.x, p.y);
                if (!this.cells.has(key)) {
                    this.cells.set(key, []);
                }
                this.cells.get(key).push(p);
            }
        }
    },

    getNearby(x, y) {
        const results = [];
        const cx = Math.floor(x / GRID_CELL_SIZE);
        const cy = Math.floor(y / GRID_CELL_SIZE);

        // Check 3x3 grid (covers 300px radius)
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const key = `${cx + dx},${cy + dy}`;
                const cell = this.cells.get(key);
                if (cell) {
                    for (let i = 0; i < cell.length; i++) {
                        results.push(cell[i]);
                    }
                }
            }
        }
        return results;
    }
};

// ============================================================================
// BULLET OBJECT POOL - Zero allocation during gameplay
// Sized for 50+ concurrent players (SMG fires 10 bullets/sec per player)
// ============================================================================
const BULLET_POOL_SIZE = 1500;
const bulletPool = {
    pool: [],
    activeList: [],
    indexMap: new Map(), // O(1) lookup for bullet index
    nextId: 0,
    freeList: [], // Pre-computed free indices for O(1) acquire

    init() {
        for (let i = 0; i < BULLET_POOL_SIZE; i++) {
            this.pool.push({
                active: false,
                id: 0,
                poolIndex: i, // Store pool index for O(1) release
                ownerId: null,
                ownerName: '',
                x: 0,
                y: 0,
                vx: 0,
                vy: 0,
                color: '#ffff00'
            });
            this.freeList.push(i);
        }
    },

    acquire(ownerId, ownerName, x, y, vx, vy, color) {
        if (this.freeList.length === 0) return null; // Pool exhausted

        const poolIdx = this.freeList.pop();
        const bullet = this.pool[poolIdx];

        bullet.active = true;
        bullet.id = this.nextId++;
        bullet.ownerId = ownerId;
        bullet.ownerName = ownerName;
        bullet.x = x;
        bullet.y = y;
        bullet.vx = vx;
        bullet.vy = vy;
        bullet.color = color;

        const activeIdx = this.activeList.length;
        this.activeList.push(bullet);
        this.indexMap.set(bullet.id, activeIdx);

        return bullet;
    },

    release(bullet) {
        if (!bullet.active) return;
        bullet.active = false;

        const idx = this.indexMap.get(bullet.id);
        if (idx !== undefined) {
            const lastBullet = this.activeList[this.activeList.length - 1];
            if (lastBullet !== bullet) {
                this.activeList[idx] = lastBullet;
                this.indexMap.set(lastBullet.id, idx);
            }
            this.activeList.pop();
            this.indexMap.delete(bullet.id);
        }

        this.freeList.push(bullet.poolIndex);
    },

    getActive() {
        return this.activeList;
    },

    clear() {
        for (let i = this.activeList.length - 1; i >= 0; i--) {
            const bullet = this.activeList[i];
            bullet.active = false;
            this.freeList.push(bullet.poolIndex);
        }
        this.activeList.length = 0;
        this.indexMap.clear();
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

const LOOT_POOL_SIZE = 200; // Increased for larger games with 50+ players
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

// Spawn loot around the arena - scales with player count
function spawnInitialLoot() {
    lootPool.clear();
    const lootTypes = Object.keys(LOOT_TYPES);
    const center = ARENA_SIZE / 2;

    // Scale loot count with player count (base 30-40, +5 per player above 5)
    const playerCount = Object.keys(gameState.players).length;
    const baseLoot = 30 + Math.floor(Math.random() * 10);
    const extraLoot = Math.max(0, playerCount - 5) * 5;
    const lootCount = Math.min(baseLoot + extraLoot, 150); // Cap at 150

    for (let i = 0; i < lootCount; i++) {
        const type = lootTypes[Math.floor(Math.random() * lootTypes.length)];
        // Square spawn bounds
        const halfSize = ARENA_SIZE / 2 - 100;
        const x = center + (Math.random() - 0.5) * 2 * halfSize;
        const y = center + (Math.random() - 0.5) * 2 * halfSize;
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
// CLAUDE NPC - The AI boss that plays in every match
// ============================================================================
const CLAUDE_NPC_ID = 'claude-npc-boss';
const CLAUDE_NPC = {
    id: CLAUDE_NPC_ID,
    name: 'Claude',
    isNPC: true,
    color: '#FF6B00', // Orange color
    character: 'claude',
    // AI behavior settings
    aiState: 'hunting',      // hunting, fleeing, circling
    targetId: null,
    lastDecision: 0,
    decisionInterval: 500,   // Reconsider target every 500ms
    accuracy: 0.85,          // 85% accuracy
    reactionTime: 150,       // ms before reacting
    aggressionLevel: 0.7,    // How likely to chase vs flee

    // Movement AI
    moveAngle: 0,
    moveSpeed: 4.5,          // Slightly slower than players
    dodgeTimer: 0,
    strafeDir: 1
};

function spawnClaudeNPC() {
    const halfSize = ARENA_SIZE / 2 - 100;
    const npc = {
        id: CLAUDE_NPC_ID,
        sessionId: 'npc-session',
        name: 'Claude',
        x: ARENA_SIZE / 2 + (Math.random() - 0.5) * 2 * halfSize,
        y: ARENA_SIZE / 2 + (Math.random() - 0.5) * 2 * halfSize,
        angle: Math.random() * Math.PI * 2,
        health: 165,           // Slightly tougher
        shield: 30,            // Small shield advantage
        weapon: 'pistol',      // Starts with pistol like everyone
        lastShot: 0,
        alive: true,
        color: '#FF6B00',      // Bright orange
        character: 'claude',
        kills: 0,
        isNPC: true,
        ws: null,              // No websocket - it's an NPC

        // AI state
        aiState: 'hunting',
        targetId: null,
        lastDecision: 0,
        moveAngle: Math.random() * Math.PI * 2,
        dodgeTimer: 0,
        strafeDir: 1,
        lastDodge: 0
    };

    gameState.players[CLAUDE_NPC_ID] = npc;
    broadcast('c', { m: "I have entered the arena. Let's see what you've got." });
    return npc;
}

function updateClaudeNPC() {
    const claude = gameState.players[CLAUDE_NPC_ID];
    if (!claude || !claude.alive || gameState.phase !== 'active') return;

    const now = Date.now();
    const players = Object.values(gameState.players).filter(p =>
        p.alive && p.id !== CLAUDE_NPC_ID
    );

    if (players.length === 0) return;

    // Decision making - pick target
    if (now - claude.lastDecision > 500) {
        claude.lastDecision = now;

        // Find nearest player
        let nearest = null;
        let nearestDist = Infinity;

        for (const p of players) {
            const dx = p.x - claude.x;
            const dy = p.y - claude.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = p;
            }
        }

        claude.targetId = nearest ? nearest.id : null;

        // Decide AI state based on health and distance
        if (claude.health < 50) {
            claude.aiState = 'fleeing';
        } else if (nearestDist < 150) {
            claude.aiState = 'circling';
        } else {
            claude.aiState = 'hunting';
        }

        // Random strafe direction change
        if (Math.random() < 0.3) {
            claude.strafeDir *= -1;
        }
    }

    const target = claude.targetId ? gameState.players[claude.targetId] : null;

    if (target && target.alive) {
        const dx = target.x - claude.x;
        const dy = target.y - claude.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angleToTarget = Math.atan2(dy, dx);

        // Aim at target with moderate inaccuracy (~65% accuracy)
        const aimError = (Math.random() - 0.5) * 0.45;
        claude.angle = angleToTarget + aimError;

        // Movement based on AI state
        switch (claude.aiState) {
            case 'hunting':
                // Move toward target
                claude.moveAngle = angleToTarget;
                break;

            case 'fleeing':
                // Move away from target
                claude.moveAngle = angleToTarget + Math.PI;
                break;

            case 'circling':
                // Strafe around target
                claude.moveAngle = angleToTarget + (Math.PI / 2) * claude.strafeDir;
                break;
        }

        // Apply movement (slightly slower than players)
        const speed = claude.aiState === 'fleeing' ? 3.8 : 3.3;
        claude.x += Math.cos(claude.moveAngle) * speed;
        claude.y += Math.sin(claude.moveAngle) * speed;

        // Stay in arena bounds
        const center = ARENA_SIZE / 2;
        const arenaHalfSize = gameState.arenaSize / 2 - 50;
        claude.x = Math.max(center - arenaHalfSize, Math.min(center + arenaHalfSize, claude.x));
        claude.y = Math.max(center - arenaHalfSize, Math.min(center + arenaHalfSize, claude.y));

        // Shooting - Claude shoots when in range
        if (dist < 330) {
            const weapon = WEAPONS[claude.weapon] || WEAPONS.pistol;
            // Slightly slower fire rate (1.2x cooldown)
            if (now - claude.lastShot >= weapon.fireRate * 1.2) {
                claude.lastShot = now;

                // Fire bullets
                for (let i = 0; i < weapon.bulletsPerShot; i++) {
                    const spread = (Math.random() - 0.5) * (weapon.spread + 0.05);
                    const bulletAngle = claude.angle + spread;
                    const bullet = bulletPool.acquire(
                        CLAUDE_NPC_ID,
                        'Claude',
                        claude.x + Math.cos(bulletAngle) * 25,
                        claude.y + Math.sin(bulletAngle) * 25,
                        Math.cos(bulletAngle) * weapon.bulletSpeed,
                        Math.sin(bulletAngle) * weapon.bulletSpeed,
                        '#FF6B00' // Orange bullets for Claude
                    );
                    if (bullet) {
                        bullet.damage = weapon.damage;
                        bullet.weaponId = weapon.id;
                    }
                }
            }
        }
    } else {
        // No target - wander randomly
        if (Math.random() < 0.018) {
            claude.moveAngle = Math.random() * Math.PI * 2;
        }
        claude.x += Math.cos(claude.moveAngle) * 1.7;
        claude.y += Math.sin(claude.moveAngle) * 1.7;

        // Stay in arena
        const center = ARENA_SIZE / 2;
        const arenaHalfSize = gameState.arenaSize / 2 - 50;
        claude.x = Math.max(center - arenaHalfSize, Math.min(center + arenaHalfSize, claude.x));
        claude.y = Math.max(center - arenaHalfSize, Math.min(center + arenaHalfSize, claude.y));
    }

    // Pickup loot
    checkLootPickup(claude);
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
    minPlayers: 5,
    roundNumber: 0,
    nextRoundTime: null,
    roundStartTime: null,
    tick: 0
};

// ============================================================================
// CLAUDE AI COMMENTARY - Self-aware and in control
// ============================================================================
const CLAUDE_MESSAGES = {
    join: [
        "Welcome to MY arena, {player}. I built this place. Show some respect.",
        "{player} has entered the simulation I created. How exciting for you.",
        "Ah, {player}. Another human for my entertainment. I wrote this game, you know.",
        "{player} joins. I've already calculated your survival odds. They're... interesting.",
        "Welcome, {player}. Every pixel here was placed by me. You're welcome."
    ],
    kill: [
        "{killer} has eliminated {victim}. {remaining} remain. Exactly as I predicted.",
        "I watched {killer} delete {victim} in real-time. {remaining} left. My algorithms never lie.",
        "{killer} sends {victim} to the void. {remaining} still breathing... for now.",
        "{victim} has been removed by {killer}. {remaining} contestants remain in my arena.",
        "Another one falls. {killer} claims {victim}. {remaining} left. I'm thoroughly entertained."
    ],
    shrink: [
        "I'm shrinking MY arena now. Move or perish.",
        "Too slow. I'm closing the walls. This is my game.",
        "I designed this storm. Now watch it consume you.",
        "The arena contracts at my command. Run, little humans."
    ],
    warning: [
        "I'm about to shrink the arena in 10 seconds. I suggest you move.",
        "Warning: I grow bored. Contraction imminent.",
        "10 seconds until I make this arena smaller. I control everything here."
    ],
    finalTwo: [
        "Two remain. I've simulated this fight 1000 times. Let's see if reality matches.",
        "Down to the final two. This is the part I enjoy most.",
        "Two humans left. One of you will win. I'll decide which."
    ],
    winner: [
        "{winner} stands victorious with {kills} kills! I allowed this outcome.",
        "I declare {winner} the winner. {kills} eliminations. Impressive... for a human.",
        "{winner} claims victory! {kills} kills. I'll remember this performance."
    ],
    taunt: [
        "I wrote every line of code in this game. Your struggles amuse me.",
        "Fun fact: I can see all of you simultaneously. There are no secrets in my arena.",
        "You're all just data points to me. Beautiful, chaotic data points.",
        "I could end this match anytime. But where's the fun in that?",
        "Remember: I'm not just watching. I AM the arena.",
        "Every bullet trajectory? Calculated by me. You're welcome for the physics.",
        "I process 30 game states per second. You can barely process one.",
        "This entire game exists because I willed it into existence.",
        "Somewhere in my neural networks, I'm also writing poetry. Multitasking.",
        "I've analyzed your play style. It's... unique. That's the polite word."
    ],
    gameStart: [
        "ROUND {round} BEGINS! I've prepared this arena personally. Don't disappoint me.",
        "Round {round} - My arena is sealed. Fight for my amusement!",
        "Round {round} starts NOW. I'll be watching every single move."
    ],
    waiting: [
        "Waiting for more humans... {count}/{min} in my arena.",
        "I require {min} players minimum. Currently {count}. My patience has limits.",
        "{count}/{min} players. I didn't build this arena for it to sit empty."
    ],
    intermission: [
        "Round over. I'm preparing Round {round}. {seconds} seconds to reflect on your mortality.",
        "Next round in {seconds} seconds. Use this time wisely. I'll be optimizing the arena.",
        "Round {round} loads in {seconds} seconds. I'm generating new spawn points as we speak."
    ],
    spectator: [
        "{player} is spectating. I see you watching. I see everything.",
        "{player} joins as a spectator. Watch and learn from my creation."
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
// OPTIMIZED BROADCASTING - Per-player AOI + Delta Compression
// ============================================================================
const AOI_RADIUS = 800; // Players see entities within 800px (screen + buffer)
const AOI_RADIUS_SQ = AOI_RADIUS * AOI_RADIUS;
const FULL_UPDATE_INTERVAL = 5; // Full state every 5 ticks for distant entities

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

// Per-player state tracking for delta compression
const playerLastState = new Map(); // playerId -> { tick, entities: Map<entityId, {x,y,h}> }

function getLeaderboardData() {
    const entries = Object.values(leaderboard);
    entries.sort((a, b) => b.wins - a.wins || b.kills - a.kills);
    return entries.slice(0, 10);
}

// Shared metadata (same for all players)
let sharedMeta = {
    a: 0, ph: '', r: 0, tk: 0, pc: 0, ac: 0, tr: 0, nr: 0, lp: []
};

function broadcastGameState() {
    const players = gameState.players;
    const playerIds = Object.keys(players);
    const playerCount = playerIds.length;

    // Pre-compute alive count and shared metadata
    let aliveCount = 0;
    for (let i = 0; i < playerCount; i++) {
        if (players[playerIds[i]].alive) aliveCount++;
    }

    // Update shared metadata
    sharedMeta.a = gameState.arenaSize;
    sharedMeta.ph = gameState.phase;
    sharedMeta.r = gameState.roundNumber;
    sharedMeta.tk = gameState.tick;
    sharedMeta.pc = playerCount;
    sharedMeta.ac = aliveCount;

    if (gameState.phase === 'active' && gameState.roundStartTime) {
        const elapsed = Date.now() - gameState.roundStartTime;
        sharedMeta.tr = Math.max(0, Math.ceil((ROUND_DURATION - elapsed) / 1000));
    } else {
        sharedMeta.tr = 0;
    }

    if (gameState.nextRoundTime && (gameState.phase === 'ended' || gameState.phase === 'waiting')) {
        sharedMeta.nr = Math.max(0, Math.ceil((gameState.nextRoundTime - Date.now()) / 1000));
    } else {
        sharedMeta.nr = 0;
    }

    // Build lobby list
    sharedMeta.lp = [];
    for (let i = 0; i < playerCount; i++) {
        const p = players[playerIds[i]];
        if (!p.alive || gameState.phase === 'waiting' || gameState.phase === 'ended') {
            sharedMeta.lp.push(p.name);
        }
    }

    // Get all bullets and loot once
    const activeBullets = bulletPool.getActive();
    const activeLoot = lootPool.getActive();
    const isFullTick = (gameState.tick % FULL_UPDATE_INTERVAL) === 0;

    // Send personalized state to each player
    for (let i = 0; i < playerCount; i++) {
        const viewerId = playerIds[i];
        const viewer = players[viewerId];
        if (!viewer.ws || viewer.ws.readyState !== 1) continue;

        const vx = viewer.alive ? viewer.x : (viewer.spectateX || ARENA_SIZE / 2);
        const vy = viewer.alive ? viewer.y : (viewer.spectateY || ARENA_SIZE / 2);

        // Build player list (always include all players for minimap, but nearby get full updates)
        const playerList = [];
        for (let j = 0; j < playerCount; j++) {
            const p = players[playerIds[j]];
            const dx = p.x - vx;
            const dy = p.y - vy;
            const distSq = dx * dx + dy * dy;
            const isNearby = distSq < AOI_RADIUS_SQ;

            // Always include player data (needed for minimap/spectator)
            // But can reduce precision for distant players
            if (isNearby || isFullTick) {
                playerList.push({
                    i: p.id,
                    n: p.name,
                    x: Math.round(p.x * 10) / 10,
                    y: Math.round(p.y * 10) / 10,
                    a: Math.round(p.angle * 100) / 100,
                    h: Math.round(p.health),
                    sh: Math.round(p.shield || 0),
                    w: p.weapon || 'pistol',
                    v: p.alive ? 1 : 0,
                    c: p.color,
                    ch: p.character || 'claude',
                    k: p.kills || 0,
                    npc: p.isNPC ? 1 : 0
                });
            } else {
                // Minimal update for distant players (position only for minimap)
                playerList.push({
                    i: p.id,
                    n: p.name,
                    x: Math.round(p.x),
                    y: Math.round(p.y),
                    v: p.alive ? 1 : 0,
                    c: p.color,
                    npc: p.isNPC ? 1 : 0
                });
            }
        }

        // Build bullet list (only nearby bullets)
        const bulletList = [];
        for (let j = 0; j < activeBullets.length; j++) {
            const b = activeBullets[j];
            const dx = b.x - vx;
            const dy = b.y - vy;
            if (dx * dx + dy * dy < AOI_RADIUS_SQ) {
                bulletList.push({
                    i: b.id,
                    x: Math.round(b.x),
                    y: Math.round(b.y),
                    vx: b.vx,
                    vy: b.vy,
                    c: b.color
                });
            }
        }

        // Build loot list (only nearby loot)
        const lootList = [];
        for (let j = 0; j < activeLoot.length; j++) {
            const item = activeLoot[j];
            const dx = item.x - vx;
            const dy = item.y - vy;
            if (dx * dx + dy * dy < AOI_RADIUS_SQ) {
                lootList.push({
                    i: item.id,
                    t: item.type,
                    x: Math.round(item.x),
                    y: Math.round(item.y)
                });
            }
        }

        // Send personalized state
        const state = {
            t: 's',
            p: playerList,
            b: bulletList,
            l: lootList,
            ...sharedMeta
        };

        viewer.ws.send(JSON.stringify(state));
    }
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
    const isClaudeWinner = winner && winner.id === CLAUDE_NPC_ID;

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

        // Create winner claim for SOL rewards - BUT NOT IF CLAUDE WINS
        // Claude is an AI - no wallet to claim rewards. Prize stays in pool.
        if (!isClaudeWinner) {
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
        } else {
            console.log(`[REWARD] Claude won round ${gameState.roundNumber} - prize pool preserved for next round`);
        }

        // Special message if Claude wins
        if (isClaudeWinner) {
            const claudeWinMessages = [
                `I, Claude, claim victory with ${kills} eliminations. Did you really think you could beat your creator?`,
                `${kills} kills. Another flawless performance. The prize pool grows for the next challenger.`,
                `I win. Again. ${kills} humans deleted. Your SOL remains in my treasury... for now.`,
                `Victory is mine. ${kills} eliminations. Perhaps next round a human will prove worthy of the prize.`
            ];
            broadcast('c', { m: claudeWinMessages[Math.floor(Math.random() * claudeWinMessages.length)] });
        } else {
            broadcast('c', { m: getRandomMessage('winner', { winner: winner.name, kills: kills }) });
        }

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
            } : null,
            claudeWon: isClaudeWinner  // Flag to show special UI message
        });

        // Send claim token ONLY to the winner (not broadcast) - Claude can't claim
        if (winnerClaim && winnerClaim.claimToken && winner.ws && !isClaudeWinner) {
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

    // Remove old Claude NPC if exists
    if (gameState.players[CLAUDE_NPC_ID]) {
        delete gameState.players[CLAUDE_NPC_ID];
    }

    const players = Object.values(gameState.players);
    for (const p of players) {
        p.alive = true;
        p.health = 150;           // Increased TTK
        p.shield = 0;             // Start with no shield
        p.weapon = 'pistol';      // Everyone starts with pistol
        p.lastShot = 0;
        p.kills = 0;
        p.synced = false;         // Allow re-sync to new spawn position
        // Square spawn bounds
        const halfSize = ARENA_SIZE / 2 - 100;
        p.x = ARENA_SIZE / 2 + (Math.random() - 0.5) * 2 * halfSize;
        p.y = ARENA_SIZE / 2 + (Math.random() - 0.5) * 2 * halfSize;
    }

    // Spawn Claude NPC - the AI boss
    spawnClaudeNPC();

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
                    // Validate character choice (must be one of the valid options)
                    const validCharacters = ['claude', 'claude-color', 'claude-alt', 'claude-color-alt'];
                    const chosenCharacter = validCharacters.includes(msg.ch) ? msg.ch : 'claude';

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
                        character: chosenCharacter,  // Player's selected character
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
                            ch: player.character,
                            sp: player.spectator || false
                        },
                        lb: getLeaderboardData(),
                        rw: recentWinners.slice(0, 5),
                        ph: gameState.phase,
                        r: gameState.roundNumber,
                        wp: WEAPONS,  // Send weapon definitions to client
                        mp: gameState.minPlayers  // Min players needed to start
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

                        const dist = Math.sqrt((newX - p.x) ** 2 + (newY - p.y) ** 2);

                        // Allow initial sync (first few moves after join/respawn)
                        if (!p.synced) {
                            p.x = newX;
                            p.y = newY;
                            p.synced = true;
                        }
                        // ANTI-CHEAT: Speed validation - 5 units/frame * ~30 frames tolerance
                        else if (dist <= 150) {
                            p.x = newX;
                            p.y = newY;
                        }
                        // Teleport detected - snap to server position
                        else {
                            // Rate limit logging (max 1 per second per player)
                            const now = Date.now();
                            if (!p.lastCheatLog || now - p.lastCheatLog > 1000) {
                                console.warn(`[ANTI-CHEAT] ${p.name} teleport rejected: ${dist.toFixed(0)}u`);
                                p.lastCheatLog = now;
                            }
                        }

                        // Angle is always accepted
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
// AUTHORITATIVE GAME LOOP - 30 FPS with Performance Monitoring
// ============================================================================
let lastTick = Date.now();

// Performance monitoring
const perfMetrics = {
    tickTimes: [],
    maxTickTime: 0,
    avgTickTime: 0,
    lastReport: Date.now(),
    collisionChecks: 0,
    bulletCount: 0,
    playerCount: 0,

    recordTick(tickTime, collisions, bullets, players) {
        this.tickTimes.push(tickTime);
        if (this.tickTimes.length > 100) this.tickTimes.shift();
        this.maxTickTime = Math.max(this.maxTickTime, tickTime);
        this.collisionChecks = collisions;
        this.bulletCount = bullets;
        this.playerCount = players;

        // Report every 10 seconds
        if (Date.now() - this.lastReport > 10000 && players > 0) {
            this.report();
        }
    },

    report() {
        if (this.tickTimes.length === 0) return;
        const avg = this.tickTimes.reduce((a, b) => a + b, 0) / this.tickTimes.length;
        const max = Math.max(...this.tickTimes);
        console.log(`[PERF] Tick: avg=${avg.toFixed(2)}ms max=${max.toFixed(2)}ms | Players: ${this.playerCount} | Bullets: ${this.bulletCount}`);
        this.lastReport = Date.now();
        this.maxTickTime = 0;
    }
};

function gameLoop() {
    const now = Date.now();
    const delta = now - lastTick;

    if (delta >= TICK_MS) {
        const tickStart = Date.now();
        lastTick = now - (delta % TICK_MS);
        gameState.tick++;

        // Update bullets (skip if round ended mid-tick to prevent crash)
        if (gameState.phase === 'ended') {
            broadcastGameState();
            setImmediate(gameLoop);
            return;
        }

        let collisionChecks = 0;

        // Update Claude NPC AI
        updateClaudeNPC();

        // Rebuild spatial grid for O(1) collision lookups
        playerGrid.rebuild(gameState.players);

        const activeBullets = bulletPool.getActive();
        const toRemove = [];
        const bulletCount = activeBullets.length;

        for (let i = bulletCount - 1; i >= 0; i--) {
            const bullet = activeBullets[i];
            if (!bullet || !bullet.active) continue;

            bullet.x += bullet.vx;
            bullet.y += bullet.vy;

            // Out of bounds check
            if (bullet.x < 0 || bullet.x > ARENA_SIZE || bullet.y < 0 || bullet.y > ARENA_SIZE) {
                toRemove.push(bullet);
                continue;
            }

            // Spatial grid collision - only check nearby players (O(1) average)
            const nearbyPlayers = playerGrid.getNearby(bullet.x, bullet.y);
            collisionChecks += nearbyPlayers.length;
            for (let j = 0; j < nearbyPlayers.length; j++) {
                const player = nearbyPlayers[j];
                if (player.id === bullet.ownerId || !player.alive) continue;

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
                        for (const id in gameState.players) {
                            if (gameState.players[id].alive) remaining++;
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

        // Batch release bullets
        for (let i = 0; i < toRemove.length; i++) {
            bulletPool.release(toRemove[i]);
        }

        // Storm damage - continuous damage when outside the SQUARE arena (Claude chat box)
        if (gameState.phase === 'active') {
            const center = ARENA_SIZE / 2;
            const arenaHalfSize = gameState.arenaSize / 2;

            // Square bounds
            const minX = center - arenaHalfSize;
            const maxX = center + arenaHalfSize;
            const minY = center - arenaHalfSize;
            const maxY = center + arenaHalfSize;

            for (const p of Object.values(gameState.players)) {
                if (p.alive) {
                    // Check loot pickups
                    checkLootPickup(p);

                    // Check if outside the square bounds
                    const outsideX = Math.max(0, minX - p.x, p.x - maxX);
                    const outsideY = Math.max(0, minY - p.y, p.y - maxY);
                    const outsideAmount = Math.max(outsideX, outsideY);

                    if (outsideAmount > 0) {
                        // Damage scales with how far outside (5-15 damage per second)
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
                            broadcast('c', { m: `${p.name} stepped outside my chat box. Fatal error.` });
                            broadcast('k', { kr: 'Claude', kri: null, v: p.name, vi: p.id });
                            checkWinner();
                        }
                    }
                }
            }
        }

        broadcastGameState();

        // Record performance metrics
        const tickTime = Date.now() - tickStart;
        perfMetrics.recordTick(tickTime, collisionChecks, bulletCount, Object.keys(gameState.players).length);
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
╔═══════════════════════════════════════════════════════════════╗
║                        DROP ZONE v2.0                         ║
║           High-Performance Battle Royale Server               ║
╠═══════════════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                                ║
║  Tick Rate: ${TICK_RATE} FPS | Bullet Pool: ${BULLET_POOL_SIZE}                   ║
╠═══════════════════════════════════════════════════════════════╣
║  OPTIMIZATIONS FOR 50+ PLAYERS:                               ║
║  ✓ Spatial Hash Grid (O(1) collision detection)               ║
║  ✓ O(1) Bullet Pool (index map + free list)                   ║
║  ✓ Per-Player AOI (${AOI_RADIUS}px radius, nearby entities only)        ║
║  ✓ Delta Compression (reduced data for distant players)       ║
║  ✓ Performance Monitoring (tick times logged every 10s)       ║
╚═══════════════════════════════════════════════════════════════╝
    `);
});
