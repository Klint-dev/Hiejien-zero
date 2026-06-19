// ── firmchart.js — Firm/IPO Candlestick Charts ────────────────────────────────
// Same visual style as stockchart.js — dark theme, clean candles, 3-up panel
// Usage: renderFirmPanel(firms[]) → PNG buffer
//        recordFirmCandle(ticker, price) — call every minute from your ticker

const { createCanvas } = require("@napi-rs/canvas");

// ── Colour palette (matches stockchart.js exactly) ───────────────────────────
const C = {
  bg:          "#0e1117",
  gridLine:    "#1a1f2e",
  border:      "#2a2f45",
  textPrimary: "#e0e6f0",
  textMuted:   "#4a5568",
  textLabel:   "#8892a4",
  up:          "#26a69a",
  down:        "#ef5350",
  headerBg:    "#111827",
};

// Auto-assign accent colours to firm tickers (cycles if more than palette)
const FIRM_ACCENT_PALETTE = [
  "#6378ff", "#f59e0b", "#a78bfa", "#34d399", "#fb923c",
  "#38bdf8", "#f472b6", "#facc15", "#4ade80", "#e879f9",
];
const accentIndex = new Map(); // ticker -> palette index (assigned at render time)
function getAccent(ticker) {
  if (!accentIndex.has(ticker)) {
    accentIndex.set(ticker, accentIndex.size % FIRM_ACCENT_PALETTE.length);
  }
  return FIRM_ACCENT_PALETTE[accentIndex.get(ticker)];
}

// ── Candle history store (in-memory, keyed by ticker) ────────────────────────
// Each candle: { o, h, l, c, label }  (all values in copper)
const firmCandles = new Map(); // ticker -> candle[]
const MAX_CANDLES = 60;

// Registered by firms.js — called after each volatility tick so firm.share_price stays live
let _onVolatilityTick = null;
function registerPriceUpdateCallback(fn) { _onVolatilityTick = fn; }

// ── In-progress candle accumulators ─────────────────────────────────────────
// We accumulate 1-minute candles from every price-set event
const candleAccum = new Map(); // ticker -> { open, high, low, lastPrice, startMin }

// ── Supabase persistence for candles ─────────────────────────────────────────
let _supabase = null;
function registerSupabase(sb) { _supabase = sb; }

async function saveFirmCandles() {
  if (!_supabase) return;
  try {
    const snapshot = {};
    for (const [ticker, candles] of firmCandles.entries()) {
      snapshot[ticker] = candles;
    }
    await _supabase.from("empire_data").upsert(
      { key: "firm_candles", value: snapshot },
      { onConflict: "key" }
    );
  } catch (e) { console.error("[FIRM CANDLES SAVE]", e.message); }
}

async function loadFirmCandles() {
  if (!_supabase) return;
  try {
    const { data } = await _supabase.from("empire_data").select("value").eq("key", "firm_candles").single();
    if (!data?.value) return;
    for (const [ticker, candles] of Object.entries(data.value)) {
      if (Array.isArray(candles) && candles.length > 0) {
        firmCandles.set(ticker.toUpperCase(), candles);
        // Reseed accumulator from last candle close so ticks continue smoothly
        const last = candles[candles.length - 1];
        const nowMin = Math.floor(Date.now() / 60000);
        candleAccum.set(ticker.toUpperCase(), {
          open: last.c, high: last.c, low: last.c,
          lastPrice: last.c, startMin: nowMin,
        });
      }
    }
    console.log(`[FIRM CANDLES] Loaded candle history for ${firmCandles.size} firm(s)`);
  } catch (e) { console.error("[FIRM CANDLES LOAD]", e.message); }
}

/**
 * Call this whenever a firm's share_price changes (price set, crash, sanction, buy).
 * It feeds the live candle accumulator.
 */
function onFirmPriceChange(ticker, newPrice) {
  ticker = ticker.toUpperCase();
  const nowMin = Math.floor(Date.now() / 60000);

  if (!candleAccum.has(ticker)) {
    candleAccum.set(ticker, {
      open: newPrice, high: newPrice, low: newPrice,
      lastPrice: newPrice, startMin: nowMin,
    });
    return;
  }

  const acc = candleAccum.get(ticker);

  // If we've rolled into a new minute, close the old candle and start fresh
  if (nowMin > acc.startMin) {
    _closeCandle(ticker, acc, nowMin);
  }

  acc.high = Math.max(acc.high, newPrice);
  acc.low  = Math.min(acc.low,  newPrice);
  acc.lastPrice = newPrice;
}

