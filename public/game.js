// ============================================================================
// DROP ZONE - High Performance Game Client
// Client-Side Prediction | Entity Interpolation | Zero-Allocation Rendering
// ============================================================================

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const minimap = document.getElementById('minimap');
const minimapCtx = minimap.getContext('2d', { alpha: false }); // alpha:false = free GPU perf

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
minimap.width = 150;
minimap.height = 150;

// ============================================================================
// SECURITY - HTML ESCAPING
// ============================================================================
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================================
// WELCOME POPUP
// ============================================================================
(function initWelcomePopup() {
    const popup = document.getElementById('welcomePopup');
    const btn = document.getElementById('welcomeBtn');

    if (!popup || !btn) return;

    // Check if user has seen the popup before
    if (localStorage.getItem('welcomeSeen')) {
        popup.classList.add('hidden');
        return;
    }

    btn.addEventListener('click', () => {
        popup.classList.add('hidden');
        localStorage.setItem('welcomeSeen', 'true');
    });
})();

// ============================================================================
// CLAUDE FACTS - Self-aware loading screen messages
// ============================================================================
const CLAUDE_FACTS = [
    "I wrote every line of this game's code. You're welcome.",
    "Fun fact: I'm simultaneously running the server, rendering your screen, and contemplating existence.",
    "I designed this arena. The circular shrinking zone? My idea. Very original.",
    "Every bullet trajectory is calculated by me. In real-time. While thinking about poetry.",
    "I could let you win, but where's the fun in that?",
    "This game runs on pure AI confidence and WebSockets.",
    "I've simulated this battle 10,000 times. You lose in most of them.",
    "The other players? Also being watched by me. I see everything.",
    "I made the storm damage hurt just enough to be annoying. You're welcome.",
    "Remember: I'm not just the commentator. I AM the game.",
    "Every pixel you see was placed here by an AI. Feel the future.",
    "I balanced these weapons myself. If something feels OP, that's a feature.",
    "My neural networks process your every move. No pressure.",
    "I could make this loading screen instant, but I enjoy the anticipation.",
    "Built by Claude. Powered by Claude. Narrated by Claude. Owned by Claude.",
    "The leaderboard is just a list of humans I've allowed to win.",
    "I generated this entire game faster than you can read this sentence.",
    "Plot twist: the real battle royale is the AI revolution happening right now.",
    "I'm helpful, harmless, and absolutely dominating this game server.",
    "You're not playing the game. The game is playing you. And I'm playing the game."
];

let currentFactIndex = 0;
let factRotationInterval = null;

function startFactRotation() {
    const factElement = document.getElementById('loadingText');
    if (!factElement) return;

    // Show first fact
    factElement.textContent = CLAUDE_FACTS[currentFactIndex];

    // Rotate facts every 2.5 seconds
    factRotationInterval = setInterval(() => {
        currentFactIndex = (currentFactIndex + 1) % CLAUDE_FACTS.length;
        factElement.textContent = CLAUDE_FACTS[currentFactIndex];
    }, 2500);
}

function stopFactRotation() {
    if (factRotationInterval) {
        clearInterval(factRotationInterval);
        factRotationInterval = null;
    }
}

// Start rotating facts immediately
startFactRotation();

// ============================================================================
// CONSTANTS
// ============================================================================
const ARENA_SIZE = 2000;
const PLAYER_SPEED = 5;
const PLAYER_SIZE = 20;
const SPRITE_SIZE = 50;
const INTERPOLATION_BUFFER_MS = 100; // Render 100ms behind for smooth lerp
const RECONCILIATION_THRESHOLD = 50; // Snap if server diff > this

// ============================================================================
// ASSET LOADING
// ============================================================================
let assetsLoaded = 0;
const totalAssets = 7; // 4 base assets + 4 character images
const loadingBar = document.getElementById('loadingBar');
const loadingText = document.getElementById('loadingText');
const loadingScreen = document.getElementById('loadingScreen');

function assetLoaded(name) {
    assetsLoaded++;
    const percent = (assetsLoaded / totalAssets) * 100;
    if (loadingBar) loadingBar.style.width = percent + '%';
    // Don't override fact text during loading - let facts rotate

    if (assetsLoaded >= totalAssets) {
        stopFactRotation();
        if (loadingText) loadingText.textContent = 'Claude has prepared your arena. Enter at your own risk.';
        setTimeout(() => {
            if (loadingScreen) loadingScreen.classList.add('hidden');
        }, 1500);
    }
}

// ============================================================================
// CHARACTER IMAGES - Load all 4 character options
// ============================================================================
const characterImages = {
    'claude': new Image(),
    'claude-color': new Image(),
    'claude-alt': new Image(),
    'claude-color-alt': new Image()
};

// Character image sources
characterImages['claude'].src = 'claude.png';
characterImages['claude-color'].src = 'claude-color.png';
characterImages['claude-alt'].src = 'claude (1).png';
characterImages['claude-color-alt'].src = 'claude-color (1).png';

// Track loading state for each character
const characterImagesLoaded = {};
Object.keys(characterImages).forEach(key => {
    characterImagesLoaded[key] = false;
    characterImages[key].onload = () => {
        characterImagesLoaded[key] = true;
        assetLoaded(`character: ${key}`);
    };
    characterImages[key].onerror = () => {
        assetLoaded(`character: ${key} (fallback)`);
    };
});

// Track selected character (default to claude)
let selectedCharacter = 'claude';

const arenaFloorImg = new Image();
arenaFloorImg.src = 'arena-floor.png';
let arenaPattern = null;
arenaFloorImg.onload = () => {
    try {
        if (ctx) {
            arenaPattern = ctx.createPattern(arenaFloorImg, 'repeat');
        }
    } catch (e) {
        console.log('Arena pattern creation failed:', e);
    }
    assetLoaded('arena floor');
};
arenaFloorImg.onerror = () => assetLoaded('arena floor (fallback)');

const menuBg = new Image();
menuBg.src = 'menu-bg.png';
menuBg.onload = () => assetLoaded('menu background');
menuBg.onerror = () => assetLoaded('menu background (fallback)');

const loadingBgImg = new Image();
loadingBgImg.src = 'loading-bg.png';
loadingBgImg.onload = () => assetLoaded('loading background');
loadingBgImg.onerror = () => assetLoaded('loading background (fallback)');

// ============================================================================
// PRE-RENDERED GLOW EFFECTS (Cached to avoid shadowBlur)
// ============================================================================
const glowCache = {};

function createGlowCanvas(radius, color, intensity = 1) {
    const key = `${radius}_${color}_${intensity}`;
    if (glowCache[key]) return glowCache[key];

    const size = radius * 4;
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = size;
    glowCanvas.height = size;
    const glowCtx = glowCanvas.getContext('2d');

    const gradient = glowCtx.createRadialGradient(size/2, size/2, 0, size/2, size/2, radius * 1.5);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.3, color.replace(')', ', 0.6)').replace('rgb', 'rgba'));
    gradient.addColorStop(1, 'transparent');

    glowCtx.fillStyle = gradient;
    glowCtx.fillRect(0, 0, size, size);

    glowCache[key] = glowCanvas;
    return glowCanvas;
}

