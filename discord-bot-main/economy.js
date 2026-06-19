const { createClient } = require("@supabase/supabase-js");

// ── Currency System ───────────────────────────────────────────────────────────
const TIERS = [
  { name: "Copper",  emoji: "🟤", key: "copper",  rate: 1          },
  { name: "Silver",  emoji: "🪙", key: "silver",  rate: 100        },
  { name: "Gold",    emoji: "🥇", key: "gold",    rate: 10000      },
  { name: "Stellar", emoji: "⭐", key: "stellar", rate: 1000000    },
];

function toCopper(amount, tierKey) {
  const tier = TIERS.find(t => t.key === tierKey);
  return tier ? amount * tier.rate : amount;
}

function fromCopper(copper) {
  let remaining = Math.floor(copper);
  const result = {};
  for (let i = TIERS.length - 1; i >= 0; i--) {
    const tier = TIERS[i];
    result[tier.key] = Math.floor(remaining / tier.rate);
    remaining = remaining % tier.rate;
  }
  return result;
}

function formatWallet(wallet) {
  const parts = [];
  if (wallet.stellar > 0) parts.push(`⭐ ${wallet.stellar.toLocaleString()} Stellar`);
  if (wallet.gold    > 0) parts.push(`🥇 ${wallet.gold.toLocaleString()} Gold`);
  if (wallet.silver  > 0) parts.push(`🪙 ${wallet.silver.toLocaleString()} Silver`);
  if (wallet.copper  > 0) parts.push(`🟤 ${wallet.copper.toLocaleString()} Copper`);
  return parts.length > 0 ? parts.join(" | ") : "🟤 0 Copper";
}

function walletToCopper(wallet) {
  return (wallet.stellar || 0) * 1000000 +
         (wallet.gold    || 0) * 10000   +
         (wallet.silver  || 0) * 100     +
         (wallet.copper  || 0);
}

function parseBet(amount, tierKey) {
  const num = parseInt(amount);
  if (isNaN(num) || num <= 0) return null;
  return toCopper(num, tierKey || "copper");
}

// ── Supabase Wallet Store ─────────────────────────────────────────────────────
let supabase;
function initEconomy(supabaseUrl, supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Economy system initialized");
  } catch (e) {
    console.error("[ECONOMY] Init failed:", e.message);
  }
}

async function getWallet(userId) {
  const empty = { user_id: userId, copper: 0, silver: 0, gold: 0, stellar: 0, last_daily: null, total_earned: 0, debt: 0 };
  if (!supabase) return empty;
  try {
    const result = await supabase.from("wallets").select("*").eq("user_id", userId);
    console.log("[GET WALLET]", userId, JSON.stringify(result.data), result.error?.message);
    if (result.error || !result.data || result.data.length === 0) return empty;
    return result.data[0];
  } catch (e) {
    console.error("[GET WALLET ERROR]", e.message);
    return empty;
  }
}

async function saveWallet(wallet) {
  if (!supabase) return;
  try {
    await supabase.from("wallets").upsert(wallet, { onConflict: "user_id" });
  } catch (e) { console.error("[SAVE WALLET]", e.message); }
}

async function getDebt(userId) {
  const w = await getWallet(userId);
  return w.debt || 0;
}

async function addDebt(userId, amount) {
  try {
    const w = await getWallet(userId);
    const newW = { ...w, debt: (w.debt || 0) + amount };
    await saveWallet(newW);
    return newW;
  } catch (e) { console.error("[ADD DEBT]", e.message); return null; }
}

async function payDebt(userId, amount) {
  try {
    const w = await getWallet(userId);
    const currentDebt = w.debt || 0;
    const pay = Math.min(amount, currentDebt);
    const newW = { ...w, debt: currentDebt - pay };
    // Also deduct from balance
    const totalCopper = walletToCopper(w);
    if (totalCopper < pay) return null;
    Object.assign(newW, fromCopper(totalCopper - pay));
    await saveWallet(newW);
    return newW;
  } catch (e) { console.error("[PAY DEBT]", e.message); return null; }
}

