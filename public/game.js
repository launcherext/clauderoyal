// ============================================================================
// CLAUDE ROYALE - High Performance Game Client
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
const totalAssets = 4;
const loadingBar = document.getElementById('loadingBar');
const loadingText = document.getElementById('loadingText');
const loadingScreen = document.getElementById('loadingScreen');

function assetLoaded(name) {
    assetsLoaded++;
    const percent = (assetsLoaded / totalAssets) * 100;
    if (loadingBar) loadingBar.style.width = percent + '%';
    if (loadingText) loadingText.textContent = `Loading ${name}... (${assetsLoaded}/${totalAssets})`;

    if (assetsLoaded >= totalAssets) {
        if (loadingText) loadingText.textContent = 'Ready!';
        setTimeout(() => {
            if (loadingScreen) loadingScreen.classList.add('hidden');
        }, 500);
    }
}

const arenaFloorImg = new Image();
arenaFloorImg.src = 'arena-floor.png';
let arenaPattern = null;
arenaFloorImg.onload = () => {
    arenaPattern = ctx.createPattern(arenaFloorImg, 'repeat');
    assetLoaded('arena floor');
};
arenaFloorImg.onerror = () => assetLoaded('arena floor (fallback)');

const playerSkinImg = new Image();
playerSkinImg.src = 'player-skin.png';
let playerSkinLoaded = false;
playerSkinImg.onload = () => {
    playerSkinLoaded = true;
    assetLoaded('player skin');
};
playerSkinImg.onerror = () => assetLoaded('player skin (fallback)');

// Character sprite sheet
const characterSprites = new Image();
characterSprites.src = 'character-sprites.png';
let characterSpritesLoaded = false;
characterSprites.onload = () => {
    characterSpritesLoaded = true;
};
characterSprites.onerror = () => console.log('Character sprites fallback');

// Sprite animation config (16x16 sprites)
const SPRITE_FRAME_SIZE = 16;
const SPRITE_SCALE = 3; // Scale up for visibility
// Animation rows in the sprite sheet (approximate - adjust based on actual sheet)
const SPRITE_ROWS = {
    idleDown: 0,
    idleRight: 1,
    idleUp: 2,
    idleLeft: 3,
    walkDown: 4,
    walkRight: 5,
    walkUp: 6,
    walkLeft: 7
};
const FRAMES_PER_ROW = 10;
let animationFrame = 0;
setInterval(() => { animationFrame = (animationFrame + 1) % FRAMES_PER_ROW; }, 100);

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

// Pre-create common glows
const bulletGlow = createGlowCanvas(15, 'rgb(255, 255, 0)');
const playerHighlightGlow = createGlowCanvas(40, 'rgb(0, 255, 255)');
const arenaGlow = createGlowCanvas(30, 'rgb(224, 122, 95)');

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
let lastSentAngle = 0; // Throttle angle-only updates
const ANGLE_THRESHOLD = 0.05; // ~3 degrees before sending angle update

let gameState = {
    players: [],
    bullets: [],
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
    health: 100,
    alive: true,
    kills: 0
};

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
        console.log('Connected to Claude Royale');
        ws.send(JSON.stringify({ t: 'j', n: playerName }));
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
                alive: data.p.v === 1,
                color: data.p.c,
                kills: 0
            };
            isSpectator = data.p.sp || false;
            document.getElementById('menu').classList.add('hidden');

            if (data.lb) updateLeaderboardUI(data.lb);
            if (data.rw) updateRecentWinnersUI(data.rw);
            if (isSpectator) {
                document.getElementById('spectatorOverlay').classList.add('show');
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
                        alive: p.v === 1,
                        color: p.c,
                        name: p.n,
                        kills: p.k
                    });
                }
            }

            // Store raw player data for minimap
            gameState.players = data.p;
            gameState.bullets = data.b;

            // Update UI
            document.getElementById('healthFill').style.width = localPlayer.health + '%';
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
                    timerEl.style.color = '#ff3d5a';
                } else {
                    timerEl.style.color = '#00e5ff';
                }
            } else {
                timerEl.style.display = 'none';
            }

            // Handle spectator mode
            if (!localPlayer.alive && data.ph === 'active') {
                document.getElementById('spectatorOverlay').classList.add('show');
                const alivePlayers = data.p.filter(p => p.v === 1);
                if (alivePlayers.length > 0 && !spectateTarget) {
                    spectateTarget = alivePlayers[0].i;
                }
            } else {
                document.getElementById('spectatorOverlay').classList.remove('show');
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
                particlePool.spawnBurst(victim.x, victim.y, 20, 5, 1000, 8, '#ff4444');
            }
            break;

        case 'rs': // roundStart
            document.getElementById('roundEndOverlay').classList.remove('show');
            document.getElementById('spectatorOverlay').classList.remove('show');
            isSpectator = false;
            spectateTarget = null;
            pendingInputs.length = 0; // Clear prediction buffer
            showCountdown();
            break;

        case 're': // roundEnd
            currentClaim = data.claim || null;
            showRoundEnd(data.w, data.wi, data.k, data.r, data.claim);
            if (data.lb) updateLeaderboardUI(data.lb);
            break;

        case 'as': // arenaShrink
            gameState.arenaSize = data.s;
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
            const dotColor = isAlive ? '#2ecc71' : '#666';
            const nameColor = isMe ? '#00e5ff' : (isAlive ? '#fff' : '#888');
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

    const now = Date.now();
    if (localPlayer.alive && ws && ws.readyState === 1 && now - lastShootTime > SHOOT_COOLDOWN) {
        lastShootTime = now;
        ws.send(JSON.stringify({ t: 'sh' }));

        // Muzzle flash particles
        const muzzleX = localPlayer.x + Math.cos(localPlayer.angle) * 30;
        const muzzleY = localPlayer.y + Math.sin(localPlayer.angle) * 30;
        particlePool.spawnBurst(muzzleX, muzzleY, 8, 3, 200, 4, '#ffff00');
    }
});