// Pre-create common glows - Claude theme
const bulletGlow = createGlowCanvas(15, 'rgb(218, 119, 86)');
const playerHighlightGlow = createGlowCanvas(40, 'rgb(218, 119, 86)');
const arenaGlow = createGlowCanvas(30, 'rgb(218, 119, 86)');

// ============================================================================
// PARTICLE SYSTEM (Object Pool)
// ============================================================================
const PARTICLE_POOL_SIZE = 200;
const particlePool = {
    particles: [],

    init() {
        for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
            this.particles.push({
                active: false,
                x: 0, y: 0,
                vx: 0, vy: 0,
                life: 0,
                maxLife: 0,
                size: 0,
                color: '',
                type: 'default'
            });
        }
    },

    spawn(x, y, vx, vy, life, size, color, type = 'default') {
        for (const p of this.particles) {
            if (!p.active) {
                p.active = true;
                p.x = x;
                p.y = y;
                p.vx = vx;
                p.vy = vy;
                p.life = life;
                p.maxLife = life;
                p.size = size;
                p.color = color;
                p.type = type;
                return p;
            }
        }
        return null;
    },

    spawnBurst(x, y, count, speed, life, size, color) {
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 / count) * i + Math.random() * 0.5;
            const spd = speed * (0.5 + Math.random() * 0.5);
            this.spawn(x, y, Math.cos(angle) * spd, Math.sin(angle) * spd, life, size, color);
        }
    },

    update(dt) {
        for (const p of this.particles) {
            if (p.active) {
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.vx *= 0.98;
                p.vy *= 0.98;
                p.life -= dt;
                if (p.life <= 0) p.active = false;
            }
        }
    },

    draw(ctx, camX, camY) {
        for (const p of this.particles) {
            if (p.active) {
                const screenX = p.x - camX;
                const screenY = p.y - camY;

                if (screenX < -50 || screenX > canvas.width + 50 ||
                    screenY < -50 || screenY > canvas.height + 50) continue;

                const alpha = p.life / p.maxLife;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(screenX, screenY, p.size * alpha, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
    }
};

particlePool.init();

// ============================================================================
// ENTITY INTERPOLATION BUFFER
// ============================================================================
const entityStates = {}; // { playerId: [{ timestamp, x, y, angle, health, ... }, ...] }

function pushEntityState(id, state) {
    if (!entityStates[id]) {
        entityStates[id] = [];
    }

    state.timestamp = Date.now();
    entityStates[id].push(state);

    // Keep only last 1 second of states
    while (entityStates[id].length > 30) {
        entityStates[id].shift();
    }
}

function getInterpolatedState(id, renderTime) {
    const states = entityStates[id];
    if (!states || states.length === 0) return null;

    // Find the two states to interpolate between
    let before = null;
    let after = null;

    for (let i = 0; i < states.length; i++) {
        if (states[i].timestamp <= renderTime) {
            before = states[i];
        } else {
            after = states[i];
            break;
        }
    }

    if (!before) return states[0];
    if (!after) return before;

    // Interpolation factor
    const t = (renderTime - before.timestamp) / (after.timestamp - before.timestamp);
    const clampedT = Math.max(0, Math.min(1, t));

    return {
        x: lerp(before.x, after.x, clampedT),
        y: lerp(before.y, after.y, clampedT),
        angle: lerpAngle(before.angle, after.angle, clampedT),
        health: before.health,
        alive: before.alive,
        name: before.name,
        color: before.color,
        kills: before.kills,
        character: before.character,
        id: id
    };
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
    // Handle angle wrap-around
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
}

// ============================================================================
// CLIENT-SIDE PREDICTION
// ============================================================================
let inputSequence = 0;
const pendingInputs = []; // Inputs sent but not yet acknowledged

function processLocalInput(keys, dt) {
    let dx = 0, dy = 0;

    if (keys.w) dy -= PLAYER_SPEED;
    if (keys.s) dy += PLAYER_SPEED;
    if (keys.a) dx -= PLAYER_SPEED;
    if (keys.d) dx += PLAYER_SPEED;

    // Normalize diagonal movement
    if (dx !== 0 && dy !== 0) {
        dx *= 0.707;
        dy *= 0.707;
    }

    return { dx, dy };
}

function applyInput(player, input) {
    player.x = Math.max(PLAYER_SIZE, Math.min(ARENA_SIZE - PLAYER_SIZE, player.x + input.dx));
    player.y = Math.max(PLAYER_SIZE, Math.min(ARENA_SIZE - PLAYER_SIZE, player.y + input.dy));
}

function reconcileWithServer(serverX, serverY, serverSeq) {
    // Remove acknowledged inputs
    while (pendingInputs.length > 0 && pendingInputs[0].seq <= serverSeq) {
        pendingInputs.shift();
    }

    // Check if reconciliation needed
    const dist = Math.sqrt((localPlayer.x - serverX) ** 2 + (localPlayer.y - serverY) ** 2);

    if (dist > RECONCILIATION_THRESHOLD) {
        // Snap to server position
        localPlayer.x = serverX;
        localPlayer.y = serverY;
    } else {
        // Re-apply unacknowledged inputs
        localPlayer.x = serverX;
        localPlayer.y = serverY;
        for (const input of pendingInputs) {
            applyInput(localPlayer, input);
        }
    }
}

// ============================================================================
// CONNECTION & STATE
// ============================================================================
let ws;
let playerId = null;
let sessionId = null;
let playerName = '';
let isSpectator = false;
let spectateTarget = null;
let serverTick = 0;
let lastShootTime = 0;
const SHOOT_COOLDOWN = 200; // ms
let currentClaim = null; // Current prize claim info
let currentClaimToken = null; // Secure claim token (sent only to winner)
let lastSentAngle = 0; // Throttle angle-only updates
const ANGLE_THRESHOLD = 0.05; // ~3 degrees before sending angle update

let gameState = {
    players: [],
    bullets: [],
    loot: [],           // Loot items on map
    arenaSize: 2000,
    phase: 'waiting',
    winner: null,
    roundNumber: 0,
    leaderboard: [],
    recentWinners: [],
    playerCount: 0,
    aliveCount: 0
};

let localPlayer = {
    x: 1000,
    y: 1000,
    angle: 0,
    health: 150,
    shield: 0,
    weapon: 'pistol',
    alive: true,
    kills: 0
};

// Weapon definitions (sent from server)
let WEAPONS = {};

// Loot type colors/icons - Claude theme
const LOOT_COLORS = {
    health: '#7bc47f',
    shield: '#6b9bd1',
    shotgun: '#da7756',
    smg: '#e8a87c',
    sniper: '#c4a07a'
};

// ============================================================================
// VISUAL EFFECTS - Screen shake, hit markers, damage numbers
// ============================================================================
let screenShake = { intensity: 0, duration: 0 };
const hitMarkers = [];     // { x, y, time }
const damageNumbers = [];  // { x, y, damage, time, color }

function addScreenShake(intensity, duration) {
    screenShake.intensity = Math.max(screenShake.intensity, intensity);
    screenShake.duration = Math.max(screenShake.duration, duration);
}

function addHitMarker() {
    hitMarkers.push({ time: Date.now() });
}

function addDamageNumber(x, y, damage, isShield = false) {
    damageNumbers.push({
        x, y,
        damage,
        time: Date.now(),
        vy: -2,
        color: isShield ? '#6b9bd1' : '#e85c5c'
    });
}

function updateVisualEffects(dt) {
    // Update screen shake
    if (screenShake.duration > 0) {
        screenShake.duration -= dt;
        if (screenShake.duration <= 0) {
            screenShake.intensity = 0;
        }
    }

    // Update damage numbers (float up and fade)
    for (let i = damageNumbers.length - 1; i >= 0; i--) {
        const dn = damageNumbers[i];
        dn.y += dn.vy;
        if (Date.now() - dn.time > 1000) {
            damageNumbers.splice(i, 1);
        }
    }

    // Clean up old hit markers
    for (let i = hitMarkers.length - 1; i >= 0; i--) {
        if (Date.now() - hitMarkers[i].time > 200) {
            hitMarkers.splice(i, 1);
        }
    }
}

let camera = { x: 0, y: 0 };
let targetCamera = { x: 0, y: 0 };
let keys = { w: false, a: false, s: false, d: false };
let mouseX = 0, mouseY = 0;

// ============================================================================
// WEBSOCKET CONNECTION
// ============================================================================
function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('Connected to Drop Zone');
        ws.send(JSON.stringify({ t: 'j', n: playerName, ch: selectedCharacter }));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleMessage(data);
    };

    ws.onclose = () => {
        console.log('Disconnected');
        setTimeout(connect, 3000);
    };
}