function formatDebt(debt) {
  if (!debt || debt === 0) return null;
  return "🔴 **DEBT: " + debt.toLocaleString() + " Copper**";
}

async function addCopper(userId, copperAmount) {
  try {
    const w = await getWallet(userId);
    const total = walletToCopper(w) + copperAmount;
    const newW = { ...w, ...fromCopper(total), total_earned: (w.total_earned || 0) + Math.max(0, copperAmount) };
    await saveWallet(newW);
    return newW;
  } catch (e) { console.error("[ADD COPPER]", e.message); return null; }
}

async function deductCopper(userId, copperAmount) {
  try {
    const w = await getWallet(userId);
    const total = walletToCopper(w);
    if (total < copperAmount) return null;
    const newW = { ...w, ...fromCopper(total - copperAmount) };
    await saveWallet(newW);
    return newW;
  } catch (e) { console.error("[DEDUCT COPPER]", e.message); return null; }
}

async function getLeaderboard(limit = 10) {
  try {
    const result = await supabase.from("wallets").select("*").order("total_earned", { ascending: false }).limit(limit);
    return result.data || [];
  } catch { return []; }
}

// ── Daily Rewards by Rank ─────────────────────────────────────────────────────
const DAILY_REWARDS = {
  peasant:    { copper: 0, silver: 1,  gold: 0,  stellar: 0 },
  baron:      { copper: 0, silver: 10, gold: 0,  stellar: 0 },
  viscount:   { copper: 0, silver: 30, gold: 0,  stellar: 0 },
  count:      { copper: 0, silver: 0,  gold: 1,  stellar: 0 },
  duke:       { copper: 0, silver: 0,  gold: 10, stellar: 0 },
  grandduke:  { copper: 0, silver: 0,  gold: 20, stellar: 0 },
  archduke:   { copper: 0, silver: 0,  gold: 0,  stellar: 1 },
  king:       { copper: 0, silver: 0,  gold: 0,  stellar: 999999999 },
};

function getDailyAmount(rankKey) {
  const reward = DAILY_REWARDS[rankKey] || DAILY_REWARDS.peasant;
  return toCopper(reward.copper, "copper") +
         toCopper(reward.silver, "silver") +
         toCopper(reward.gold,   "gold")   +
         toCopper(reward.stellar,"stellar");
}

// ── Slots ─────────────────────────────────────────────────────────────────────
// Weights tuned so matching two commons is frequent, jackpots are rare.
// Total weight ~100. 💀 reduced from 37→15 so near-misses feel fair.
const SLOT_SYMBOLS = [
  { emoji: "👑", weight: 2,  multiplier: 10  }, // rare jackpot
  { emoji: "⭐", weight: 4,  multiplier: 6   },
  { emoji: "⚔️", weight: 8,  multiplier: 4   },
  { emoji: "🔮", weight: 14, multiplier: 2.5 },
  { emoji: "🛡️", weight: 20, multiplier: 1.5 },
  { emoji: "🗡️", weight: 22, multiplier: 1   },
  { emoji: "🪙", weight: 25, multiplier: 0.5 }, // partial return on pair
  { emoji: "💀", weight: 15, multiplier: 0   }, // loss, reduced from 37
];