/**
 * Call every minute (e.g. from a setInterval in index.js) to flush open candles
 * AND apply micro-volatility to simulate live market activity.
 */
function tickFirmCandles() {
  const nowMin = Math.floor(Date.now() / 60000);
  for (const [ticker, acc] of candleAccum.entries()) {
    // Apply micro-volatility — simulate buys/sells within the minute
    // Multiple small ticks within the candle to create realistic wicks
    const numTicks = 4 + Math.floor(Math.random() * 4); // 4-7 micro ticks per candle
    for (let i = 0; i < numTicks; i++) {
      const volatility = 0.002 + Math.random() * 0.006; // 0.2% to 0.8% per tick — realistic
      const direction = Math.random() < 0.51 ? 1 : -1;  // nearly 50/50
      const tickPrice = Math.max(1, Math.round(acc.lastPrice * (1 + direction * volatility)));
      acc.high = Math.max(acc.high, tickPrice);
      acc.low  = Math.min(acc.low,  tickPrice);
      acc.lastPrice = tickPrice;
    }
    // Write final price back to the firm object so share_price reflects volatility
    if (_onVolatilityTick) _onVolatilityTick(ticker, acc.lastPrice);
    if (nowMin > acc.startMin) {
      _closeCandle(ticker, acc, nowMin);
    }
  }
  // Persist candles to Supabase after each tick
  saveFirmCandles().catch(() => {});
}

function _closeCandle(ticker, acc, nowMin) {
  const candles = firmCandles.get(ticker) || [];
  const hh = new Date().getHours().toString().padStart(2, "0");
  const mm = new Date().getMinutes().toString().padStart(2, "0");
  candles.push({
    o: acc.open,
    h: acc.high,
    l: acc.low,
    c: acc.lastPrice,
    label: `${hh}:${mm}`,
  });
  if (candles.length > MAX_CANDLES) candles.shift();
  firmCandles.set(ticker, candles);

  // Reset accumulator for the new minute
  acc.open      = acc.lastPrice;
  acc.high      = acc.lastPrice;
  acc.low       = acc.lastPrice;
  acc.startMin  = nowMin;
}

/** Seed a firm into the accumulator if it isn't there yet (call on load). */
function seedFirmCandle(ticker, currentPrice) {
  ticker = ticker.toUpperCase();
  if (!candleAccum.has(ticker)) {
    const nowMin = Math.floor(Date.now() / 60000);
    candleAccum.set(ticker, {
      open: currentPrice, high: currentPrice, low: currentPrice,
      lastPrice: currentPrice, startMin: nowMin,
    });
  }
}

/** Returns the candle array for a ticker. */
function getFirmCandles(ticker) {
  return firmCandles.get(ticker.toUpperCase()) || [];
}

/** Directly set/replace candles for a ticker (used by forceFirmPumpCrash). */
function setFirmCandles(ticker, candles) {
  firmCandles.set(ticker.toUpperCase(), candles);
  saveFirmCandles().catch(() => {});
}

// ── Layout (matches stockchart.js panel layout) ───────────────────────────────
const CELL_W      = 560;
const CELL_H      = 340;
const PAD         = 18;
const HEADER_H    = 52;
const CHART_PAD_T = 14;
const CHART_PAD_B = 34;
const CHART_PAD_L = 68;
const CHART_PAD_R = 16;
const TITLE_H     = 56;

// Helpers ──────────────────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function formatPrice(copper) {
  if (copper >= 1000000) return (copper / 1000000).toFixed(2) + "St";
  if (copper >= 10000)   return (copper / 10000).toFixed(2) + "G";
  if (copper >= 100)     return (copper / 100).toFixed(1) + "S";
  return copper + "C";
}

function niceRange(min, max) {
  const pad = (max - min) * 0.10 || max * 0.06;
  return { lo: Math.max(0, min - pad), hi: max + pad };
}

/** Compute 24h change % from available candle history (or 0 if none). */
function computeChange(firm, candles) {
  if (!candles || candles.length < 2) return 0;
  const oldest = candles[0].o;
  if (!oldest || oldest === 0) return 0;
  return ((firm.share_price - oldest) / oldest) * 100;
}