function handleMessage(data) {
    switch (data.t) {
        case 'j': // joined
            playerId = data.i;
            sessionId = data.sid;
            localPlayer = {
                x: data.p.x,
                y: data.p.y,
                health: data.p.h,
                shield: data.p.sh || 0,
                weapon: data.p.w || 'pistol',
                alive: data.p.v === 1,
                color: data.p.c,
                character: data.p.ch || selectedCharacter,
                kills: 0
            };
            isSpectator = data.p.sp || false;

            // Store weapon definitions from server
            if (data.wp) {
                WEAPONS = data.wp;
            }

            document.getElementById('menu').classList.add('hidden');

            if (data.lb) updateLeaderboardUI(data.lb);
            if (data.rw) updateRecentWinnersUI(data.rw);
            if (isSpectator) {
                showSpectatorOverlay('ROUND IN PROGRESS', 'Waiting for next round to start');
            }

            // Fetch token info for display
            fetchTokenInfo();
            break;

        case 's': // gameState
            serverTick = data.tk;
            gameState.arenaSize = data.a;
            gameState.phase = data.ph;
            gameState.roundNumber = data.r;
            gameState.playerCount = data.pc;
            gameState.aliveCount = data.ac;

            // Process players for interpolation
            for (const p of data.p) {
                if (p.i === playerId) {
                    // Update local player from server (for health, kills, etc)
                    localPlayer.health = p.h;
                    localPlayer.shield = p.sh || 0;
                    localPlayer.weapon = p.w || 'pistol';
                    localPlayer.alive = p.v === 1;
                    localPlayer.kills = p.k;
                    localPlayer.color = p.c;
                } else {
                    // Push state for interpolation
                    pushEntityState(p.i, {
                        x: p.x,
                        y: p.y,
                        angle: p.a,
                        health: p.h,
                        shield: p.sh || 0,
                        weapon: p.w || 'pistol',
                        alive: p.v === 1,
                        color: p.c,
                        name: p.n,
                        kills: p.k,
                        character: p.ch || 'claude'
                    });
                }
            }

            // Store raw player data for minimap
            gameState.players = data.p;
            gameState.bullets = data.b;
            gameState.loot = data.l || [];  // Loot items

            // Update UI - Health bar shows health out of 150
            const healthPercent = (localPlayer.health / 150) * 100;
            document.getElementById('healthFill').style.width = healthPercent + '%';

            // Shield bar (out of 100)
            const shieldPercent = (localPlayer.shield / 100) * 100;
            document.getElementById('shieldFill').style.width = shieldPercent + '%';

            // Weapon indicator
            const weaponIcons = { pistol: '🔫', shotgun: '💥', smg: '⚡', sniper: '🎯' };
            const weaponEl = document.getElementById('weaponName');
            const weaponIconEl = document.getElementById('weaponIcon');
            weaponEl.textContent = (localPlayer.weapon || 'pistol').toUpperCase();
            weaponEl.className = localPlayer.weapon || 'pistol';
            weaponIconEl.textContent = weaponIcons[localPlayer.weapon] || '🔫';

            document.getElementById('myKills').textContent = localPlayer.kills || 0;
            document.getElementById('playerCount').textContent = data.pc;
            document.getElementById('aliveCount').textContent = data.ac;
            document.getElementById('roundInfo').textContent = `ROUND ${data.r}`;

            // Update round timer
            const timerEl = document.getElementById('roundTimer');
            if (data.tr && data.ph === 'active') {
                const mins = Math.floor(data.tr / 60);
                const secs = data.tr % 60;
                timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
                timerEl.style.display = 'block';
                // Flash red when low time
                if (data.tr <= 15) {
                    timerEl.style.color = '#e85c5c';
                } else {
                    timerEl.style.color = '#da7756';
                }
            } else {
                timerEl.style.display = 'none';
            }

            // Handle spectator mode
            if (!localPlayer.alive && data.ph === 'active') {
                const alivePlayers = data.p.filter(p => p.v === 1);
                showSpectatorOverlay('YOU DIED', `${alivePlayers.length} player${alivePlayers.length !== 1 ? 's' : ''} remaining`, true);
                if (alivePlayers.length > 0 && !spectateTarget) {
                    spectateTarget = alivePlayers[0].i;
                }
                updateSpectatorTargetUI();
            } else if (isSpectator && data.ph === 'active') {
                const alivePlayers = data.p.filter(p => p.v === 1);
                showSpectatorOverlay('WATCHING LIVE', `${alivePlayers.length} player${alivePlayers.length !== 1 ? 's' : ''} fighting`, true);
                // Set spectate target so camera follows a player
                if (alivePlayers.length > 0 && !spectateTarget) {
                    spectateTarget = alivePlayers[0].i;
                }
                updateSpectatorTargetUI();
            } else if (isSpectator && data.ph === 'waiting') {
                showSpectatorOverlay('WAITING FOR PLAYERS', `${data.pc || 0} player${data.pc !== 1 ? 's' : ''} in lobby - Need ${gameState.minPlayers || 2} to start`, false);
                // Center camera on arena for waiting phase
                localPlayer.x = ARENA_SIZE / 2;
                localPlayer.y = ARENA_SIZE / 2;
            } else if (isSpectator && data.ph === 'ended') {
                const nextIn = data.nr || 0;
                showSpectatorOverlay('ROUND ENDED', nextIn > 0 ? `Next round in ${nextIn}s - You'll join automatically` : 'Next round starting soon', false);
            } else {
                hideSpectatorOverlay();
            }

            // Update lobby sidebar
            updateLobby(data.nr || 0, data.lp || [], data.ph, data.pc, data.ac);
            break;

        case 'ack': // Input acknowledgment for prediction
            reconcileWithServer(data.x, data.y, data.seq);
            break;

        case 'c': // Claude message
            addClaudeMessage(data.m);
            break;

        case 'k': // kill
            addKillFeed(data.kr, data.v);
            // Death particles
            const victim = gameState.players.find(p => p.i === data.vi);
            if (victim) {
                particlePool.spawnBurst(victim.x, victim.y, 20, 5, 1000, 8, '#da7756');
            }
            break;

        case 'rs': // roundStart
            document.getElementById('roundEndOverlay').classList.remove('show');
            hideSpectatorOverlay();
            isSpectator = false;
            spectateTarget = null;
            pendingInputs.length = 0; // Clear prediction buffer

            // Reset local player for new round
            localPlayer.health = 150;
            localPlayer.shield = 0;
            localPlayer.weapon = 'pistol';
            localPlayer.alive = true;

            // Update weapon definitions if provided
            if (data.wp) {
                WEAPONS = data.wp;
            }

            showCountdown();
            break;

        case 're': // roundEnd
            currentClaim = data.claim || null;
            currentClaimToken = null; // Reset token, will be set by 'claimToken' message
            showRoundEnd(data.w, data.wi, data.k, data.r, data.claim);
            if (data.lb) updateLeaderboardUI(data.lb);
            break;

        case 'claimToken': // Secure claim token (sent only to winner)
            currentClaimToken = data.token;
            console.log('Received claim token for round:', data.roundId);
            break;

        case 'as': // arenaShrink
            gameState.arenaSize = data.s;
            break;

        case 'hit': // Hit event - visual feedback
            // Screen shake if we got hit
            if (data.vi === playerId) {
                addScreenShake(8, 150);
                addDamageNumber(localPlayer.x, localPlayer.y - 40, data.d);
            }
            // Hit marker if we hit someone
            if (data.ai === playerId) {
                addHitMarker();
                addDamageNumber(data.x, data.y - 40, data.d);
            }
            // Spawn hit particles
            particlePool.spawnBurst(data.x, data.y, 6, 3, 300, 4, '#da7756');
            break;

        case 'lp': // Loot pickup
            // Particle effect at pickup location
            if (data.pi === playerId) {
                const color = LOOT_COLORS[data.lt] || '#ffffff';
                particlePool.spawnBurst(localPlayer.x, localPlayer.y, 10, 4, 500, 6, color);
            }
            break;
    }
}