// ============================================================================
// UPDATE LOOP
// ============================================================================
function updateLocalPlayer(dt) {
    if (!localPlayer.alive || isSpectator) {
        // Spectator camera follows target
        if (spectateTarget && gameState.players) {
            const target = gameState.players.find(p => p.i === spectateTarget);
            if (target && target.v === 1) {
                localPlayer.x = target.x;
                localPlayer.y = target.y;
            } else {
                const alive = gameState.players.filter(p => p.v === 1);
                if (alive.length > 0) {
                    spectateTarget = alive[0].i;
                }
            }
        }
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
    ctx.fillStyle = 'rgba(6, 6, 13, 0.7)';
    ctx.beginPath();
    ctx.rect(-camera.x, -camera.y, ARENA_SIZE, ARENA_SIZE);
    ctx.arc(arenaScreenX, arenaScreenY, arenaRadius, 0, Math.PI * 2, true);
    ctx.fill();

    // 2. Draw arena floor INSIDE the circle (clipped)
    ctx.save();
    ctx.beginPath();
    ctx.arc(arenaScreenX, arenaScreenY, arenaRadius, 0, Math.PI * 2);
    ctx.clip();

    // Subtle radial gradient floor (semi-transparent to show background)
    const gradient = ctx.createRadialGradient(
        arenaScreenX, arenaScreenY, 0,
        arenaScreenX, arenaScreenY, arenaRadius
    );
    gradient.addColorStop(0, 'rgba(20, 20, 35, 0.4)');
    gradient.addColorStop(0.6, 'rgba(12, 12, 24, 0.5)');
    gradient.addColorStop(1, 'rgba(8, 8, 16, 0.6)');
    ctx.fillStyle = gradient;
    ctx.fillRect(arenaScreenX - arenaRadius, arenaScreenY - arenaRadius,
        arenaRadius * 2, arenaRadius * 2);

    // Clean grid overlay (subtle)
    ctx.strokeStyle = 'rgba(26, 26, 46, 0.5)';
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

    // 3. Arena boundary glow
    ctx.strokeStyle = '#E07A5F';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(arenaScreenX, arenaScreenY, arenaRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(224, 122, 95, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(arenaScreenX, arenaScreenY, arenaRadius - 10, 0, Math.PI * 2);
    ctx.stroke();

    // 4. Storm pulse effect (subtle)
    const pulse = Math.sin(Date.now() / 800) * 0.08 + 0.15;
    ctx.fillStyle = `rgba(60, 0, 90, ${pulse})`;
    ctx.beginPath();
    ctx.rect(-camera.x, -camera.y, ARENA_SIZE, ARENA_SIZE);
    ctx.arc(arenaScreenX, arenaScreenY, arenaRadius, 0, Math.PI * 2, true);
    ctx.fill();

    // 5. Storm lightning (occasional)
    if (Math.random() < 0.012) {
        ctx.strokeStyle = `rgba(160, 60, 200, ${Math.random() * 0.4 + 0.2})`;
        ctx.lineWidth = 2;
        const angle = Math.random() * Math.PI * 2;
        const r = arenaRadius + 40;
        const sx = arenaScreenX + Math.cos(angle) * r;
        const sy = arenaScreenY + Math.sin(angle) * r;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        for (let i = 0; i < 3; i++) {
            ctx.lineTo(sx + (Math.random() - 0.5) * 60, sy + (Math.random() - 0.5) * 60);
        }
        ctx.stroke();
    }
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
    const color = player.color || player.c || '#E07A5F';
    const name = player.name || player.n || 'Player';
    const kills = player.kills || player.k || 0;
    const health = player.health || player.h || 100;
    const radius = 22;

    ctx.save();

    // Outer glow ring
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(x, y, radius + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Main circle background
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, 'rgba(30, 30, 50, 0.9)');
    gradient.addColorStop(1, 'rgba(15, 15, 25, 0.95)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Colored border ring
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Player initial in center
    ctx.fillStyle = color;
    ctx.font = 'bold 18px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.charAt(0).toUpperCase(), x, y + 1);

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

    // Random color for name based on player name hash
    const nameColors = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#95e1d3', '#f38181', '#aa96da', '#fcbad3', '#a8d8ea', '#ff9a8b', '#88d8b0', '#c9b1ff', '#ffd93d'];
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

    // Health bar below
    const healthWidth = 40;
    const healthHeight = 5;
    const healthY = y + radius + 8;

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.beginPath();
    ctx.roundRect(x - healthWidth / 2 - 1, healthY - 1, healthWidth + 2, healthHeight + 2, 3);
    ctx.fill();

    // Health fill
    let healthColor = '#2ecc71';
    if (health <= 50) healthColor = '#f1c40f';
    if (health <= 25) healthColor = '#e74c3c';

    ctx.fillStyle = healthColor;
    ctx.beginPath();
    ctx.roundRect(x - healthWidth / 2, healthY, (health / 100) * healthWidth, healthHeight, 2);
    ctx.fill();

    // Self highlight (cyan dashed ring)
    if (isLocal) {
        ctx.strokeStyle = '#00e5ff';
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
        gradient.addColorStop(1, bullet.c || '#ffff00');

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

        ctx.fillStyle = bullet.c || '#ffff00';
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawMinimap() {
    const scale = 150 / ARENA_SIZE;

    // Background
    minimapCtx.fillStyle = '#1a1a2e';
    minimapCtx.fillRect(0, 0, 150, 150);

    // Storm zone
    minimapCtx.fillStyle = 'rgba(80, 0, 120, 0.4)';
    minimapCtx.beginPath();
    minimapCtx.rect(0, 0, 150, 150);
    minimapCtx.arc(75, 75, (gameState.arenaSize / 2) * scale, 0, Math.PI * 2, true);
    minimapCtx.fill();

    // Arena boundary
    minimapCtx.strokeStyle = '#E07A5F';
    minimapCtx.lineWidth = 2;
    minimapCtx.beginPath();
    minimapCtx.arc(75, 75, (gameState.arenaSize / 2) * scale, 0, Math.PI * 2);
    minimapCtx.stroke();

    // Players
    for (const player of gameState.players) {
        if (player.v !== 1) continue;

        const px = player.x * scale;
        const py = player.y * scale;

        if (player.i === playerId) {
            minimapCtx.fillStyle = '#00ffff';
            minimapCtx.beginPath();
            minimapCtx.arc(px, py, 5, 0, Math.PI * 2);
            minimapCtx.fill();
        } else {
            minimapCtx.fillStyle = player.c || '#E07A5F';
            minimapCtx.beginPath();
            minimapCtx.arc(px, py, 3, 0, Math.PI * 2);
            minimapCtx.fill();
        }
    }

    // Border
    minimapCtx.strokeStyle = 'rgba(224, 122, 95, 0.5)';
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
    particlePool.update(deltaTime);

    // Render
    drawArena();
    drawBullets();
    drawPlayers();
    particlePool.draw(ctx, camera.x, camera.y);
    drawMinimap();

    requestAnimationFrame(gameLoop);
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================
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

    if (!sessionId) {
        showClaimError('Session expired. Please refresh and try again.');
        return;
    }

    claimBtn.disabled = true;
    claimBtn.textContent = 'SUBMITTING...';

    try {
        const response = await fetch('/api/rewards/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, walletAddress: wallet })
        });

        const result = await response.json();

        if (result.success) {
            claimBtn.textContent = 'CLAIMED!';
            claimBtn.style.background = '#2ecc71';
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
        errorEl.style.cssText = 'color: #e74c3c; font-size: 12px; margin-top: 8px;';
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
        successEl.style.cssText = 'color: #2ecc71; font-size: 12px; margin-top: 8px;';
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
}

window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
});

// ============================================================================
// START
// ============================================================================
requestAnimationFrame(gameLoop);
