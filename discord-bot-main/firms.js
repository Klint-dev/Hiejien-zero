// ═══════════════════════════════════════════════════════════════════════════════
// firms.js — Empire Firms / Mutual Funds System
// ═══════════════════════════════════════════════════════════════════════════════

const { createClient } = require("@supabase/supabase-js");
const eco = require("./economy.js");
const firmChart = require("./firmchart.js");

let supabase;
let MASTER_ID;
let discordClient;
let GENERAL_CHANNEL_ID;

const FIRM_CREATION_FEE = 50 * 1000000; // 50 Stellar in copper
const MAX_FIRMS_PER_USER = 1;

// In-memory firm cache
const firmCache = new Map(); // ticker -> firm object
// In-memory cost basis: userId -> { [ticker]: { shares, totalCost } }
const costBasis = new Map();

function getCostBasis(userId, ticker) {
  if (!costBasis.has(userId)) costBasis.set(userId, {});
  return costBasis.get(userId)[ticker] || { shares: 0, totalCost: 0 };
}

function addCostBasis(userId, ticker, shares, costCopper) {
  if (!costBasis.has(userId)) costBasis.set(userId, {});
  const cb = costBasis.get(userId);
  if (!cb[ticker]) cb[ticker] = { shares: 0, totalCost: 0 };
  cb[ticker].shares    += shares;
  cb[ticker].totalCost += costCopper;
}

function reduceCostBasis(userId, ticker, sharesSold) {
  if (!costBasis.has(userId)) return;
  const cb = costBasis.get(userId);
  if (!cb[ticker]) return;
  const ratio = sharesSold / (cb[ticker].shares || 1);
  cb[ticker].totalCost = Math.floor(cb[ticker].totalCost * (1 - ratio));
  cb[ticker].shares   -= sharesSold;
  if (cb[ticker].shares <= 0) delete cb[ticker];
}

// ── Cost basis Supabase persistence ──────────────────────────────────────────
// Table: firm_holdings  columns: user_id text PK, holdings jsonb
// holdings JSON shape: { "TICKER": { shares, totalCost }, ... }

async function dbSaveCostBasis(userId) {
  try {
    const data = costBasis.get(userId) || {};
    await supabase.from("firm_holdings").upsert(
      { user_id: userId, holdings: JSON.stringify(data) },
      { onConflict: "user_id" }
    );
  } catch (e) { console.error("[FIRM HOLDINGS SAVE]", e.message); }
}

async function loadAllCostBasis() {
  try {
    const { data } = await supabase.from("firm_holdings").select("*");
    if (!data) return;
    for (const row of data) {
      try {
        const parsed = typeof row.holdings === "string" ? JSON.parse(row.holdings) : row.holdings;
        if (parsed && typeof parsed === "object") costBasis.set(row.user_id, parsed);
      } catch {}
    }
    console.log(`[FIRM HOLDINGS] Loaded cost basis for ${data.length} user(s)`);
  } catch (e) { console.error("[FIRM HOLDINGS LOAD]", e.message); }
}

// Pending creation confirmations: userId -> { name, ticker, sharePriceCu, timestamp }
const pendingCreations = new Map();
// Sanction auto-dump timers: ticker -> timeoutId
const sanctionTimers = new Map();