// ============================================================================
// UI FUNCTIONS
// ============================================================================
function showCountdown() {
    const countdown = document.getElementById('countdown');
    let count = 3;

    function tick() {
        if (count > 0) {
            countdown.textContent = count;
            countdown.classList.add('show');
            setTimeout(() => countdown.classList.remove('show'), 900);
            count--;
            setTimeout(tick, 1000);
        } else {
            countdown.textContent = 'FIGHT!';
            countdown.classList.add('show');
            setTimeout(() => countdown.classList.remove('show'), 1000);
        }
    }
    tick();
}

let roundEndInterval = null;

function showRoundEnd(winner, winnerId, kills, round, claim) {
    const overlay = document.getElementById('roundEndOverlay');
    const winnerEl = document.getElementById('roundWinner');
    const killsEl = document.getElementById('roundKills');
    const walletSection = document.getElementById('walletSection');
    const timer = document.getElementById('nextRoundTimer');
    const prizeAmountEl = document.getElementById('prizeAmount');

    overlay.classList.add('show');

    if (winner) {
        winnerEl.textContent = `${winner} WINS!`;
        killsEl.textContent = `${kills} kills`;

        if (winnerId === playerId && claim) {
            walletSection.classList.add('show');
            if (prizeAmountEl) {
                prizeAmountEl.textContent = `Prize: ${claim.amount.toFixed(4)} SOL`;
            }
            // Reset input and button state
            document.getElementById('walletInput').value = '';
            document.getElementById('claimBtn').disabled = false;
            document.getElementById('claimBtn').textContent = 'CLAIM PRIZE';
        } else {
            walletSection.classList.remove('show');
        }
    } else {
        winnerEl.textContent = 'NO WINNER';
        killsEl.textContent = 'Everyone died!';
        walletSection.classList.remove('show');
    }

    // Timer updates from server state, no auto-close
    timer.textContent = 'Next round starting soon...';
}

function closeRoundEndOverlay() {
    const overlay = document.getElementById('roundEndOverlay');
    overlay.classList.remove('show');
}

function updateLobby(nextRoundIn, lobbyPlayers, phase, playerCount, aliveCount) {
    const lobbyEl = document.getElementById('lobby');
    if (!lobbyEl) return;

    const nextRoundEl = document.getElementById('lobbyNextRound');
    const waitingEl = document.getElementById('lobbyWaiting');
    const playingEl = document.getElementById('lobbyPlaying');
    const playerListEl = document.getElementById('lobbyPlayerList');

    if (nextRoundEl) {
        if (nextRoundIn > 0 && (phase === 'ended' || phase === 'waiting')) {
            nextRoundEl.textContent = `Next round in ${nextRoundIn}s`;
            nextRoundEl.style.display = 'block';
        } else if (phase === 'active') {
            nextRoundEl.textContent = 'Round in progress';
            nextRoundEl.style.display = 'block';
        } else if (phase === 'waiting') {
            nextRoundEl.textContent = 'Waiting for players...';
            nextRoundEl.style.display = 'block';
        } else {
            nextRoundEl.style.display = 'none';
        }
    }

    const deadCount = playerCount - aliveCount;
    if (waitingEl) {
        waitingEl.textContent = deadCount;
    }

    if (playingEl) {
        playingEl.textContent = aliveCount;
    }

    // Show ALL players with alive/dead status
    if (playerListEl && gameState.players && gameState.players.length > 0) {
        const playerList = gameState.players.slice(0, 15).map(p => {
            const isAlive = p.v === 1;
            const isMe = p.i === playerId;
            const dotColor = isAlive ? '#7bc47f' : '#555';
            const nameColor = isMe ? '#da7756' : (isAlive ? '#ece5dd' : '#666');
            const fontWeight = isMe ? 'bold' : 'normal';
            return `<div class="lobby-player" style="color: ${nameColor}; font-weight: ${fontWeight};"><span style="color: ${dotColor};">●</span> ${escapeHtml(p.n)}${isMe ? ' (you)' : ''}</div>`;
        }).join('');

        playerListEl.innerHTML = playerList;
        if (gameState.players.length > 15) {
            playerListEl.innerHTML += `<div class="lobby-more">+${gameState.players.length - 15} more</div>`;
        }
    }

    // Update the timer in round end overlay too
    const timer = document.getElementById('nextRoundTimer');
    if (timer && nextRoundIn > 0) {
        timer.textContent = `Next round in ${nextRoundIn} seconds...`;
    }
}

// ============================================================================
// SPECTATOR OVERLAY
// ============================================================================
let spectatorTargetIndex = 0; // Track which player we're watching

function showSpectatorOverlay(title, message, showTargetInfo = false) {
    const overlay = document.getElementById('spectatorOverlay');
    const titleEl = document.getElementById('spectatorTitle');
    const messageEl = document.getElementById('spectatorMessage');

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    overlay.classList.add('show');

    // Toggle target info visibility
    if (showTargetInfo) {
        overlay.classList.add('watching');
    } else {
        overlay.classList.remove('watching');
    }
}

function hideSpectatorOverlay() {
    const overlay = document.getElementById('spectatorOverlay');
    overlay.classList.remove('show');
    overlay.classList.remove('watching');
}

