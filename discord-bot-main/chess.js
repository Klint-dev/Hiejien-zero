const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
// Register bundled font so it works on any server including Railway
try {
  GlobalFonts.registerFromPath(path.join(__dirname, 'font.ttf'), 'ChessFont');
  console.log('✅ Chess font registered');
} catch (e) {
  console.error('Font registration failed:', e.message);
}
const { Chess } = require('chess.js');

const activeGames = new Map();

const COLORS = {
  lightSquare: '#F0D9B5',
  darkSquare:  '#B58863',
  lastMove:    '#CDD26A',
  check:       '#FF4444',
  border:      '#1a1a2e',
  text:        '#FFFFFF',
};

// Draw pieces using canvas shapes instead of Unicode
function drawPiece(ctx, piece, x, y, size) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const s = size * 0.38;
  const isWhite = piece.color === 'w';

  ctx.save();
  ctx.strokeStyle = isWhite ? '#333' : '#ccc';
  ctx.lineWidth = size * 0.04;
  ctx.fillStyle = isWhite ? '#FFFFFF' : '#1a1a1a';

  switch (piece.type) {
    case 'p': drawPawn(ctx, cx, cy, s, isWhite); break;
    case 'r': drawRook(ctx, cx, cy, s, isWhite); break;
    case 'n': drawKnight(ctx, cx, cy, s, isWhite); break;
    case 'b': drawBishop(ctx, cx, cy, s, isWhite); break;
    case 'q': drawQueen(ctx, cx, cy, s, isWhite); break;
    case 'k': drawKing(ctx, cx, cy, s, isWhite); break;
  }
  ctx.restore();
}

function fillAndStroke(ctx) {
  ctx.fill();
  ctx.stroke();
}

function drawPawn(ctx, cx, cy, s, isWhite) {
  // Base
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.6, cy + s * 0.9);
  ctx.lineTo(cx + s * 0.6, cy + s * 0.9);
  ctx.lineTo(cx + s * 0.35, cy + s * 0.4);
  ctx.lineTo(cx - s * 0.35, cy + s * 0.4);
  ctx.closePath();
  fillAndStroke(ctx);
  // Head
  ctx.beginPath();
  ctx.arc(cx, cy - s * 0.1, s * 0.38, 0, Math.PI * 2);
  fillAndStroke(ctx);
}

function drawRook(ctx, cx, cy, s, isWhite) {
  // Body
  ctx.beginPath();
  ctx.rect(cx - s * 0.5, cy - s * 0.5, s, s * 1.4);
  fillAndStroke(ctx);
  // Battlements
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.rect(cx + i * s * 0.33 - s * 0.15, cy - s * 0.85, s * 0.3, s * 0.35);
    fillAndStroke(ctx);
  }
  // Base
  ctx.beginPath();
  ctx.rect(cx - s * 0.65, cy + s * 0.75, s * 1.3, s * 0.25);
  fillAndStroke(ctx);
}

function drawKnight(ctx, cx, cy, s, isWhite) {
  // Base
  ctx.beginPath();
  ctx.rect(cx - s * 0.55, cy + s * 0.6, s * 1.1, s * 0.3);
  fillAndStroke(ctx);
  // Body/head shape
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.3, cy + s * 0.6);
  ctx.lineTo(cx - s * 0.4, cy - s * 0.2);
  ctx.lineTo(cx - s * 0.2, cy - s * 0.7);
  ctx.lineTo(cx + s * 0.4, cy - s * 0.9);
  ctx.lineTo(cx + s * 0.5, cy - s * 0.3);
  ctx.lineTo(cx + s * 0.2, cy + s * 0.1);
  ctx.lineTo(cx + s * 0.3, cy + s * 0.6);
  ctx.closePath();
  fillAndStroke(ctx);
  // Eye
  ctx.beginPath();
  ctx.arc(cx + s * 0.25, cy - s * 0.55, s * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = isWhite ? '#333' : '#ccc';
  ctx.fill();
}

function drawBishop(ctx, cx, cy, s, isWhite) {
  // Base
  ctx.beginPath();
  ctx.rect(cx - s * 0.55, cy + s * 0.65, s * 1.1, s * 0.25);
  fillAndStroke(ctx);
  // Body
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.35, cy + s * 0.65);
  ctx.lineTo(cx - s * 0.2, cy);
  ctx.lineTo(cx, cy - s * 0.9);
  ctx.lineTo(cx + s * 0.2, cy);
  ctx.lineTo(cx + s * 0.35, cy + s * 0.65);
  ctx.closePath();
  fillAndStroke(ctx);
  // Ball on top
  ctx.beginPath();
  ctx.arc(cx, cy - s * 0.9, s * 0.15, 0, Math.PI * 2);
  fillAndStroke(ctx);
}