function initFirms(masterId, supabaseUrl, supabaseKey, clientRef, generalChannelId) {
  MASTER_ID = masterId;
  discordClient = clientRef;
  GENERAL_CHANNEL_ID = generalChannelId;
  supabase = createClient(supabaseUrl, supabaseKey);
  firmChart.registerSupabase(supabase);

  // Register volatility callback — keeps firm.share_price live with candle ticks
  firmChart.registerPriceUpdateCallback(async (ticker, newPrice) => {
    const firm = firmCache.get(ticker);
    if (!firm || firm.dissolved) return;
    if (firm.share_price === newPrice) return;
    firm.share_price = newPrice;
    // Throttle Supabase writes — only save every 5 ticks to avoid hammering DB
    firm._volatilityTicks = (firm._volatilityTicks || 0) + 1;
    if (firm._volatilityTicks >= 5) {
      firm._volatilityTicks = 0;
      await dbSaveFirm(firm);
    }
  });

  console.log("🏢 Firms system initialized");
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function dbLoadFirm(ticker) {
  try {
    const { data } = await supabase.from("firms").select("*").eq("ticker", ticker.toUpperCase()).single();
    return data || null;
  } catch { return null; }
}

async function dbSaveFirm(firm) {
  try {
    await supabase.from("firms").upsert({
      ticker:        firm.ticker,
      name:          firm.name,
      owner_id:      firm.owner_id,
      share_price:   firm.share_price,
      total_shares:  firm.total_shares,
      treasury:      firm.treasury,
      holdings:      JSON.stringify(firm.holdings),
      sanctions:     JSON.stringify(firm.sanctions),
      strikes:       firm.strikes,
      dissolved:     firm.dissolved,
      created_at:    firm.created_at,
      total_dividends_paid: firm.total_dividends_paid,
    }, { onConflict: "ticker" });
  } catch (e) { console.error("[FIRMS SAVE]", e.message); }
}

async function loadAllFirms() {
  try {
    const { data } = await supabase.from("firms").select("*").eq("dissolved", false);
    if (!data) return;
    for (const row of data) {
      firmCache.set(row.ticker, hydrate(row));
      firmChart.seedFirmCandle(row.ticker, Number(row.share_price));
    }
    console.log(`[FIRMS] Loaded ${firmCache.size} active firm(s)`);
  } catch (e) { console.error("[FIRMS LOAD]", e.message); }
  await loadAllCostBasis();
  await firmChart.loadFirmCandles();
}

function hydrate(row) {
  return {
    ticker:              row.ticker,
    name:                row.name,
    owner_id:            row.owner_id,
    share_price:         Number(row.share_price),
    total_shares:        Number(row.total_shares),
    treasury:            Number(row.treasury),
    holdings:            typeof row.holdings === "string" ? JSON.parse(row.holdings) : (row.holdings || {}),
    sanctions:           typeof row.sanctions === "string" ? JSON.parse(row.sanctions) : (row.sanctions || []),
    strikes:             row.strikes || 0,
    dissolved:           row.dissolved || false,
    created_at:          row.created_at || new Date().toISOString(),
    total_dividends_paid: Number(row.total_dividends_paid || 0),
  };
}

function getFirm(ticker) {
  return firmCache.get(ticker.toUpperCase()) || null;
}

// ── Price parser (e.g. "5s", "10g", "2st", "500c") ──────────────────────────

function parsePriceArg(str) {
  if (!str) return null;
  const clean = str.trim().toLowerCase();
  const m = clean.match(/^(\d+(?:\.\d+)?)(st|s|g|c)?$/);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (isNaN(val) || val <= 0) return null;
  const unit = m[2] || "c";
  if (unit === "st") return Math.floor(val * 1000000);
  if (unit === "g")  return Math.floor(val * 10000);
  if (unit === "s")  return Math.floor(val * 100);
  return Math.floor(val);
}

function formatCopper(cu) {
  if (cu >= 1000000) return `⭐ ${(cu / 1000000).toFixed(2)} Stellar`;
  if (cu >= 10000)   return `🥇 ${(cu / 10000).toFixed(2)} Gold`;
  if (cu >= 100)     return `🪙 ${(cu / 100).toFixed(2)} Silver`;
  return `🟤 ${cu} Copper`;
}

// ── Spike announcement ───────────────────────────────────────────────────────
async function announceFirmSpike(firm, userId, shares, oldPrice, newPrice, isBuy) {
  if (!discordClient || !GENERAL_CHANNEL_ID) return;
  const channel = discordClient.channels.cache.get(GENERAL_CHANNEL_ID);
  if (!channel) return;
  const pct = Math.abs(((newPrice - oldPrice) / oldPrice) * 100).toFixed(1);
  const dir = isBuy ? "📈" : "📉";
  const action = isBuy ? "bought" : "sold";
  const emoji = isBuy ? "🚀" : "💥";
  await channel.send(
    `${emoji} **FIRM ${isBuy ? "SPIKE" : "DIP"} — ${firm.name}** (\`${firm.ticker}\`)
` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` +
    `<@${userId}> just **${action} ${shares.toLocaleString()} shares** — price moved **${pct}%**
` +
    `${dir} ${formatCopper(oldPrice)} → **${formatCopper(newPrice)}**
` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  ).catch(() => {});
}

// ── Rules text ───────────────────────────────────────────────────────────────

const FIRM_RULES = [
  "No coordinated pump-and-dump or mass market manipulation.",
  "No insider trading — do not use private server knowledge to front-run trades.",
  "Do not mislead investors about your firm's value, assets, or intentions.",
  "Do not use the firm treasury for personal gain outside dividends.",
  "Share price changes must be reasonable — rug-pulling investors will be sanctioned.",
  "The King may sanction, crash, or dissolve your firm at any time for violations.",
  "The 50 Stellar creation fee is non-refundable under all circumstances.",
  "One firm per user. You may not own multiple firms.",
];

// ── FIRM CREATION ────────────────────────────────────────────────────────────

async function initiateFirmCreation(userId, name, ticker, sharePriceStr) {
  ticker = ticker.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
  if (!ticker || ticker.length < 2) return "⚔️ Ticker must be 2–5 letters (e.g. `KING`, `IRON`).";
  if (!name || name.trim().length < 2) return "⚔️ Firm name must be at least 2 characters.";
  if (name.trim().length > 32) return "⚔️ Firm name too long — max 32 characters.";

  const sharePriceCu = parsePriceArg(sharePriceStr);
  if (!sharePriceCu || sharePriceCu < 100) return "⚔️ Invalid share price. Minimum is **1 Silver** (1s). Example: `5s` `10g` `2st`.";
  if (sharePriceCu > 1000 * 1000000) return "⚔️ Share price too high. Maximum starting price is **1000 Stellar**.";

  const owned = [...firmCache.values()].filter(f => f.owner_id === userId && !f.dissolved);
  if (owned.length >= MAX_FIRMS_PER_USER) return `⚔️ You already own a firm (**${owned[0].ticker}**). One firm per user.`;

  const existing = await dbLoadFirm(ticker);
  if (existing && !existing.dissolved) return `⚔️ Ticker **${ticker}** is already taken. Choose another.`;

  const wallet = await eco.getWallet(userId);
  const balance = eco.walletToCopper(wallet);
  if (balance < FIRM_CREATION_FEE) return `⚔️ You need **⭐ 50 Stellar** to create a firm. You have ${formatCopper(balance)}.`;

  pendingCreations.set(userId, {
    name: name.trim(),
    ticker,
    sharePriceCu,
    expiresAt: Date.now() + 2 * 60 * 1000,
  });

  const rules = FIRM_RULES.map((r, i) => `  ${i + 1}. ${r}`).join("\n");

  return (
    `🏢 **EMPIRE FIRM CREATION — REVIEW & CONFIRM**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `**Firm Name:** ${name.trim()}\n` +
    `**Ticker:** \`${ticker}\`\n` +
    `**Starting Share Price:** ${formatCopper(sharePriceCu)}\n` +
    `**Creation Fee:** ⭐ 50 Stellar *(non-refundable)*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📜 **EMPIRE FIRM RULES — YOU MUST ABIDE BY ALL OF THESE:**\n${rules}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ Violations result in **sanctions, share crashes, or dissolution**.\n\n` +
    `Say **Knight firm confirm** to proceed or **Knight firm cancel** to abort.\n` +
    `*You have 2 minutes.*`
  );
}

async function confirmFirmCreation(userId) {
  const pending = pendingCreations.get(userId);
  if (!pending) return "⚔️ No pending firm creation. Use **Knight firm create [Name] [TICKER] [price]** first.";
  if (Date.now() > pending.expiresAt) {
    pendingCreations.delete(userId);
    return "⚔️ Confirmation window expired. Start over with **Knight firm create**.";
  }

  const deducted = await eco.deductCopper(userId, FIRM_CREATION_FEE);
  if (!deducted) {
    pendingCreations.delete(userId);
    return "⚔️ Insufficient funds — you need ⭐ 50 Stellar. Creation cancelled.";
  }

  const existing = await dbLoadFirm(pending.ticker);
  if (existing && !existing.dissolved) {
    await eco.addCopper(userId, FIRM_CREATION_FEE);
    pendingCreations.delete(userId);
    return `⚔️ Ticker **${pending.ticker}** was just taken. Refunded. Try a different ticker.`;
  }

  const firm = {
    ticker:              pending.ticker,
    name:                pending.name,
    owner_id:            userId,
    share_price:         pending.sharePriceCu,
    total_shares:        0,
    treasury:            0,
    holdings:            {},
    sanctions:           [],
    strikes:             0,
    dissolved:           false,
    created_at:          new Date().toISOString(),
    total_dividends_paid: 0,
  };

  firmCache.set(firm.ticker, firm);
  await dbSaveFirm(firm);
  firmChart.seedFirmCandle(firm.ticker, firm.share_price);
  pendingCreations.delete(userId);

  return (
    `🏢 **FIRM ESTABLISHED!** ⚔️\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `**${firm.name}** (\`${firm.ticker}\`) is now registered in the Empire.\n` +
    `📈 Starting share price: **${formatCopper(firm.share_price)}**\n` +
    `💰 Entry fee paid: ⭐ 50 Stellar\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Issue shares: **Knight firm issue ${firm.ticker} [amount]**\n` +
    `Investors buy: **Knight firm buy ${firm.ticker} [shares]**\n` +
    `*Build your empire wisely. The King is watching.* 👑`
  );
}

function cancelFirmCreation(userId) {
  if (!pendingCreations.has(userId)) return "⚔️ No pending firm creation to cancel.";
  pendingCreations.delete(userId);
  return "✅ Firm creation cancelled.";
}

// ── SHARE ISSUANCE ───────────────────────────────────────────────────────────

async function issueFirmShares(userId, ticker, amount) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No firm with ticker **${ticker.toUpperCase()}**. Check **Knight firm list**.`;
  if (firm.owner_id !== userId) return "⚔️ Only the firm owner can issue shares.";
  if (firm.dissolved) return "⚔️ This firm has been dissolved.";
  if (amount < 1 || amount > 10000000) return "⚔️ Issue between 1 and 10,000,000 shares at a time.";

  const totalCost = firm.share_price * amount;
  const deducted = await eco.deductCopper(userId, totalCost);
  if (!deducted) {
    return (
      `⚔️ You need **${formatCopper(totalCost)}** to issue ${amount.toLocaleString()} shares at **${formatCopper(firm.share_price)}** each.\n` +
      `*Issuing shares funds the treasury — you are backing them with real capital.*`
    );
  }

  firm.total_shares += amount;
  firm.treasury += totalCost;
  await dbSaveFirm(firm);

  const shareholders = Object.keys(firm.holdings).filter(id => id !== userId);
  const dilutionNote = shareholders.length > 0
    ? `\n⚠️ *${shareholders.length} shareholder(s) have been diluted — their ownership % has decreased.*`
    : "";

  return (
    `📋 **${amount.toLocaleString()} shares issued** for **${firm.name}** (\`${firm.ticker}\`)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💸 Cost paid: **${formatCopper(totalCost)}** → firm treasury\n` +
    `🏦 New treasury: **${formatCopper(firm.treasury)}**\n` +
    `📊 Total shares outstanding: **${firm.total_shares.toLocaleString()}**\n` +
    `📈 Share price: **${formatCopper(firm.share_price)}**` +
    dilutionNote
  );
}

// ── PRICE SET ────────────────────────────────────────────────────────────────

async function setFirmSharePrice(userId, ticker, priceStr) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No firm with ticker **${ticker.toUpperCase()}**.`;
  if (firm.owner_id !== userId) return "⚔️ Only the firm owner can set the share price.";
  if (firm.dissolved) return "⚔️ This firm has been dissolved.";

  const locked = firm.sanctions.some(s => s.type === "price_lock");
  const newPrice = parsePriceArg(priceStr);
  if (!newPrice || newPrice < 1) return "⚔️ Invalid price. Min 1 Copper. Examples: `5s` `10g` `2st` `500c`.";
  if (locked && newPrice > firm.share_price) return "⚔️ Your firm is **sanctioned** — you cannot raise the share price while under sanctions.";

  const old = firm.share_price;
  firm.share_price = newPrice;
  firmChart.onFirmPriceChange(firm.ticker, firm.share_price);
  await dbSaveFirm(firm);
  const dir = newPrice > old ? "📈" : newPrice < old ? "📉" : "➡️";
  return (
    `${dir} **${firm.name}** share price updated\n` +
    `${formatCopper(old)} → **${formatCopper(newPrice)}**`
  );
}

// ── BUY SHARES ───────────────────────────────────────────────────────────────

async function buyFirmShares(userId, ticker, amount) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No firm with ticker **${ticker.toUpperCase()}**. Check **Knight firm list**.`;
  if (firm.dissolved) return "⚔️ This firm has been dissolved.";

  const tradeBan = firm.sanctions.some(s => s.type === "trading_ban");
  if (tradeBan) return `⛔ **${firm.name}** (\`${ticker.toUpperCase()}\`) is under a **trading ban** — no purchases allowed.`;

  if (amount < 1) return "⚔️ Minimum 1 share.";
  const availableShares = firm.total_shares - Object.values(firm.holdings).reduce((a, b) => a + b, 0);
  if (amount > availableShares) return `⚔️ Only **${availableShares.toLocaleString()}** shares available to buy.`;

  const cost = firm.share_price * amount;
  const isSanctioned = firm.sanctions.length > 0;
  const taxAmount = isSanctioned ? Math.floor(cost * 0.20) : 0;
  const firmReceives = cost - taxAmount;

  const deducted = await eco.deductCopper(userId, cost);
  if (!deducted) return `⚔️ You need **${formatCopper(cost)}** to buy ${amount} share(s) of **${firm.name}**.`;

  if (taxAmount > 0) await eco.addCopper(MASTER_ID, taxAmount);

  // Price impact from large buys: 500=~1%, 1000=~2%, 5000=~5%, capped at 10%
  const oldPriceBuy = firm.share_price;
  const buyImpact = Math.min(0.10, (amount / 50000));
  if (buyImpact > 0.005) {
    firm.share_price = Math.round(firm.share_price * (1 + buyImpact));
    firmChart.onFirmPriceChange(firm.ticker, firm.share_price);
  }

  firm.holdings[userId] = (firm.holdings[userId] || 0) + amount;
  firm.treasury += firmReceives;
  await dbSaveFirm(firm);

  // Track cost basis and persist
  addCostBasis(userId, firm.ticker, amount, cost);
  await dbSaveCostBasis(userId);

  // Announce spike if price moved >= 2%
  if (buyImpact >= 0.02) announceFirmSpike(firm, userId, amount, oldPriceBuy, firm.share_price, true);

  const sanctionLine = taxAmount > 0
    ? `\n⚠️ *Firm is sanctioned — ${formatCopper(taxAmount)} sanction tax sent to the King.*`
    : "";

  return (
    `📈 **Purchased ${amount.toLocaleString()} share(s)** of **${firm.name}** (\`${ticker.toUpperCase()}\`)\n` +
    `💰 Cost: **${formatCopper(cost)}**\n` +
    `📊 You now hold: **${firm.holdings[userId].toLocaleString()} share(s)**\n` +
    `💵 Your value: **${formatCopper(firm.holdings[userId] * firm.share_price)}**` +
    sanctionLine
  );
}