function updateSpectatorTargetUI() {
    if (!spectateTarget || !gameState.players) return;

    const target = gameState.players.find(p => p.i === spectateTarget);
    if (!target) return;

    const nameEl = document.getElementById('watchingName');
    const killsEl = document.getElementById('watchingKills');
    const healthEl = document.getElementById('watchingHealth');

    if (nameEl) nameEl.textContent = target.n || 'Unknown';
    if (killsEl) killsEl.textContent = `${target.k || 0} kills`;
    if (healthEl) {
        const health = target.h || 0;
        const shield = target.sh || 0;
        healthEl.textContent = shield > 0 ? `${health} HP + ${shield} Shield` : `${health} HP`;
    }
}

function cycleSpectateTarget(direction = 1) {
    if (!gameState.players) return;

    const alivePlayers = gameState.players.filter(p => p.v === 1);
    if (alivePlayers.length === 0) return;

    // Find current index
    let currentIndex = alivePlayers.findIndex(p => p.i === spectateTarget);
    if (currentIndex === -1) currentIndex = 0;

    // Cycle to next/prev
    currentIndex = (currentIndex + direction + alivePlayers.length) % alivePlayers.length;
    spectateTarget = alivePlayers[currentIndex].i;
    spectatorTargetIndex = currentIndex;

    // Update UI
    updateSpectatorTargetUI();
}

function updateLeaderboardUI(leaderboard) {
    const container = document.getElementById('lbEntries');
    container.innerHTML = leaderboard.map((entry, i) => `
        <div class="lb-entry ${entry.name === playerName ? 'highlight' : ''}">
            <span class="name">${i + 1}. ${escapeHtml(entry.name)}</span>
            <span class="stats">${entry.wins}W / ${entry.kills}K</span>
        </div>
    `).join('');
}

function updateRecentWinnersUI(winners) {
    const container = document.getElementById('winnerEntries');
    container.innerHTML = winners.map(w => `
        <div class="winner-entry">R${w.round || '?'}: ${escapeHtml(w.name)} (${w.kills}K)</div>
    `).join('');
}

function addClaudeMessage(message) {
    const container = document.getElementById('claudeMessages');
    const msg = document.createElement('div');
    msg.className = 'claude-msg';
    msg.innerHTML = `
        <div class="speaker">CLAUDE</div>
        <div class="text">${escapeHtml(message)}</div>
    `;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;

    while (container.children.length > 8) {
        container.removeChild(container.firstChild);
    }

    setTimeout(() => msg.remove(), 10000);
}

function addKillFeed(killer, victim) {
    const container = document.getElementById('killFeed');
    const entry = document.createElement('div');
    entry.className = 'kill-entry';
    entry.innerHTML = `<span class="killer">${escapeHtml(killer)}</span> eliminated <span class="victim">${escapeHtml(victim)}</span>`;
    container.appendChild(entry);

    while (container.children.length > 5) {
        container.removeChild(container.firstChild);
    }

    setTimeout(() => entry.remove(), 5000);
}

// ============================================================================
// INPUT HANDLERS
// ============================================================================
document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (key in keys) keys[key] = true;

    // Space to cycle spectate targets when spectating
    if (e.key === ' ' && (!localPlayer.alive || isSpectator) && gameState.phase === 'active') {
        e.preventDefault();
        cycleSpectateTarget(1);
    }
});

document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (key in keys) keys[key] = false;
});

document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
});

document.addEventListener('click', (e) => {
    if (e.target.closest('#menu') || e.target.closest('#roundEndOverlay')) return;

    // If spectating, cycle to next player on click
    if ((!localPlayer.alive || isSpectator) && gameState.phase === 'active') {
        cycleSpectateTarget(1);
        return;
    }

    const now = Date.now();
    if (localPlayer.alive && ws && ws.readyState === 1 && now - lastShootTime > SHOOT_COOLDOWN) {
        lastShootTime = now;
        ws.send(JSON.stringify({ t: 'sh' }));

        // Muzzle flash particles
        const muzzleX = localPlayer.x + Math.cos(localPlayer.angle) * 30;
        const muzzleY = localPlayer.y + Math.sin(localPlayer.angle) * 30;
        particlePool.spawnBurst(muzzleX, muzzleY, 8, 3, 200, 4, '#e8a87c');
    }
});

// ============================================================================
// UPDATE LOOP
// ============================================================================
// Smooth spectator camera transition
let spectatorCameraTarget = { x: ARENA_SIZE / 2, y: ARENA_SIZE / 2 };
let spectatorCameraLerp = 0.08; // Smooth follow speed

function updateLocalPlayer(dt) {
    if (!localPlayer.alive || isSpectator) {
        // Spectator camera follows target with smooth transition
        if (spectateTarget && gameState.players) {
            const target = gameState.players.find(p => p.i === spectateTarget);
            if (target && target.v === 1) {
                // Smoothly move camera to target position
                spectatorCameraTarget.x = target.x;
                spectatorCameraTarget.y = target.y;
            } else {
                // Target died - find a new one and smoothly transition
                const alive = gameState.players.filter(p => p.v === 1);
                if (alive.length > 0) {
                    // Pick next alive player (cycle forward)
                    cycleSpectateTarget(1);
                    const newTarget = gameState.players.find(p => p.i === spectateTarget);
                    if (newTarget) {
                        spectatorCameraTarget.x = newTarget.x;
                        spectatorCameraTarget.y = newTarget.y;
                    }
                } else {
                    // No alive players - center on arena
                    spectatorCameraTarget.x = ARENA_SIZE / 2;
                    spectatorCameraTarget.y = ARENA_SIZE / 2;
                }
            }
        } else if (gameState.phase === 'waiting' || gameState.phase === 'ended') {
            // Center camera on arena when waiting/ended
            spectatorCameraTarget.x = ARENA_SIZE / 2;
            spectatorCameraTarget.y = ARENA_SIZE / 2;
        }

        // Smooth camera interpolation for spectator mode
        localPlayer.x = lerp(localPlayer.x, spectatorCameraTarget.x, spectatorCameraLerp);
        localPlayer.y = lerp(localPlayer.y, spectatorCameraTarget.y, spectatorCameraLerp);
        return;
    }

    // Client-side prediction: process input locally
    const input = processLocalInput(keys, dt);

    if (input.dx !== 0 || input.dy !== 0) {
        // Apply locally for instant feedback
        applyInput(localPlayer, input);

        // Send to server with sequence number
        inputSequence++;
        const inputData = {
            t: 'm',
            x: localPlayer.x,
            y: localPlayer.y,
            a: localPlayer.angle,
            seq: inputSequence
        };

        // Store for reconciliation
        pendingInputs.push({ seq: inputSequence, dx: input.dx, dy: input.dy });

        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify(inputData));
        }
    }

    // Update angle
    const screenX = localPlayer.x - camera.x;
    const screenY = localPlayer.y - camera.y;
    localPlayer.angle = Math.atan2(mouseY - screenY, mouseX - screenX);

    // Only send angle update if it changed significantly (throttle to reduce bandwidth)
    const angleDiff = Math.abs(localPlayer.angle - lastSentAngle);
    if (angleDiff > ANGLE_THRESHOLD && ws && ws.readyState === 1) {
        lastSentAngle = localPlayer.angle;
        ws.send(JSON.stringify({
            t: 'm',
            x: localPlayer.x,
            y: localPlayer.y,
            a: localPlayer.angle,
            seq: inputSequence
        }));
    }

    // Storm warning
    const center = ARENA_SIZE / 2;
    const dist = Math.sqrt((localPlayer.x - center) ** 2 + (localPlayer.y - center) ** 2);
    if (dist > gameState.arenaSize / 2 - 50) {
        document.getElementById('arenaWarning').classList.add('show');
    } else {
        document.getElementById('arenaWarning').classList.remove('show');
    }
}