function spinSlot() {
  const totalWeight = SLOT_SYMBOLS.reduce((a, s) => a + s.weight, 0);
  let r = Math.random() * totalWeight;
  for (const s of SLOT_SYMBOLS) { r -= s.weight; if (r <= 0) return s; }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

function playSlots(bet, charmActive = false) {
  const reels = [spinSlot(), spinSlot(), spinSlot()];
  // Lucky charm: reroll the worst reel once if no match
  if (charmActive) {
    const hasMatch = reels[0].emoji === reels[1].emoji || reels[1].emoji === reels[2].emoji || reels[0].emoji === reels[2].emoji;
    if (!hasMatch) {
      // Find the odd one out and reroll it
      const idx = reels[0].emoji === reels[1].emoji ? 2 : reels[1].emoji === reels[2].emoji ? 0 : 1;
      reels[idx] = spinSlot();
    }
  }
  const display = reels.map(r => r.emoji).join(" | ");
  let multiplier = 0;
  if (reels[0].emoji === reels[1].emoji && reels[1].emoji === reels[2].emoji) {
    multiplier = reels[0].multiplier * 3; // jackpot
  } else if (reels[0].emoji === reels[1].emoji || reels[1].emoji === reels[2].emoji || reels[0].emoji === reels[2].emoji) {
    multiplier = reels[0].multiplier * 0.5;
  }
  const winnings = Math.floor(bet * multiplier);
  return { display, multiplier, winnings, isJackpot: multiplier >= reels[0].multiplier * 3 && multiplier > 1 };
}

// ── Wheel ─────────────────────────────────────────────────────────────────────
// Max is now 5x. 0.5x counts as a loss (lucky charm rerolls it).
// 3x and 5x are rare but reachable. Total weight = 1000 for clean math.
const WHEEL_SEGMENTS = [
  { label: "💀 BANKRUPT",  multiplier: 0,   weight: 280 },
  { label: "☠️ BANKRUPT",  multiplier: 0,   weight: 250 },
  { label: "0.5x 😬",      multiplier: 0.5, weight: 200 }, // treated as loss for lucky charm
  { label: "1x",           multiplier: 1,   weight: 160 },
  { label: "2x",           multiplier: 2,   weight: 80  },
  { label: "3x 🔥",        multiplier: 3,   weight: 22  },
  { label: "5x ⚡",        multiplier: 5,   weight: 8   },
];

function spinWheel() {
  const total = WHEEL_SEGMENTS.reduce((a, s) => a + s.weight, 0);
  let r = Math.random() * total;
  for (const s of WHEEL_SEGMENTS) { r -= s.weight; if (r <= 0) return s; }
  return WHEEL_SEGMENTS[0];
}

// ── Blackjack ─────────────────────────────────────────────────────────────────
const BJ_DECK = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
function bjValue(card) { return card === "A" ? 11 : ["J","Q","K"].includes(card) ? 10 : parseInt(card); }
function bjHandValue(hand) {
  let total = hand.reduce((a, c) => a + bjValue(c), 0);
  let aces = hand.filter(c => c === "A").length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function dealCard() { return BJ_DECK[Math.floor(Math.random() * BJ_DECK.length)]; }
function newBjHand() { return [dealCard(), dealCard()]; }

// ── Rob ───────────────────────────────────────────────────────────────────────
// 40% success, 30% caught (fine = 50% of attempted steal), 30% escaped with nothing
function attemptRob(targetCopperBalance, robberCopperBalance, robberDebt = 0) {
  const r = Math.random();
  const steal = Math.floor(targetCopperBalance * (0.2 + Math.random() * 0.2));
  const finePercent = 0.5 + Math.random() * 0.2;
  // In debt = lower success rate (20% instead of 40%)
  const successThreshold = robberDebt > 0 ? 0.2 : 0.4;
  if (r < successThreshold) return { result: "success", amount: steal };
  if (r < 0.7) return { result: "caught", fine: Math.floor(steal * finePercent) };
  return { result: "escaped" };
}

// ── Chat Rewards ──────────────────────────────────────────────────────────────
const chatCounters = new Map(); // userId -> message count since last reward
function shouldRewardChat(userId) {
  const count = (chatCounters.get(userId) || 0) + 1;
  chatCounters.set(userId, count);
  if (count >= (5 + Math.floor(Math.random() * 6))) { // every 5-10 messages
    chatCounters.set(userId, 0);
    return Math.floor(10 + Math.random() * 40); // 10-50 copper
  }
  return 0;
}

// Active blackjack games: userId -> { playerHand, dealerHand, bet, channelId }
const bjGames = new Map();

module.exports = {
  TIERS, toCopper, fromCopper, formatWallet, walletToCopper, parseBet,
  initEconomy, getWallet, saveWallet, addCopper, deductCopper, getLeaderboard,
  getDailyAmount, DAILY_REWARDS,
  playSlots, spinWheel, WHEEL_SEGMENTS,
  bjHandValue, dealCard, newBjHand, bjGames,
  attemptRob, shouldRewardChat,
  getDebt, addDebt, payDebt, formatDebt,
};