// ── SELL SHARES ──────────────────────────────────────────────────────────────

async function sellFirmShares(userId, ticker, amount) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No firm with ticker **${ticker.toUpperCase()}**.`;
  if (firm.dissolved) return "⚔️ This firm is dissolved — shares were already refunded.";

  const shareLock = firm.sanctions.some(s => s.type === "share_lock");
  if (shareLock) return `⛔ **${firm.name}** is under a **share lock** — no buying or selling allowed.`;

  const owned = firm.holdings[userId] || 0;
  if (owned < amount) return `⚔️ You only own **${owned.toLocaleString()}** share(s).`;
  if (amount < 1) return "⚔️ Minimum 1 share.";

  const payout = firm.share_price * amount;
  if (firm.treasury < payout) return `⚔️ Firm treasury too low to cover this sale. Treasury: **${formatCopper(firm.treasury)}**. Ask the owner to deposit funds.`;

  // Price impact from large sells
  const oldPriceSell = firm.share_price;
  const sellImpact = Math.min(0.10, (amount / 50000));
  if (sellImpact > 0.005) {
    firm.share_price = Math.max(1, Math.round(firm.share_price * (1 - sellImpact)));
    firmChart.onFirmPriceChange(firm.ticker, firm.share_price);
  }

  firm.holdings[userId] -= amount;
  if (firm.holdings[userId] <= 0) delete firm.holdings[userId];
  firm.treasury -= payout;
  await eco.addCopper(userId, payout);

  // Update cost basis and persist
  reduceCostBasis(userId, firm.ticker, amount);
  await dbSaveCostBasis(userId);
  await dbSaveFirm(firm);

  // Announce dip if price moved >= 2%
  if (sellImpact >= 0.02) announceFirmSpike(firm, userId, amount, oldPriceSell, firm.share_price, false);

  return (
    `📉 **Sold ${amount.toLocaleString()} share(s)** of **${firm.name}** (\`${ticker.toUpperCase()}\`)\n` +
    `💰 Received: **${formatCopper(payout)}**\n` +
    `📊 Remaining shares: **${(firm.holdings[userId] || 0).toLocaleString()}**`
  );
}