function drawQueen(ctx, cx, cy, s, isWhite) {
  // Base
  ctx.beginPath();
  ctx.rect(cx - s * 0.6, cy + s * 0.65, s * 1.2, s * 0.25);
  fillAndStroke(ctx);
  // Body
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.5, cy + s * 0.65);
  ctx.lineTo(cx - s * 0.35, cy - s * 0.1);
  ctx.lineTo(cx, cy + s * 0.2);
  ctx.lineTo(cx + s * 0.35, cy - s * 0.1);
  ctx.lineTo(cx + s * 0.5, cy + s * 0.65);
  ctx.closePath();
  fillAndStroke(ctx);
  // Crown points
  const points = [-0.5, -0.2, 0, 0.2, 0.5];
  const heights = [-0.5, -0.8, -1.0, -0.8, -0.5];
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.5, cy - s * 0.1);
  for (let i = 0; i < points.length; i++) {
    ctx.lineTo(cx + s * points[i], cy + s * heights[i]);
  }
  ctx.lineTo(cx + s * 0.5, cy - s * 0.1);
  ctx.closePath();
  fillAndStroke(ctx);
  // Crown balls
  [-0.5, -0.2, 0, 0.2, 0.5].forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(cx + s * p, cy + s * heights[i], s * 0.1, 0, Math.PI * 2);
    fillAndStroke(ctx);
  });
}

function drawKing(ctx, cx, cy, s, isWhite) {
  // Base
  ctx.beginPath();
  ctx.rect(cx - s * 0.6, cy + s * 0.65, s * 1.2, s * 0.25);
  fillAndStroke(ctx);
  // Body
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.45, cy + s * 0.65);
  ctx.lineTo(cx - s * 0.3, cy - s * 0.2);
  ctx.lineTo(cx + s * 0.3, cy - s * 0.2);
  ctx.lineTo(cx + s * 0.45, cy + s * 0.65);
  ctx.closePath();
  fillAndStroke(ctx);
  // Cross vertical
  ctx.beginPath();
  ctx.rect(cx - s * 0.1, cy - s * 1.1, s * 0.2, s * 0.9);
  fillAndStroke(ctx);
  // Cross horizontal
  ctx.beginPath();
  ctx.rect(cx - s * 0.35, cy - s * 0.85, s * 0.7, s * 0.2);
  fillAndStroke(ctx);
}

async function renderBoard(chess, lastMove = null, flipped = false) {
  const BORDER = 56;
  const SQUARE = 80;
  const BOARD = SQUARE * 8;
  const SIZE = BOARD + BORDER * 2;

  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Label backgrounds (strips on all 4 sides)
  ctx.fillStyle = '#0d0d1a';
  ctx.fillRect(0, 0, SIZE, BORDER);                    // top
  ctx.fillRect(0, SIZE - BORDER, SIZE, BORDER);         // bottom
  ctx.fillRect(0, BORDER, BORDER, BOARD);               // left
  ctx.fillRect(SIZE - BORDER, BORDER, BORDER, BOARD);   // right

  // Board border
  ctx.strokeStyle = '#b58863';
  ctx.lineWidth = 3;
  ctx.strokeRect(BORDER, BORDER, BOARD, BOARD);

  // Draw squares
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const fileIdx = flipped ? 7 - col : col;
      const rankIdx = flipped ? row : 7 - row;
      const x = BORDER + col * SQUARE;
      const y = BORDER + row * SQUARE;
      const isLight = (fileIdx + rankIdx) % 2 === 0;
      const file = String.fromCharCode(97 + fileIdx);
      const rank = rankIdx + 1;
      const sq = `${file}${rank}`;

      let squareColor = isLight ? '#F0D9B5' : '#B58863';
      if (lastMove && (sq === lastMove.from || sq === lastMove.to)) {
        squareColor = isLight ? '#F6F669' : '#CDD26A';
      }

      ctx.fillStyle = squareColor;
      ctx.fillRect(x, y, SQUARE, SQUARE);

      // Check highlight on king
      const piece = chess.get(sq);
      if (piece && piece.type === 'k' && chess.inCheck() && piece.color === chess.turn()) {
        ctx.fillStyle = 'rgba(255, 50, 50, 0.6)';
        ctx.fillRect(x, y, SQUARE, SQUARE);
      }

      if (piece) drawPiece(ctx, piece, x, y, SQUARE);
    }
  }

  // ── Labels on all 4 sides — large, bold, high contrast ──────────────────
  const LABEL_SIZE = 22;
  ctx.font = `bold ${LABEL_SIZE}px ChessFont, sans-serif`;
  ctx.fillStyle = '#FFD700'; // gold — high contrast against dark bg
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < 8; i++) {
    const fileIdx = flipped ? 7 - i : i;
    const rankIdx = flipped ? i : 7 - i;
    const fileLetter = String.fromCharCode(65 + fileIdx); // A-H
    const rankNum = String(rankIdx + 1);                  // 1-8
    const cx = BORDER + i * SQUARE + SQUARE / 2;
    const cy = BORDER + i * SQUARE + SQUARE / 2;

    // TOP
    ctx.fillText(fileLetter, cx, BORDER / 2);
    // BOTTOM
    ctx.fillText(fileLetter, cx, SIZE - BORDER / 2);
    // LEFT
    ctx.fillText(rankNum, BORDER / 2, cy);
    // RIGHT
    ctx.fillText(rankNum, SIZE - BORDER / 2, cy);
  }

  return canvas.toBuffer('image/png');
}