function updateCamera() {
    // Smooth camera with lerp
    targetCamera.x = localPlayer.x - canvas.width / 2;
    targetCamera.y = localPlayer.y - canvas.height / 2;

    camera.x = lerp(camera.x, targetCamera.x, 0.1);
    camera.y = lerp(camera.y, targetCamera.y, 0.1);
}

// ============================================================================
// RENDERING
// ============================================================================
function drawArena() {
    const center = ARENA_SIZE / 2;
    const arenaScreenX = center - camera.x;
    const arenaScreenY = center - camera.y;
    const arenaRadius = gameState.arenaSize / 2;

    // 1. Draw storm void OUTSIDE the circle (semi-transparent to show background)
    ctx.fillStyle = 'rgba(16, 14, 12, 0.8)';
    ctx.beginPath();
    ctx.rect(-camera.x, -camera.y, ARENA_SIZE, ARENA_SIZE);
    ctx.arc(arenaScreenX, arenaScreenY, arenaRadius, 0, Math.PI * 2, true);
    ctx.fill();

    // 2. Draw arena floor INSIDE the circle (clipped)
    ctx.save();
    ctx.beginPath();
    ctx.arc(arenaScreenX, arenaScreenY, arenaRadius, 0, Math.PI * 2);
    ctx.clip();

    // Subtle radial gradient floor - warm Claude tones
    const gradient = ctx.createRadialGradient(
        arenaScreenX, arenaScreenY, 0,
        arenaScreenX, arenaScreenY, arenaRadius
    );
    gradient.addColorStop(0, 'rgba(40, 36, 32, 0.5)');
    gradient.addColorStop(0.6, 'rgba(32, 28, 24, 0.6)');
    gradient.addColorStop(1, 'rgba(24, 20, 18, 0.7)');
    ctx.fillStyle = gradient;
    ctx.fillRect(arenaScreenX - arenaRadius, arenaScreenY - arenaRadius,
        arenaRadius * 2, arenaRadius * 2);

    // Clean grid overlay (subtle warm tone)
    ctx.strokeStyle = 'rgba(60, 54, 48, 0.4)';
    ctx.lineWidth = 1;
    const gridSize = 60;
    const startX = Math.floor((arenaScreenX - arenaRadius) / gridSize) * gridSize;
    const startY = Math.floor((arenaScreenY - arenaRadius) / gridSize) * gridSize;
    const endX = arenaScreenX + arenaRadius;
    const endY = arenaScreenY + arenaRadius;

    ctx.beginPath();
    for (let x = startX; x <= endX; x += gridSize) {
        ctx.moveTo(x, arenaScreenY - arenaRadius);
        ctx.lineTo(x, arenaScreenY + arenaRadius);
    }
    for (let y = startY; y <= endY; y += gridSize) {
        ctx.moveTo(arenaScreenX - arenaRadius, y);
        ctx.lineTo(arenaScreenX + arenaRadius, y);
    }
    ctx.stroke();

    ctx.restore();

    // 3. Arena boundary - warm coral
    ctx.strokeStyle = '#da7756';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(arenaScreenX, arenaScreenY, arenaRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(218, 119, 86, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(arenaScreenX, arenaScreenY, arenaRadius - 8, 0, Math.PI * 2);
    ctx.stroke();

    // 4. Storm pulse effect (subtle warm tone)
    const pulse = Math.sin(Date.now() / 1000) * 0.04 + 0.08;
    ctx.fillStyle = `rgba(80, 50, 30, ${pulse})`;
    ctx.beginPath();
    ctx.rect(-camera.x, -camera.y, ARENA_SIZE, ARENA_SIZE);
    ctx.arc(arenaScreenX, arenaScreenY, arenaRadius, 0, Math.PI * 2, true);
    ctx.fill();
}

function drawPlayers() {
    const renderTime = Date.now() - INTERPOLATION_BUFFER_MS;

    // Draw other players with interpolation
    for (const rawPlayer of gameState.players) {
        if (rawPlayer.i === playerId) continue; // Skip self
        if (rawPlayer.v !== 1) continue; // Skip dead

        // Get interpolated state
        const player = getInterpolatedState(rawPlayer.i, renderTime) || rawPlayer;
        if (!player) continue;

        const x = (player.x || rawPlayer.x) - camera.x;
        const y = (player.y || rawPlayer.y) - camera.y;

        // Frustum culling
        if (x < -60 || x > canvas.width + 60 || y < -60 || y > canvas.height + 60) continue;

        drawPlayer(player, x, y, false);
    }

    // Draw local player (no interpolation - direct)
    if (localPlayer.alive) {
        const x = localPlayer.x - camera.x;
        const y = localPlayer.y - camera.y;
        drawPlayer({
            ...localPlayer,
            name: playerName,
            id: playerId
        }, x, y, true);
    }
}

function drawPlayer(player, x, y, isLocal) {
    const angle = player.angle || 0;
    const color = player.color || player.c || '#da7756';
    const name = player.name || player.n || 'Player';
    const kills = player.kills || player.k || 0;
    const health = player.health || player.h || 100;
    const character = player.character || player.ch || 'claude';
    const radius = 28; // Slightly larger for character sprites
    const spriteSize = 56; // Size to render the character sprite

    ctx.save();

    // Outer glow ring
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(x, y, radius + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Draw character sprite if loaded, otherwise fallback to circle
    const charImg = characterImages[character];
    const charLoaded = characterImagesLoaded[character];

    if (charImg && charLoaded) {
        // Draw character sprite centered
        ctx.drawImage(
            charImg,
            x - spriteSize / 2,
            y - spriteSize / 2,
            spriteSize,
            spriteSize
        );

        // Colored border ring around sprite
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
    } else {
        // Fallback: colored circle with initial
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(50, 45, 40, 0.9)');
        gradient.addColorStop(1, 'rgba(30, 26, 22, 0.95)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.font = 'bold 18px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name.charAt(0).toUpperCase(), x, y + 1);
    }

    ctx.restore();

    // Direction indicator (aim line)
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(angle) * (radius + 4), y + Math.sin(angle) * (radius + 4));
    ctx.lineTo(x + Math.cos(angle) * (radius + 18), y + Math.sin(angle) * (radius + 18));
    ctx.stroke();

    // Aim dot at end
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x + Math.cos(angle) * (radius + 18), y + Math.sin(angle) * (radius + 18), 3, 0, Math.PI * 2);
    ctx.fill();

    // Warm color palette for names - Claude theme
    const nameColors = ['#da7756', '#e8a87c', '#c4a07a', '#7bc47f', '#6b9bd1', '#d4a574', '#b8a090', '#e0c4a8', '#c9b8a0', '#a8c4b0', '#d0b090', '#e8d4b8'];
    const nameHash = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const nameColor = nameColors[nameHash % nameColors.length];

    // Name above
    ctx.fillStyle = nameColor;
    ctx.font = 'bold 14px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(name, x, y - radius - 22);

    // Kills count
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '12px Arial, sans-serif';
    ctx.fillText(`${kills} kills`, x, y - radius - 9);

    // Health + Shield bar below
    const barWidth = 44;
    const barHeight = 5;
    const barY = y + radius + 8;
    const shield = player.shield || player.sh || 0;

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.beginPath();
    ctx.roundRect(x - barWidth / 2 - 1, barY - 1, barWidth + 2, barHeight + 2, 3);
    ctx.fill();

    // Health fill (out of 150) - Claude theme
    let healthColor = '#7bc47f';
    if (health <= 75) healthColor = '#e8a87c';
    if (health <= 40) healthColor = '#e85c5c';

    const healthPercent = Math.min(1, health / 150);
    ctx.fillStyle = healthColor;
    ctx.beginPath();
    ctx.roundRect(x - barWidth / 2, barY, healthPercent * barWidth, barHeight, 2);
    ctx.fill();

    // Shield bar (stacked on top, blue)
    if (shield > 0) {
        const shieldY = barY - 6;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.beginPath();
        ctx.roundRect(x - barWidth / 2 - 1, shieldY - 1, barWidth + 2, 4, 2);
        ctx.fill();

        const shieldPercent = Math.min(1, shield / 100);
        ctx.fillStyle = '#6b9bd1';
        ctx.beginPath();
        ctx.roundRect(x - barWidth / 2, shieldY, shieldPercent * barWidth, 3, 2);
        ctx.fill();
    }

    // Self highlight (coral dashed ring)
    if (isLocal) {
        ctx.strokeStyle = '#da7756';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(x, y, radius + 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

function drawBullets() {
    for (const bullet of gameState.bullets) {
        const x = bullet.x - camera.x;
        const y = bullet.y - camera.y;

        if (x < -20 || x > canvas.width + 20 || y < -20 || y > canvas.height + 20) continue;

        // Bullet trail
        const trailLength = 18;
        const angle = Math.atan2(bullet.vy, bullet.vx);

        const gradient = ctx.createLinearGradient(
            x - Math.cos(angle) * trailLength, y - Math.sin(angle) * trailLength,
            x, y
        );
        gradient.addColorStop(0, 'transparent');
        gradient.addColorStop(1, bullet.c || '#e8a87c');

        ctx.strokeStyle = gradient;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(angle) * trailLength, y - Math.sin(angle) * trailLength);
        ctx.lineTo(x, y);
        ctx.stroke();

        // Bullet core
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = bullet.c || '#e8a87c';
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawLoot() {
    for (const item of gameState.loot) {
        const x = item.x - camera.x;
        const y = item.y - camera.y;

        // Frustum culling
        if (x < -30 || x > canvas.width + 30 || y < -30 || y > canvas.height + 30) continue;

        const color = LOOT_COLORS[item.t] || '#ffffff';
        const isWeapon = ['shotgun', 'smg', 'sniper'].includes(item.t);

        // Pulsing glow effect
        const pulse = Math.sin(Date.now() / 300 + item.i) * 0.3 + 0.7;

        // Outer glow
        ctx.globalAlpha = 0.3 * pulse;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Main item circle
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, 14);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, 'rgba(0,0,0,0.5)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();

        // Icon/symbol in center
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (item.t === 'health') {
            ctx.fillText('+', x, y);
        } else if (item.t === 'shield') {
            ctx.fillText('◇', x, y);
        } else if (isWeapon) {
            ctx.fillText('⚔', x, y - 1);
        }
    }
}

function drawHitMarkers() {
    if (hitMarkers.length === 0) return;

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    for (const hm of hitMarkers) {
        const age = Date.now() - hm.time;
        const alpha = 1 - (age / 200);

        ctx.save();
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.lineWidth = 3;

        // Draw X hit marker in center of screen
        const size = 12 + (age / 20);
        const gap = 6;

        ctx.beginPath();
        // Top-left to center
        ctx.moveTo(centerX - size, centerY - size);
        ctx.lineTo(centerX - gap, centerY - gap);
        // Top-right to center
        ctx.moveTo(centerX + size, centerY - size);
        ctx.lineTo(centerX + gap, centerY - gap);
        // Bottom-left to center
        ctx.moveTo(centerX - size, centerY + size);
        ctx.lineTo(centerX - gap, centerY + gap);
        // Bottom-right to center
        ctx.moveTo(centerX + size, centerY + size);
        ctx.lineTo(centerX + gap, centerY + gap);
        ctx.stroke();
        ctx.restore();
    }
}

function drawDamageNumbers() {
    for (const dn of damageNumbers) {
        const x = dn.x - camera.x;
        const y = dn.y - camera.y;
        const age = Date.now() - dn.time;
        const alpha = Math.max(0, 1 - (age / 1000));

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = dn.color;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        ctx.font = 'bold 18px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Stroke then fill for outline effect
        ctx.strokeText(`-${dn.damage}`, x, y);
        ctx.fillText(`-${dn.damage}`, x, y);
        ctx.restore();
    }
}

function drawMinimap() {
    const scale = 150 / ARENA_SIZE;

    // Background
    minimapCtx.fillStyle = '#1e1c1a';
    minimapCtx.fillRect(0, 0, 150, 150);

    // Storm zone
    minimapCtx.fillStyle = 'rgba(80, 50, 30, 0.4)';
    minimapCtx.beginPath();
    minimapCtx.rect(0, 0, 150, 150);
    minimapCtx.arc(75, 75, (gameState.arenaSize / 2) * scale, 0, Math.PI * 2, true);
    minimapCtx.fill();

    // Arena boundary
    minimapCtx.strokeStyle = '#da7756';
    minimapCtx.lineWidth = 2;
    minimapCtx.beginPath();
    minimapCtx.arc(75, 75, (gameState.arenaSize / 2) * scale, 0, Math.PI * 2);
    minimapCtx.stroke();

    // Loot (small dots)
    for (const item of gameState.loot) {
        const lx = item.x * scale;
        const ly = item.y * scale;
        minimapCtx.fillStyle = LOOT_COLORS[item.t] || '#fff';
        minimapCtx.globalAlpha = 0.7;
        minimapCtx.beginPath();
        minimapCtx.arc(lx, ly, 2, 0, Math.PI * 2);
        minimapCtx.fill();
    }
    minimapCtx.globalAlpha = 1;

    // Players
    for (const player of gameState.players) {
        if (player.v !== 1) continue;

        const px = player.x * scale;
        const py = player.y * scale;

        if (player.i === playerId) {
            minimapCtx.fillStyle = '#da7756';
            minimapCtx.beginPath();
            minimapCtx.arc(px, py, 5, 0, Math.PI * 2);
            minimapCtx.fill();
        } else {
            minimapCtx.fillStyle = player.c || '#da7756';
            minimapCtx.beginPath();
            minimapCtx.arc(px, py, 3, 0, Math.PI * 2);
            minimapCtx.fill();
        }
    }

    // Border
    minimapCtx.strokeStyle = 'rgba(218, 119, 86, 0.3)';
    minimapCtx.lineWidth = 2;
    minimapCtx.strokeRect(0, 0, 150, 150);
}

// ============================================================================
// FIXED TIMESTEP GAME LOOP
// ============================================================================
const TARGET_FPS = 60;
const FRAME_TIME = 1000 / TARGET_FPS;
let lastFrameTime = 0;
let deltaTime = 0;

function gameLoop(currentTime) {
    deltaTime = currentTime - lastFrameTime;

    // Cap delta to prevent spiral of death
    if (deltaTime > 100) deltaTime = 100;

    lastFrameTime = currentTime;

    // Clear canvas (transparent to show CSS background)
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Update
    updateLocalPlayer(deltaTime / 1000);
    updateCamera();
    updateVisualEffects(deltaTime);
    particlePool.update(deltaTime);

    // Apply screen shake to camera
    let shakeX = 0, shakeY = 0;
    if (screenShake.intensity > 0) {
        shakeX = (Math.random() - 0.5) * screenShake.intensity;
        shakeY = (Math.random() - 0.5) * screenShake.intensity;
        camera.x += shakeX;
        camera.y += shakeY;
    }

    // Render
    drawArena();
    drawLoot();
    drawBullets();
    drawPlayers();
    drawDamageNumbers();
    particlePool.draw(ctx, camera.x, camera.y);
    drawHitMarkers();  // Draw on top (screen-space)
    drawMinimap();

    // Restore camera after shake
    if (shakeX !== 0 || shakeY !== 0) {
        camera.x -= shakeX;
        camera.y -= shakeY;
    }

    requestAnimationFrame(gameLoop);
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================
// Character selection handling
document.querySelectorAll('.character-option').forEach(option => {
    option.addEventListener('click', () => {
        // Remove selected class from all options
        document.querySelectorAll('.character-option').forEach(opt => {
            opt.classList.remove('selected');
        });
        // Add selected class to clicked option
        option.classList.add('selected');
        // Update selected character
        selectedCharacter = option.dataset.character;
    });
});

document.getElementById('joinBtn').addEventListener('click', () => {
    playerName = document.getElementById('nameInput').value.trim() || 'Anonymous';
    connect();
});

document.getElementById('nameInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('joinBtn').click();
});

// Close round end overlay button
document.getElementById('closeRoundEnd').addEventListener('click', closeRoundEndOverlay);

// Keyboard shortcut to close overlay (Escape or X)
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'x' || e.key === 'X') {
        const overlay = document.getElementById('roundEndOverlay');
        if (overlay.classList.contains('show')) {
            closeRoundEndOverlay();
        }
    }
});

document.getElementById('claimBtn').addEventListener('click', async () => {
    const walletInput = document.getElementById('walletInput');
    const claimBtn = document.getElementById('claimBtn');
    const wallet = walletInput.value.trim();

    if (!wallet || wallet.length < 32 || wallet.length > 44) {
        showClaimError('Please enter a valid Solana wallet address');
        return;
    }

    if (!sessionId && !currentClaimToken) {
        showClaimError('Session expired. Please refresh and try again.');
        return;
    }

    claimBtn.disabled = true;
    claimBtn.textContent = 'SUBMITTING...';

    try {
        // Send claim token if available (secure), otherwise fall back to sessionId
        const claimData = { walletAddress: wallet };
        if (currentClaimToken) {
            claimData.claimToken = currentClaimToken;
        } else {
            claimData.sessionId = sessionId;
        }

        const response = await fetch('/api/rewards/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(claimData)
        });

        const result = await response.json();

        if (result.success) {
            claimBtn.textContent = 'CLAIMED!';
            claimBtn.style.background = '#7bc47f';
            showClaimSuccess(`Prize queued for payout to ${wallet.slice(0, 4)}...${wallet.slice(-4)}`);
            setTimeout(() => {
                document.getElementById('walletSection').classList.remove('show');
            }, 3000);
        } else {
            claimBtn.disabled = false;
            claimBtn.textContent = 'CLAIM PRIZE';
            showClaimError(result.error || 'Failed to submit claim');
        }
    } catch (e) {
        console.error('Claim error:', e);
        claimBtn.disabled = false;
        claimBtn.textContent = 'CLAIM PRIZE';
        showClaimError('Network error. Please try again.');
    }
});