// ── DEPOSIT TO TREASURY ───────────────────────────────────────────────────────

async function depositToFirm(userId, ticker, priceStr) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No firm with ticker **${ticker.toUpperCase()}**.`;
  if (firm.owner_id !== userId) return "⚔️ Only the firm owner can deposit into the treasury.";
  if (firm.dissolved) return "⚔️ This firm has been dissolved.";

  const amount = parsePriceArg(priceStr);
  if (!amount || amount < 1) return "⚔️ Invalid amount. Examples: `5s` `10g` `2st` `500c`.";

  const deducted = await eco.deductCopper(userId, amount);
  if (!deducted) return `⚔️ You need **${formatCopper(amount)}** to deposit.`;

  firm.treasury += amount;
  await dbSaveFirm(firm);

  return (
    `🏦 **${formatCopper(amount)} deposited** into **${firm.name}** treasury\n` +
    `New treasury balance: **${formatCopper(firm.treasury)}**`
  );
}

// ── DIVIDENDS ────────────────────────────────────────────────────────────────

async function payDividends(userId, ticker, totalAmountCu) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No firm with ticker **${ticker.toUpperCase()}**.`;
  if (firm.owner_id !== userId) return "⚔️ Only the firm owner can pay dividends.";
  if (firm.dissolved) return "⚔️ This firm has been dissolved.";

  const frozen = firm.sanctions.some(s => s.type === "dividend_freeze");
  if (frozen) return `⛔ **${firm.name}** has a **dividend freeze** sanction — cannot pay dividends.`;

  if (firm.treasury < totalAmountCu) return `⚔️ Treasury only has **${formatCopper(firm.treasury)}**.`;

  const totalShares = Object.values(firm.holdings).reduce((a, b) => a + b, 0);
  if (totalShares === 0) return "⚔️ No shareholders to pay dividends to.";

  firm.treasury -= totalAmountCu;
  firm.total_dividends_paid += totalAmountCu;
  const perShare = totalAmountCu / totalShares;
  const results = [];

  for (const [hId, shares] of Object.entries(firm.holdings)) {
    const payout = Math.floor(perShare * shares);
    if (payout > 0) {
      await eco.addCopper(hId, payout);
      results.push({ hId, shares, payout });
    }
  }

  await dbSaveFirm(firm);

  const lines = results.map(r => `  <@${r.hId}> — ${r.shares} shares → **${formatCopper(r.payout)}**`).join("\n");
  return (
    `💸 **DIVIDENDS PAID — ${firm.name}** (\`${firm.ticker}\`)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Total distributed: **${formatCopper(totalAmountCu)}**\n` +
    `Per share: **${formatCopper(Math.floor(perShare))}**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    lines
  );
}

// ── INFO / LIST / PORTFOLIO ───────────────────────────────────────────────────

async function getFirmInfo(ticker) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No active firm with ticker **${ticker.toUpperCase()}**. Check **Knight firm list**.`;

  const totalShares = Object.values(firm.holdings).reduce((a, b) => a + b, 0);
  const available = firm.total_shares - totalShares;
  const marketCap = firm.share_price * firm.total_shares;

  const sanctionLines = firm.sanctions.length > 0
    ? `\n⚠️ **SANCTIONS ACTIVE (${firm.sanctions.length})**\n` +
      firm.sanctions.map(s => `  🔴 **${s.type.replace(/_/g, " ").toUpperCase()}** — *${s.reason}*`).join("\n")
    : "";

  const strikeLine = firm.strikes > 0 ? `\n⚠️ Strikes: **${firm.strikes}/3**` : "";

  return (
    `🏢 **${firm.name}** (\`${firm.ticker}\`)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👑 Owner: <@${firm.owner_id}>\n` +
    `📈 Share Price: **${formatCopper(firm.share_price)}**\n` +
    `📊 Total Issued: **${firm.total_shares.toLocaleString()}** | Available: **${available.toLocaleString()}** | Sold: **${totalShares.toLocaleString()}**\n` +
    `💰 Treasury: **${formatCopper(firm.treasury)}**\n` +
    `📉 Market Cap: **${formatCopper(marketCap)}**\n` +
    `💸 Total Dividends Paid: **${formatCopper(firm.total_dividends_paid)}**\n` +
    `📅 Founded: <t:${Math.floor(new Date(firm.created_at).getTime() / 1000)}:D>` +
    strikeLine +
    sanctionLines +
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Buy shares: **Knight firm buy ${firm.ticker} [shares]**`
  );
}

async function listFirms() {
  const active = [...firmCache.values()].filter(f => !f.dissolved);
  if (!active.length) return "🏢 No firms registered in the Empire yet. Be the first — **Knight firm create**.";

  const lines = active.map(f => {
    const sanctionMark = f.sanctions.length > 0 ? " ⚠️" : "";
    return `\`${f.ticker}\` **${f.name}**${sanctionMark} — Price: ${formatCopper(f.share_price)} | Shareholders: ${Object.keys(f.holdings).length} | Cap: ${formatCopper(f.share_price * f.total_shares)}`;
  });

  return (
    `🏢 **EMPIRE FIRM REGISTRY**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    lines.join("\n") +
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Details: **Knight firm info [TICKER]***`
  );
}

