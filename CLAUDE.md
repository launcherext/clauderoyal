# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Royale is a real-time multiplayer browser-based battle royale game. Players compete in shrinking arena rounds with the last player standing declared the winner. The game features an AI commentator (Claude) that announces game events.

## Architecture

### Server (`server.js`)
- Express server with WebSocket support (ws library)
- Manages game state: players, bullets, arena size, game phases
- Game phases: `waiting` -> `starting` -> `active` -> `ended`
- Handles player connections, movement, shooting, and collision detection
- Runs at 30 FPS for game state updates
- Arena shrinks every 30 seconds during active phase

### Client (`public/game.js`)
- Canvas-based rendering with camera following player
- WebSocket communication for real-time state sync
- Handles input (WASD movement, mouse aim, click to shoot)
- Spectator mode when dead or joining mid-round

### Key Game Constants
- Arena size: 2000x2000 pixels
- Bullet speed: 15 units/frame
- Bullet damage: 20 HP
- Player health: 100 HP
- Player speed: 5 units/frame
- Minimum arena size: 300 pixels
- Round intermission: 15 seconds

## Development Commands

```bash
# Start the server
node server.js

# Server runs on PORT environment variable or defaults to 3000
```

## WebSocket Message Types

**Client -> Server:**
- `join`: Register player with name
- `move`: Update position (x, y, angle)
- `shoot`: Fire bullet
- `spectate`: Switch spectate target

**Server -> Client:**
- `joined`: Player registration confirmed
- `gameState`: Full state broadcast (30x/sec)
- `claude`: AI commentary message
- `kill`: Kill event notification
- `roundStart`/`roundEnd`: Round lifecycle events
- `arenaShrink`: Arena boundary update

## File Structure

```
server.js          # Game server and WebSocket logic
public/
  index.html       # Main HTML with embedded CSS
  game.js          # Client-side game engine
  *.png            # Game assets (arena floor, player skin, backgrounds)
```