function createGame(challengerId, challengerName, opponentId, opponentName, timeLimitMs = null) {
  const chess = new Chess();
  const timePerSide = timeLimitMs || null;
  return {
    chess,
    white: { id: challengerId, name: challengerName },
    black: { id: opponentId, name: opponentName },
    lastMove: null,
    startedAt: Date.now(),
    moveCount: 0,
    // Timer state
    timeLimit: timePerSide,
    whiteTimeMs: timePerSide,
    blackTimeMs: timePerSide,
    turnStartedAt: Date.now(),
    timerTimeout: null,
  };
}

function startTurnTimer(game, channelId, client, onTimeout) {
  clearTurnTimer(game);
  if (!game.timeLimit) return;
  const currentTime = game.chess.turn() === "w" ? game.whiteTimeMs : game.blackTimeMs;
  game.turnStartedAt = Date.now();
  game.timerTimeout = setTimeout(() => onTimeout(channelId, game), currentTime);
}

function clearTurnTimer(game) {
  if (game.timerTimeout) { clearTimeout(game.timerTimeout); game.timerTimeout = null; }
}

function updateClock(game) {
  if (!game.timeLimit) return;
  const elapsed = Date.now() - game.turnStartedAt;
  if (game.chess.turn() === "w") {
    game.whiteTimeMs = Math.max(0, game.whiteTimeMs - elapsed);
  } else {
    game.blackTimeMs = Math.max(0, game.blackTimeMs - elapsed);
  }
  game.turnStartedAt = Date.now();
}

function formatTime(ms) {
  if (ms === null) return "∞";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getClockLine(game) {
  if (!game.timeLimit) return "";
  return `⏱️ ⬜ ${formatTime(game.whiteTimeMs)} | ⬛ ${formatTime(game.blackTimeMs)}`;
}

function getGame(channelId) { return activeGames.get(channelId) || null; }
function setGame(channelId, game) { activeGames.set(channelId, game); }
function deleteGame(channelId) { activeGames.delete(channelId); }
function getCurrentPlayer(game) { return game.chess.turn() === 'w' ? game.white : game.black; }

function getStatusLine(game) {
  const chess = game.chess;
  const current = getCurrentPlayer(game);
  if (chess.isCheckmate()) { const winner = chess.turn() === 'w' ? game.black : game.white; return `🏆 **CHECKMATE!** <@${winner.id}> wins!`; }
  if (chess.isStalemate()) return `🤝 **Stalemate!** Draw.`;
  if (chess.isDraw())      return `🤝 **Draw!**`;
  if (chess.isCheck())     return `⚠️ **CHECK!** ${current.id === 'BOT' ? `**${current.name}**` : `<@${current.id}>`} (${chess.turn() === 'w' ? '⬜ White' : '⬛ Black'}) — king in check!`;
  return `♟️ ${current.id === 'BOT' ? `**${current.name}**` : `<@${current.id}>`}'s turn (${chess.turn() === 'w' ? '⬜ White' : '⬛ Black'})`;
}

function isGameOver(game) { return game.chess.isGameOver(); }

const pendingChallenges = new Map();
function createChallenge(channelId, challengerId, challengerName, opponentId, opponentName) {
  pendingChallenges.set(channelId, { challengerId, challengerName, opponentId, opponentName, createdAt: Date.now() });
  setTimeout(() => { if (pendingChallenges.has(channelId)) pendingChallenges.delete(channelId); }, 60000);
}
function getChallenge(channelId) { return pendingChallenges.get(channelId) || null; }
function deleteChallenge(channelId) { pendingChallenges.delete(channelId); }

module.exports = { createGame, getGame, setGame, deleteGame, getCurrentPlayer, getStatusLine, isGameOver, renderBoard, createChallenge, getChallenge, deleteChallenge, activeGames, startTurnTimer, clearTurnTimer, updateClock, getClockLine, formatTime };