async function getMyFirmShares(userId) {
  const holdings = [];
  for (const firm of firmCache.values()) {
    if (firm.dissolved) continue;
    const shares = firm.holdings[userId];
    if (shares > 0) holdings.push({ firm, shares, value: shares * firm.share_price });
  }

  const owned = [...firmCache.values()].filter(f => f.owner_id === userId && !f.dissolved);

  if (!holdings.length && !owned.length) return "🏢 You have no firm holdings. Browse with **Knight firm list**.";

  const lines = [`🏢 **YOUR FIRM PORTFOLIO**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];

  if (owned.length) {
    lines.push(`**👑 Owned Firms:**`);
    for (const f of owned) {
      lines.push(`  \`${f.ticker}\` **${f.name}** — Treasury: ${formatCopper(f.treasury)} | Shareholders: ${Object.keys(f.holdings).length}`);
    }
  }

  if (holdings.length) {
    const totalValue   = holdings.reduce((a, h) => a + h.value, 0);
    let   totalCostAll = 0;
    lines.push(`\n**📊 Share Holdings:**`);
    for (const h of holdings) {
      const sanctionMark = h.firm.sanctions.length > 0 ? " ⚠️" : "";
      const cb           = getCostBasis(userId, h.firm.ticker);
      // If no cost basis tracked, fall back to first candle open (closest to actual buy price)
      const firstCandle  = firmChart.getFirmCandles(h.firm.ticker)[0];
      const fallbackPrice = firstCandle ? firstCandle.o : h.firm.share_price;
      const avgBuy       = cb.shares > 0 ? Math.floor(cb.totalCost / cb.shares) : fallbackPrice;
      const costBasisVal = avgBuy * h.shares;
      totalCostAll      += costBasisVal;
      const pnl          = h.value - costBasisVal;
      const pnlPct       = costBasisVal > 0 ? ((pnl / costBasisVal) * 100).toFixed(1) : "0.0";
      const pnlStr       = pnl >= 0
        ? `📈 +${formatCopper(pnl)} (+${pnlPct}%)`
        : `📉 -${formatCopper(Math.abs(pnl))} (${pnlPct}%)`;
      lines.push(`  \`${h.firm.ticker}\`${sanctionMark} **${h.firm.name}** — ${h.shares.toLocaleString()} shares @ ${formatCopper(h.firm.share_price)} = **${formatCopper(h.value)}**`);
      lines.push(`    avg buy: ${formatCopper(avgBuy)} | ${pnlStr}`);
    }
    const totalPnl    = totalValue - totalCostAll;
    const totalPnlPct = totalCostAll > 0 ? ((totalPnl / totalCostAll) * 100).toFixed(1) : "0.0";
    const totalPnlStr = totalPnl >= 0
      ? `📈 +${formatCopper(totalPnl)} (+${totalPnlPct}%)`
      : `📉 -${formatCopper(Math.abs(totalPnl))} (${totalPnlPct}%)`;
    lines.push(`\n💰 Total Value: **${formatCopper(totalValue)}** | P&L: ${totalPnlStr}`);
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  return lines.join("\n");
}