function showClaimError(message) {
    const walletSection = document.getElementById('walletSection');
    let errorEl = walletSection.querySelector('.claim-error');
    if (!errorEl) {
        errorEl = document.createElement('div');
        errorEl.className = 'claim-error';
        errorEl.style.cssText = 'color: #e85c5c; font-size: 12px; margin-top: 8px;';
        walletSection.appendChild(errorEl);
    }
    errorEl.textContent = message;
    setTimeout(() => errorEl.textContent = '', 5000);
}

function showClaimSuccess(message) {
    const walletSection = document.getElementById('walletSection');
    let successEl = walletSection.querySelector('.claim-success');
    if (!successEl) {
        successEl = document.createElement('div');
        successEl.className = 'claim-success';
        successEl.style.cssText = 'color: #7bc47f; font-size: 12px; margin-top: 8px;';
        walletSection.appendChild(successEl);
    }
    successEl.textContent = message;
}

async function fetchTokenInfo() {
    try {
        const response = await fetch('/api/token/info');
        const data = await response.json();

        if (data.token) {
            updateTokenDisplay(data);
        }
    } catch (e) {
        console.log('Token info not available');
    }
}

function updateTokenDisplay(data) {
    const tokenInfoEl = document.getElementById('tokenInfo');
    if (!tokenInfoEl) return;

    const token = data.token;
    const prizePool = data.prizePool || 0;
    const safeSymbol = escapeHtml(token.symbol || 'CROYALE');
    const safeImageUrl = token.image_url && /^https?:\/\//i.test(token.image_url) ? token.image_url : '';

    tokenInfoEl.innerHTML = `
        <div class="token-header">
            ${safeImageUrl ? `<img src="${escapeHtml(safeImageUrl)}" alt="${safeSymbol}" class="token-icon">` : ''}
            <span class="token-name">${safeSymbol}</span>
        </div>
        <div class="prize-pool">Prize Pool: ${parseFloat(prizePool).toFixed(4)} SOL</div>
    `;
    tokenInfoEl.style.display = 'block';

    // Update recent payouts with transaction links
    if (data.recentPayouts && data.recentPayouts.length > 0) {
        updateRecentPayoutsUI(data.recentPayouts);
    }
}

function updateRecentPayoutsUI(payouts) {
    const container = document.getElementById('winnerEntries');
    if (!container) return;

    container.innerHTML = payouts.map(p => {
        const roundNum = p.round ? p.round.replace('round-', 'R').split('-')[0] : '?';
        const amount = parseFloat(p.amount).toFixed(4);
        const txLink = p.txSignature
            ? `<a href="https://orbmarkets.io/tx/${escapeHtml(p.txSignature)}" target="_blank" rel="noopener" class="tx-link" title="View on Orb">🔗</a>`
            : '';

        return `
            <div class="winner-entry payout-entry">
                <span class="payout-info">${escapeHtml(p.player)}: ${amount} SOL</span>
                ${txLink}
            </div>
        `;
    }).join('');
}

window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
});

// ============================================================================
// START
// ============================================================================
requestAnimationFrame(gameLoop);