// ── Draw one firm chart cell ───────────────────────────────────────────────────
function drawFirmChart(ctx, cellX, cellY, firm, candles) {
  const accentColor  = getAccent(firm.ticker);
  const currentPrice = firm.share_price;
  const changePercent = computeChange(firm, candles);
  const isUp = changePercent >= 0;

  // Cell background
  roundRect(ctx, cellX, cellY, CELL_W, CELL_H, 10);
  ctx.fillStyle = "#0d1117";
  ctx.fill();
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── Header ────────────────────────────────────────────────────────────────
  roundRect(ctx, cellX, cellY, CELL_W, HEADER_H, 10);
  ctx.fillStyle = C.headerBg;
  ctx.fill();

  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cellX, cellY + HEADER_H);
  ctx.lineTo(cellX + CELL_W, cellY + HEADER_H);
  ctx.stroke();

  // Accent left stripe
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.roundRect(cellX, cellY + 10, 4, HEADER_H - 20, 2);
  ctx.fill();

  // Ticker name
  ctx.font = "bold 20px monospace";
  ctx.fillStyle = accentColor;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(firm.ticker, cellX + 18, cellY + 10);

  // Firm name (sub-label)
  ctx.font = "12px monospace";
  ctx.fillStyle = C.textMuted;
  ctx.fillText(firm.name.slice(0, 28), cellX + 18, cellY + 33);

  // Price (right aligned)
  ctx.font = "bold 18px monospace";
  ctx.fillStyle = C.textPrimary;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(formatPrice(currentPrice), cellX + CELL_W - 16, cellY + 8);

  // Change %
  ctx.font = "bold 13px monospace";
  ctx.fillStyle = isUp ? C.up : C.down;
  ctx.fillText(
    `${isUp ? "▲" : "▼"} ${Math.abs(changePercent).toFixed(2)}%`,
    cellX + CELL_W - 16, cellY + 31
  );

  // Live dot (firms are always "live")
  ctx.beginPath();
  ctx.arc(cellX + CELL_W - 8, cellY + 8, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#26a69a";
  ctx.fill();

  // ── Chart area ────────────────────────────────────────────────────────────
  const chartX = cellX + CHART_PAD_L;
  const chartY = cellY + HEADER_H + CHART_PAD_T;
  const chartW = CELL_W - CHART_PAD_L - CHART_PAD_R;
  const chartH = CELL_H - HEADER_H - CHART_PAD_T - CHART_PAD_B;

  ctx.fillStyle = "#080b10";
  ctx.fillRect(chartX, chartY, chartW, chartH);

  if (!candles || candles.length < 1) {
    ctx.font = "13px monospace";
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Accumulating data...", chartX + chartW / 2, chartY + chartH / 2);
    ctx.font = "10px monospace";
    ctx.fillText("First candle appears in ~1 min", chartX + chartW / 2, chartY + chartH / 2 + 20);
    return;
  }

  // Show last 20 candles (same as stockchart panel view)
  const displayCandles = candles.slice(-20);
  const { lo, hi } = niceRange(
    Math.min(...displayCandles.map(c => c.l)),
    Math.max(...displayCandles.map(c => c.h))
  );
  const priceRange = hi - lo || 1;
  const toY = (price) => chartY + chartH - ((price - lo) / priceRange) * chartH;

  // Grid lines + price labels
  for (let i = 0; i <= 5; i++) {
    const price = lo + (priceRange * i) / 5;
    const gy = toY(price);
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = C.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartX, gy);
    ctx.lineTo(chartX + chartW, gy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "10px monospace";
    ctx.fillStyle = "#3d4a5c";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(formatPrice(Math.round(price)), chartX - 4, gy);
  }

  // Current price dashed line
  const curY = toY(currentPrice);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(99,120,255,0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(chartX, curY);
  ctx.lineTo(chartX + chartW, curY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Price tag badge
  ctx.fillStyle = "rgba(61,90,254,0.85)";
  roundRect(ctx, chartX + chartW - 52, curY - 9, 52, 18, 3);
  ctx.fill();
  ctx.font = "bold 9px monospace";
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(formatPrice(currentPrice), chartX + chartW - 26, curY);

  // ── Candles ──────────────────────────────────────────────────────────────
  const n = displayCandles.length;
  const candleAreaW = chartW / n;
  const bodyW = Math.min(20, Math.max(4, candleAreaW * 0.6));

  for (let i = 0; i < n; i++) {
    const c = displayCandles[i];
    const cx = chartX + i * candleAreaW + candleAreaW / 2;
    const isGreen = c.c >= c.o;
    const col = isGreen ? C.up : C.down;

    const highY  = toY(c.h);
    const lowY   = toY(c.l);
    const bodyTop = Math.min(toY(c.o), toY(c.c));
    const bodyH   = Math.max(1.5, Math.abs(toY(c.o) - toY(c.c)));

    // Wick
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, bodyW * 0.12);
    ctx.beginPath();
    ctx.moveTo(cx, highY);
    ctx.lineTo(cx, lowY);
    ctx.stroke();

    // Body
    ctx.fillStyle = col;
    ctx.fillRect(cx - bodyW / 2, bodyTop, bodyW, bodyH);

    // Glow on latest candle
    if (i === n - 1) {
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
      ctx.fillRect(cx - bodyW / 2, bodyTop, bodyW, bodyH);
      ctx.shadowBlur = 0;
    }
  }

  // Time labels
  ctx.font = "9px monospace";
  ctx.fillStyle = "#3d4a5c";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labelEvery = Math.max(1, Math.floor(n / 5));
  for (let i = 0; i < n; i += labelEvery) {
    const cx = chartX + i * candleAreaW + candleAreaW / 2;
    ctx.fillText(displayCandles[i].label || `-${n - i}m`, cx, chartY + chartH + 5);
  }
}

// ── Render a firm panel (3 firms per row, multi-row if needed) ────────────────
/**
 * @param {Array} firms  — array of firm objects from firmCache
 *                         Each must have: { ticker, name, share_price }
 * @returns {Buffer}     — PNG image buffer
 */
function renderFirmPanel(firms) {
  const COLS = 3;
  const rows = Math.ceil(firms.length / COLS);

  const TOTAL_W = COLS * CELL_W + (COLS + 1) * PAD;
  const TOTAL_H = TITLE_H + rows * CELL_H + (rows + 1) * PAD + 20; // 20 footer

  const canvas = createCanvas(TOTAL_W, TOTAL_H);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, TOTAL_W, TOTAL_H);

  // Dot grid
  ctx.fillStyle = "rgba(255,255,255,0.018)";
  for (let x = 0; x < TOTAL_W; x += 32) {
    for (let y = 0; y < TOTAL_H; y += 32) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Title bar ─────────────────────────────────────────────────────────────
  ctx.fillStyle = "#080b10";
  ctx.fillRect(0, 0, TOTAL_W, TITLE_H);

  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, TITLE_H);
  ctx.lineTo(TOTAL_W, TITLE_H);
  ctx.stroke();

  ctx.font = "bold 22px monospace";
  ctx.fillStyle = "#e0e6f0";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("🏢 EMPIRE FIRM EXCHANGE", 20, TITLE_H / 2 - 4);

  const now = new Date();
  const timeStr = now.toUTCString().slice(17, 22) + " UTC";
  ctx.font = "12px monospace";
  ctx.fillStyle = C.textMuted;
  ctx.fillText(`${firms.length} firm${firms.length !== 1 ? "s" : ""} listed  •  ${timeStr}`, 20, TITLE_H / 2 + 14);

  ctx.font = "bold 12px monospace";
  ctx.fillStyle = C.up;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText("● LIVE", TOTAL_W - 16, TITLE_H / 2);

  // ── Charts ────────────────────────────────────────────────────────────────
  firms.forEach((firm, idx) => {
    const col    = idx % COLS;
    const row    = Math.floor(idx / COLS);
    const cellX  = PAD + col * (CELL_W + PAD);
    const cellY  = TITLE_H + PAD + row * (CELL_H + PAD);
    const candles = getFirmCandles(firm.ticker);
    drawFirmChart(ctx, cellX, cellY, firm, candles);
  });

  // Footer hint
  ctx.font = "10px monospace";
  ctx.fillStyle = "#2a3040";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(
    "Knight stock firm  •  Knight firm buy [TICKER] [shares]  •  Knight firm sell [TICKER] [shares]",
    TOTAL_W / 2, TOTAL_H - 3
  );

  return canvas.toBuffer("image/png");
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  renderFirmPanel,
  onFirmPriceChange,
  tickFirmCandles,
  seedFirmCandle,
  getFirmCandles,
  setFirmCandles,
  formatPrice,
  registerPriceUpdateCallback,
  registerSupabase,
  loadFirmCandles,
  saveFirmCandles,
};