// ── KING COMMANDS ─────────────────────────────────────────────────────────────

async function kingDeleteFirm(ticker, reason) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No active firm **${ticker.toUpperCase()}**.`;

  const refunds = [];
  let totalRefunded = 0;
  for (const [hId, shares] of Object.entries(firm.holdings)) {
    const payout = Math.min(firm.share_price * shares, firm.treasury - totalRefunded);
    if (payout > 0) {
      await eco.addCopper(hId, payout);
      totalRefunded += payout;
      refunds.push(`  <@${hId}> — ${shares} shares → **${formatCopper(payout)}**`);
    }
  }

  const remainder = firm.treasury - totalRefunded;
  if (remainder > 0) await eco.addCopper(MASTER_ID, remainder);

  firm.dissolved = true;
  firm.holdings = {};
  firm.treasury = 0;
  firmCache.delete(firm.ticker);
  await dbSaveFirm(firm);

  const refundBlock = refunds.length
    ? `\n💸 **Shareholder Refunds:**\n${refunds.join("\n")}`
    : "\n*No shareholders to refund.*";

  return (
    `👑 **ROYAL DISSOLUTION — ${firm.name}** (\`${firm.ticker}\`)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `**Reason:** ${reason}\n` +
    `Total refunded: **${formatCopper(totalRefunded)}**\n` +
    `Remainder to Crown: **${formatCopper(remainder)}**` +
    refundBlock
  );
}

async function kingCrashFirmShares(ticker, percent, reason, channel) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No active firm **${ticker.toUpperCase()}**.`;
  if (percent < 1 || percent > 99) return "⚔️ Crash percent must be between 1 and 99.";

  const old = firm.share_price;
  firm.share_price = Math.max(1, Math.floor(old * (1 - percent / 100)));
  firmChart.onFirmPriceChange(firm.ticker, firm.share_price);
  await dbSaveFirm(firm);

  const shareholders = Object.keys(firm.holdings);
  if (shareholders.length && channel) {
    const pings = shareholders.map(id => `<@${id}>`).join(" ");
    await channel.send(
      `📉 **ROYAL MARKET INTERVENTION** 👑\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${pings}\n\n` +
      `**${firm.name}** (\`${firm.ticker}\`) has been **CRASHED by ${percent}%** by order of the King.\n` +
      `Price: **${formatCopper(old)}** → **${formatCopper(firm.share_price)}**\n` +
      `**Reason:** ${reason}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    ).catch(() => {});
  }

  return (
    `📉 **CRASHED** — **${firm.name}** (\`${firm.ticker}\`) by **${percent}%**\n` +
    `${formatCopper(old)} → **${formatCopper(firm.share_price)}**\n` +
    `Reason: ${reason}`
  );
}

// ── SANCTIONS ─────────────────────────────────────────────────────────────────

const VALID_SANCTIONS = ["trading_ban", "share_lock", "dividend_freeze", "price_lock", "capital_levy"];

async function kingAddSanction(ticker, type, reason, channel) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No active firm **${ticker.toUpperCase()}**.`;
  type = type.toLowerCase();
  if (!VALID_SANCTIONS.includes(type)) return `⚔️ Unknown sanction type. Valid: \`${VALID_SANCTIONS.join("` | `")}\``;
  if (firm.sanctions.some(s => s.type === type)) return `⚔️ **${type}** sanction already active on **${firm.ticker}**.`;

  firm.sanctions.push({ type, reason, appliedAt: new Date().toISOString() });
  firm.strikes += 1;

  const old = firm.share_price;
  firm.share_price = Math.max(1, Math.floor(old * 0.70));
  firmChart.onFirmPriceChange(firm.ticker, firm.share_price);
  await dbSaveFirm(firm);

  const shareholders = Object.keys(firm.holdings);
  if (channel && shareholders.length) {
    const pings = shareholders.map(id => `<@${id}>`).join(" ");
    await channel.send(
      `⚠️ **EMPIRE SANCTION ISSUED** ⚔️\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${pings}\n\n` +
      `**${firm.name}** (\`${firm.ticker}\`) has been **SANCTIONED** by the King.\n` +
      `🔴 Sanction: **${type.replace(/_/g, " ").toUpperCase()}**\n` +
      `📋 Reason: *${reason}*\n\n` +
      `📉 Immediate price drop: **${formatCopper(old)}** → **${formatCopper(firm.share_price)}** (-30%)\n\n` +
      `⏰ **WARNING: In 10 minutes the share price will drop a further 10–30% automatically.**\n` +
      `**Consider selling your shares now.**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    ).catch(() => {});
  }

  const existingTimer = sanctionTimers.get(firm.ticker);
  if (existingTimer) clearTimeout(existingTimer);
  const timerId = setTimeout(async () => {
    sanctionTimers.delete(firm.ticker);
    const live = getFirm(firm.ticker);
    if (!live || live.dissolved) return;
    const dumpPct = 10 + Math.floor(Math.random() * 21);
    const preBefore = live.share_price;
    live.share_price = Math.max(1, Math.floor(preBefore * (1 - dumpPct / 100)));
    firmChart.onFirmPriceChange(live.ticker, live.share_price);
    await dbSaveFirm(live);
    if (channel) {
      const pingsNow = Object.keys(live.holdings).map(id => `<@${id}>`).join(" ") || "";
      await channel.send(
        `📉 **SANCTION AUTO-DUMP — ${live.name}** (\`${live.ticker}\`)\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${pingsNow}\n` +
        `The 10-minute sanction dump has triggered.\n` +
        `Price crashed **${dumpPct}%**: **${formatCopper(preBefore)}** → **${formatCopper(live.share_price)}**\n` +
        `*The Empire does not forgive.* 👑\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      ).catch(() => {});
    }
  }, 10 * 60 * 1000);
  sanctionTimers.set(firm.ticker, timerId);

  return (
    `⚖️ **SANCTION APPLIED — ${firm.name}** (\`${firm.ticker}\`)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Type: **${type.replace(/_/g, " ").toUpperCase()}**\n` +
    `Reason: *${reason}*\n` +
    `Strike: **${firm.strikes}/3**\n` +
    `Immediate drop: ${formatCopper(old)} → **${formatCopper(firm.share_price)}** (-30%)\n` +
    `⏰ Auto-dump in **10 minutes** (10–30% random drop)\n` +
    `All shareholders have been pinged.`
  );
}

async function kingEscalateSanction(ticker, reason, channel) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No active firm **${ticker.toUpperCase()}**.`;
  if (firm.sanctions.length === 0) return `⚔️ No active sanctions on **${firm.ticker}**. Apply one first.`;

  if (!firm.sanctions.some(s => s.type === "share_lock")) {
    firm.sanctions.push({ type: "share_lock", reason: `Escalation: ${reason}`, appliedAt: new Date().toISOString() });
  }

  const old = firm.share_price;
  firm.share_price = Math.max(1, Math.floor(old * 0.50));
  firmChart.onFirmPriceChange(firm.ticker, firm.share_price);
  firm.strikes += 1;
  await dbSaveFirm(firm);

  const shareholders = Object.keys(firm.holdings);
  if (channel && shareholders.length) {
    const pings = shareholders.map(id => `<@${id}>`).join(" ");
    await channel.send(
      `🚨 **SANCTION ESCALATION — ${firm.name}** (\`${firm.ticker}\`) 🚨\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${pings}\n\n` +
      `The King has **ESCALATED sanctions** on this firm.\n` +
      `🔒 **ALL trading is now FROZEN** — no buys or sells.\n` +
      `📉 Price crashed **50%**: **${formatCopper(old)}** → **${formatCopper(firm.share_price)}**\n` +
      `Reason: *${reason}*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    ).catch(() => {});
  }

  return (
    `🚨 **SANCTIONS ESCALATED — ${firm.name}** (\`${firm.ticker}\`)\n` +
    `Share lock applied | Price -50%: ${formatCopper(old)} → **${formatCopper(firm.share_price)}**\n` +
    `Strike: **${firm.strikes}/3**`
  );
}

async function kingLiftSanction(ticker, type) {
  const firm = getFirm(ticker);
  if (!firm) return `⚔️ No active firm **${ticker.toUpperCase()}**.`;
  type = type.toLowerCase();

  const idx = firm.sanctions.findIndex(s => s.type === type);
  if (idx === -1) return `⚔️ No **${type}** sanction found on **${firm.ticker}**.`;

  firm.sanctions.splice(idx, 1);
  if (firm.sanctions.length === 0) {
    const t = sanctionTimers.get(firm.ticker);
    if (t) { clearTimeout(t); sanctionTimers.delete(firm.ticker); }
  }
  await dbSaveFirm(firm);

  return (
    `✅ **${type.replace(/_/g, " ").toUpperCase()}** sanction lifted from **${firm.name}** (\`${firm.ticker}\`)\n` +
    `Remaining sanctions: **${firm.sanctions.length}**`
  );
}

async function kingViewAllFirms() {
  const all = [...firmCache.values()];
  if (!all.length) return "🏢 No firms in the registry.";

  const lines = all.map(f => {
    const status = f.dissolved ? "💀 DISSOLVED" : f.sanctions.length > 0 ? `⚠️ SANCTIONED (${f.sanctions.length})` : "✅ Active";
    const strikes = f.strikes > 0 ? ` | Strikes: ${f.strikes}/3` : "";
    return `\`${f.ticker}\` **${f.name}** — Owner: <@${f.owner_id}> | ${status}${strikes} | Price: ${formatCopper(f.share_price)} | Treasury: ${formatCopper(f.treasury)}`;
  });

  return (
    `👑 **KING'S FIRM REGISTRY** *(all firms)*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    lines.join("\n") +
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  );
}

// ── ECO HELP TEXT ─────────────────────────────────────────────────────────────

const FIRM_HELP = [
  "```",
  "🏢  FIRMS",
  "  Knight firm create [Name] [TICKER] [price]  ← costs 50 Stellar",
  "  Knight firm confirm / cancel",
  "  Knight firm issue [TICKER] [shares]         ← owner: issue shares (costs share_price × amount)",
  "  Knight firm price set [TICKER] [price]      ← owner: set share price",
  "  Knight firm deposit [TICKER] [amount]       ← owner: fund treasury",
  "  Knight firm dividends [TICKER] [amount]     ← owner: pay all shareholders",
  "  Knight firm buy [TICKER] [shares]           ← buy shares in a firm",
  "  Knight firm sell [TICKER] [shares]          ← sell shares back",
  "  Knight firm info [TICKER]                   ← firm details",
  "  Knight firm list                            ← all active firms",
  "  Knight firm portfolio                       ← your holdings + P&L",
  "  Knight stock firm                           ← live candlestick charts for all firms",
  "  Price format: 500c | 5s | 10g | 2st",
  "```",
].join("\n");

const FIRM_KING_HELP = [
  "```",
  "👑  FIRM MOD COMMANDS (King only)",
  "  Knight firm delete [TICKER] [reason]",
  "  Knight firm crash [TICKER] [%] [reason]",
  "  Knight firm sanction [TICKER] [type] [reason]",
  "    Types: trading_ban | share_lock | dividend_freeze | price_lock | capital_levy",
  "  Knight firm escalate [TICKER] [reason]     ← 50% crash + full freeze + ping",
  "  Knight firm unsanction [TICKER] [type]",
  "  Knight firm registry                       ← all firms full view",
  "```",
].join("\n");

/**
 * Force N instant candles on a firm at exactly +5% or -5% each.
 * direction: 1 = pump, -1 = crash
 */
async function forceFirmPumpCrash(ticker, rounds, direction) {
  ticker = ticker.toUpperCase();
  const firm = firmCache.get(ticker);
  if (!firm || firm.dissolved) return false;
  for (let i = 0; i < rounds; i++) {
    const open = firm.share_price;
    const move = direction * 0.05;
    const close = Math.max(1, Math.round(open * (1 + move)));
    const high  = direction > 0 ? Math.round(close * 1.005) : Math.round(open * 1.002);
    const low   = direction > 0 ? Math.round(open * 0.998)  : Math.round(close * 0.995);
    const now   = new Date();
    const label = now.getHours().toString().padStart(2,"0") + ":" + now.getMinutes().toString().padStart(2,"0");
    // Push candle directly into the store
    const candles = [...(firmChart.getFirmCandles(ticker) || [])];
    candles.push({ o: open, h: high, l: low, c: close, label });
    if (candles.length > 60) candles.shift();
    firmChart.setFirmCandles(ticker, candles);
    // Update accumulator + firm price
    firm.share_price = close;
    firmChart.onFirmPriceChange(ticker, close);
    if (i < rounds - 1) await new Promise(r => setTimeout(r, 300));
  }
  await dbSaveFirm(firm);
  return true;
}

async function getFirmChart() {
  const firms = [...firmCache.values()].filter(f => !f.dissolved);
  if (firms.length === 0) return null;
  return firmChart.renderFirmPanel(firms);
}

module.exports = {
  initFirms,
  loadAllFirms,
  parsePriceArg,
  formatCopper,
  initiateFirmCreation,
  confirmFirmCreation,
  cancelFirmCreation,
  issueFirmShares,
  setFirmSharePrice,
  depositToFirm,
  payDividends,
  buyFirmShares,
  sellFirmShares,
  getFirmInfo,
  listFirms,
  getMyFirmShares,
  kingDeleteFirm,
  kingCrashFirmShares,
  kingAddSanction,
  kingEscalateSanction,
  kingLiftSanction,
  kingViewAllFirms,
  FIRM_HELP,
  FIRM_KING_HELP,
  getFirmChart,
  forceFirmPumpCrash,
};
