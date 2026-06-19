// ── features.js — AFK, Giveaway, Trivia, Heist, Stocks, Marriage, Shop ────────

const { createClient } = require("@supabase/supabase-js");
const eco = require("./economy.js");

// Initialize Supabase directly — no timing dependency on initFeatures
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let MASTER_ID;
let client;

function initFeatures(supabaseClient, ecoModule, masterId, discordClient) {
  // supabase and eco now initialized directly above
  MASTER_ID = masterId;
  client = discordClient;
  console.log("✅ Features system initialized");
}

// ═══════════════════════════════════════════════════════════════
// ── AFK SYSTEM ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const afkUsers = new Map(); // userId -> { reason, since, warnedPingers: Set }

function setAfk(userId, reason = "Away") {
  afkUsers.set(userId, {
    reason,
    since: Date.now(),
    warnedPingers: new Set(),
  });
}

function removeAfk(userId) {
  afkUsers.delete(userId);
}

function getAfk(userId) {
  return afkUsers.get(userId) || null;
}

function isAfk(userId) {
  return afkUsers.has(userId);
}

function getAfkPingerMute() {
  return (60 + Math.floor(Math.random() * 61)) * 1000;
}

function formatAfkTime(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

// ═══════════════════════════════════════════════════════════════
// ── GIVEAWAY SYSTEM ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const activeGiveaways = new Map();

async function startGiveaway(channel, hostId, prizeCopper, durationMs, winners = 1) {
  const endsAt = Date.now() + durationMs;
  const prize = eco.formatWallet(eco.fromCopper(prizeCopper));
  const msg = await channel.send(
    `🎉 **EMPIRE GIVEAWAY** 🎉\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 **Prize:** ${prize}\n` +
    `🏆 **Winners:** ${winners}\n` +
    `⏰ **Ends:** <t:${Math.floor(endsAt / 1000)}:R>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `React with 🎉 to enter!\n` +
    `*Hosted by <@${hostId}>*`
  ).catch(() => null);
  if (!msg) return null;

  await msg.react("🎉").catch(() => {});

  const giveaway = {
    messageId: msg.id,
    channelId: channel.id,
    hostId,
    prizeCopper,
    winners,
    endsAt,
    ended: false,
  };

  activeGiveaways.set(msg.id, giveaway);

  try { await supabase.from("giveaways").upsert({
    message_id: msg.id,
    channel_id: channel.id,
    host_id: hostId,
    prize_copper: prizeCopper,
    winners,
    ends_at: new Date(endsAt).toISOString(),
    ended: false,
  }); } catch (e) { console.error("[GIVEAWAY SAVE]", e.message); }

  setTimeout(() => endGiveaway(msg.id, channel.guild), durationMs);

  return msg;
}

async function endGiveaway(messageId, guild) {
  const giveaway = activeGiveaways.get(messageId);
  if (!giveaway || giveaway.ended) return;
  giveaway.ended = true;
  activeGiveaways.delete(messageId);

  const channel = guild.channels.cache.get(giveaway.channelId);
  if (!channel) return;

  let msg;
  try { msg = await channel.messages.fetch(messageId); } catch { return; }

  const reaction = msg.reactions.cache.get("🎉");
  if (!reaction) {
    await channel.send("🎉 **Giveaway ended** — nobody entered!").catch(() => {});
    return;
  }

  const users = await reaction.users.fetch().catch(() => null);
  if (!users) return;

  const entries = [...users.values()].filter(u => !u.bot && u.id !== giveaway.hostId);
  if (entries.length === 0) {
    await channel.send("🎉 **Giveaway ended** — not enough participants!").catch(() => {});
    return;
  }

  const winnerCount = Math.min(giveaway.winners, entries.length);
  const shuffled = entries.sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, winnerCount);
  const perWinner = Math.floor(giveaway.prizeCopper / winnerCount);

  for (const winner of winners) {
    await eco.addCopper(winner.id, perWinner).catch(() => {});
  }

  const winnerMentions = winners.map(w => `<@${w.id}>`).join(", ");
  await channel.send(
    `🎉 **GIVEAWAY ENDED!**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏆 **Winner(s):** ${winnerMentions}\n` +
    `💰 **Prize:** ${eco.formatWallet(eco.fromCopper(perWinner))} each\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Congratulations! The Empire rewards the lucky.* 👑`
  ).catch(() => {});

  try { await supabase.from("giveaways").update({ ended: true }).eq("message_id", messageId); } catch (e) { console.error("[GIVEAWAY END]", e.message); }
}

async function rerollGiveaway(messageId, guild) {
  for (const [, ch] of guild.channels.cache) {
    if (!ch.isTextBased()) continue;
    try {
      const msg = await ch.messages.fetch(messageId);
      const reaction = msg.reactions.cache.get("🎉");
      if (!reaction) return "⚔️ No entries found.";
      const users = await reaction.users.fetch();
      const entries = [...users.values()].filter(u => !u.bot);
      if (!entries.length) return "⚔️ No entries to reroll from.";
      const winner = entries[Math.floor(Math.random() * entries.length)];
      await ch.send(`🎉 **REROLL!** New winner: <@${winner.id}>! Congratulations! 🏆`).catch(() => {});
      return null;
    } catch { continue; }
  }
  return "⚔️ Couldn't find that giveaway message.";
}

async function loadGiveaways(guild) {
  try {
    const { data } = await supabase.from("giveaways").select("*").eq("ended", false);
    if (!data) return;
    const now = Date.now();
    for (const g of data) {
      const endsAt = new Date(g.ends_at).getTime();
      const remaining = endsAt - now;
      if (remaining <= 0) {
        await endGiveaway(g.message_id, guild);
      } else {
        activeGiveaways.set(g.message_id, {
          messageId: g.message_id,
          channelId: g.channel_id,
          hostId: g.host_id,
          prizeCopper: g.prize_copper,
          winners: g.winners,
          endsAt,
          ended: false,
        });
        setTimeout(() => endGiveaway(g.message_id, guild), remaining);
      }
    }
    console.log(`[GIVEAWAYS] Loaded ${data.length} active giveaway(s)`);
  } catch (e) { console.error("[LOAD GIVEAWAYS]", e.message); }
}

// ═══════════════════════════════════════════════════════════════
// ── TRIVIA TOURNAMENT ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const TRIVIA_QUESTIONS = [
  { q: "What is the capital of France?", a: "paris", choices: ["London", "Paris", "Berlin", "Madrid"] },
  { q: "How many sides does a hexagon have?", a: "6", choices: ["5", "6", "7", "8"] },
  { q: "What planet is closest to the Sun?", a: "mercury", choices: ["Venus", "Earth", "Mercury", "Mars"] },
  { q: "Who painted the Mona Lisa?", a: "da vinci", choices: ["Picasso", "Da Vinci", "Rembrandt", "Michelangelo"] },
  { q: "What is the chemical symbol for gold?", a: "au", choices: ["Go", "Gd", "Au", "Ag"] },
  { q: "How many bones are in the human body?", a: "206", choices: ["196", "206", "216", "226"] },
  { q: "What is the largest ocean?", a: "pacific", choices: ["Atlantic", "Indian", "Pacific", "Arctic"] },
  { q: "What year did World War II end?", a: "1945", choices: ["1943", "1944", "1945", "1946"] },
  { q: "What is the fastest land animal?", a: "cheetah", choices: ["Lion", "Cheetah", "Leopard", "Tiger"] },
  { q: "How many planets are in our solar system?", a: "8", choices: ["7", "8", "9", "10"] },
  { q: "What is the square root of 144?", a: "12", choices: ["10", "11", "12", "13"] },
  { q: "What language has the most native speakers?", a: "mandarin", choices: ["English", "Spanish", "Mandarin", "Hindi"] },
  { q: "What is the smallest country in the world?", a: "vatican city", choices: ["Monaco", "Vatican City", "San Marino", "Liechtenstein"] },
  { q: "What is H2O commonly known as?", a: "water", choices: ["Oxygen", "Hydrogen", "Water", "Salt"] },
  { q: "Who wrote Romeo and Juliet?", a: "shakespeare", choices: ["Dickens", "Shakespeare", "Hemingway", "Austen"] },
  { q: "How many continents are there?", a: "7", choices: ["5", "6", "7", "8"] },
  { q: "What is the currency of Japan?", a: "yen", choices: ["Won", "Yuan", "Yen", "Ringgit"] },
  { q: "What is the longest river in the world?", a: "nile", choices: ["Amazon", "Nile", "Yangtze", "Mississippi"] },
  { q: "What gas do plants absorb from the atmosphere?", a: "carbon dioxide", choices: ["Oxygen", "Carbon Dioxide", "Nitrogen", "Helium"] },
  { q: "What is the hardest natural substance on Earth?", a: "diamond", choices: ["Gold", "Iron", "Diamond", "Quartz"] },
  { q: "What is the largest planet in our solar system?", a: "jupiter", choices: ["Saturn", "Jupiter", "Neptune", "Uranus"] },
  { q: "How many strings does a standard guitar have?", a: "6", choices: ["4", "5", "6", "7"] },
  { q: "What is the capital of Japan?", a: "tokyo", choices: ["Osaka", "Kyoto", "Tokyo", "Hiroshima"] },
  { q: "Who invented the telephone?", a: "bell", choices: ["Edison", "Tesla", "Bell", "Marconi"] },
  { q: "What is the speed of light?", a: "299792458", choices: ["199792458", "299792458", "399792458", "499792458"] },
  { q: "What element does 'O' represent on the periodic table?", a: "oxygen", choices: ["Osmium", "Oxygen", "Gold", "Oganesson"] },
  { q: "How many hours are in a week?", a: "168", choices: ["148", "158", "168", "178"] },
  { q: "What country has the most natural lakes?", a: "canada", choices: ["Russia", "USA", "Canada", "Brazil"] },
  { q: "What is the powerhouse of the cell?", a: "mitochondria", choices: ["Nucleus", "Ribosome", "Mitochondria", "Golgi"] },
  { q: "Who was the first man on the moon?", a: "armstrong", choices: ["Aldrin", "Armstrong", "Glenn", "Shepard"] },
];

const activeTournaments = new Map();

async function startTriviaRound(channelId, guild, tournament) {
  if (tournament.currentRound > tournament.totalRounds) {
    await endTriviaTournament(channelId, guild, tournament);
    return;
  }

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  // Pick a question not used yet this tournament
  const unused = TRIVIA_QUESTIONS.filter((_, i) => !tournament.usedQuestions?.has(i));
  const pool = unused.length > 0 ? unused : TRIVIA_QUESTIONS;
  const idx = Math.floor(Math.random() * pool.length);
  const q = pool[idx];
  if (!tournament.usedQuestions) tournament.usedQuestions = new Set();
  tournament.usedQuestions.add(TRIVIA_QUESTIONS.indexOf(q));

  tournament.currentQuestion = q;
  tournament.answered = new Set();
  tournament.roundStarted = Date.now();

  const optionsText = q.choices.map((c, i) => `${["🇦","🇧","🇨","🇩"][i]} ${c}`).join("\n");

  await channel.send(
    `🧠 **TRIVIA TOURNAMENT — Round ${tournament.currentRound}/${tournament.totalRounds}**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `**${q.q}**\n\n` +
    `${optionsText}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Type your answer! You have **20 seconds**. First correct answer gets bonus points!*`
  ).catch(() => {});

  tournament.roundTimeout = setTimeout(async () => {
    const t = activeTournaments.get(channelId);
    if (!t || t.roundStarted !== tournament.roundStarted) return;
    const correctDisplay = q.choices.find(c => c.toLowerCase() === q.a) || q.a;
    await channel.send(
      `⏰ **Time's up!** The answer was **${correctDisplay}**.\n\n` +
      `📊 *Scores: ${getScoreBoard(t)}*`
    ).catch(() => {});
    t.currentRound++;
    setTimeout(() => startTriviaRound(channelId, guild, t), 4000);
  }, 20000);
}

function getScoreBoard(tournament) {
  return Object.entries(tournament.scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, score], i) => `${["👑","🥈","🥉","4.","5."][i]} <@${id}> **${score}pts**`)
    .join(" | ") || "No scores yet";
}

async function endTriviaTournament(channelId, guild, tournament) {
  activeTournaments.delete(channelId);
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  const sorted = Object.entries(tournament.scores).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    await channel.send("🧠 **Tournament ended** — nobody scored!").catch(() => {});
    return;
  }

  const [winnerId, winnerScore] = sorted[0];
  const prize = tournament.prizeCopper;
  await eco.addCopper(winnerId, prize).catch(() => {});

  // Runner up prizes (2nd gets 30%, 3rd gets 10%)
  if (sorted[1]) await eco.addCopper(sorted[1][0], Math.floor(prize * 0.3)).catch(() => {});
  if (sorted[2]) await eco.addCopper(sorted[2][0], Math.floor(prize * 0.1)).catch(() => {});

  const podium = sorted.slice(0, 3).map(([id, score], i) =>
    `${["🥇","🥈","🥉"][i]} <@${id}> — **${score} pts**`
  ).join("\n");

  await channel.send(
    `🏆 **TRIVIA TOURNAMENT — FINAL RESULTS** 🏆\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${podium}\n\n` +
    `💰 **Prize Pool Distribution:**\n` +
    `🥇 1st: ${eco.formatWallet(eco.fromCopper(prize))} → <@${winnerId}>\n` +
    (sorted[1] ? `🥈 2nd: ${eco.formatWallet(eco.fromCopper(Math.floor(prize * 0.3)))} → <@${sorted[1][0]}>\n` : "") +
    (sorted[2] ? `🥉 3rd: ${eco.formatWallet(eco.fromCopper(Math.floor(prize * 0.1)))} → <@${sorted[2][0]}>\n` : "") +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*The Empire crowns its champion. ⚔️*`
  ).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// ── HEIST SYSTEM ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const activeHeists = new Map();

async function startHeist(channel, initiatorId, vaultCopper) {
  if (activeHeists.has(channel.id)) return "⚔️ A heist is already being planned in this channel.";

  const entryFee = Math.max(100, Math.floor(vaultCopper * 0.05));
  const heist = {
    channelId: channel.id,
    vaultCopper,
    entryFee,
    participants: new Map(),
    startedAt: Date.now(),
    launched: false,
  };

  const deducted = await eco.deductCopper(initiatorId, entryFee).catch(() => null);
  if (!deducted) return `⚔️ You need **${eco.formatWallet(eco.fromCopper(entryFee))}** entry fee to start the heist.`;

  heist.participants.set(initiatorId, true);
  activeHeists.set(channel.id, heist);

  await channel.send(
    `🦹 **EMPIRE HEIST FORMING** 🦹\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏦 **Target vault:** ${eco.formatWallet(eco.fromCopper(vaultCopper))}\n` +
    `💸 **Entry fee:** ${eco.formatWallet(eco.fromCopper(entryFee))}\n` +
    `👥 **Crew so far:** 1 member\n\n` +
    `Say **Knight heist join** to join the crew!\n` +
    `**Launching in 60 seconds...**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*More members = higher success chance (max 10).*\n` +
    `*Win: split the vault. Fail: lose entry fee.*`
  ).catch(() => null);

  setTimeout(() => executeHeist(channel.id, channel.guild), 60000);
  return null;
}

async function joinHeist(channelId, userId, guild) {
  const heist = activeHeists.get(channelId);
  if (!heist) return "⚔️ No heist forming here. Start one with **Knight heist [amount]**.";
  if (heist.launched) return "⚔️ The heist already launched — too late.";
  if (heist.participants.has(userId)) return "⚔️ You're already in the crew.";
  if (heist.participants.size >= 10) return "⚔️ Crew is full (10 max).";

  const deducted = await eco.deductCopper(userId, heist.entryFee).catch(() => null);
  if (!deducted) return `⚔️ You need **${eco.formatWallet(eco.fromCopper(heist.entryFee))}** to join.`;

  heist.participants.set(userId, true);
  const channel = guild.channels.cache.get(channelId);
  if (channel) await channel.send(`🦹 <@${userId}> joined the crew! **(${heist.participants.size}/10 members)**`).catch(() => {});
  return null;
}

async function executeHeist(channelId, guild) {
  const heist = activeHeists.get(channelId);
  if (!heist || heist.launched) return;
  heist.launched = true;
  activeHeists.delete(channelId);

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  const crewSize = heist.participants.size;
  const successChance = Math.min(0.80, 0.20 + (crewSize - 1) * 0.10);
  const roll = Math.random();
  const totalPot = heist.entryFee * crewSize;
  const crewMentions = [...heist.participants.keys()].map(id => `<@${id}>`).join(", ");

  // Dramatic countdown
  await channel.send(`🚨 **HEIST LAUNCHING** 🚨\n*${crewSize} crew member(s) assembled. Success chance: **${Math.round(successChance * 100)}%**\nBreaching the vault...*`).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  if (roll < successChance) {
    const totalPrize = heist.vaultCopper + totalPot;
    const perPerson = Math.floor(totalPrize / crewSize);
    for (const [uid] of heist.participants) {
      await eco.addCopper(uid, perPerson).catch(() => {});
    }
    await eco.deductCopper(MASTER_ID, heist.vaultCopper).catch(() => {});
    await channel.send(
      `💰 **HEIST SUCCESSFUL!** 💰\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🦹 **Crew:** ${crewMentions}\n` +
      `🏦 **Vault cracked:** ${eco.formatWallet(eco.fromCopper(heist.vaultCopper))}\n` +
      `💸 **Each member gets:** ${eco.formatWallet(eco.fromCopper(perPerson))}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `*The Empire's vault has been robbed. The King is NOT pleased. 😤*`
    ).catch(() => {});
  } else {
    await eco.addCopper(MASTER_ID, totalPot).catch(() => {});
    await channel.send(
      `🚨 **HEIST FAILED!** 🚨\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🦹 **Crew:** ${crewMentions}\n` +
      `💀 **Guards caught you all!**\n` +
      `💸 **Entry fees seized:** ${eco.formatWallet(eco.fromCopper(totalPot))} → King's treasury\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `*${Math.round(successChance * 100)}% chance and you still blew it. Disgraceful.*`
    ).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════
// ── STOCK MARKET — REAL DATA ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

const STOCKS = {
  IRON: {
    name: "⚙️ Iron Works",
    basePrice: 100,
    volatility: 0.08,
    realTicker: "X",         // US Steel
    cryptoId: null,
    desc: "Tracks real steel/commodities market",
  },
  GOLD: {
    name: "🥇 Gold Mines",
    basePrice: 500,
    volatility: 0.10,
    realTicker: "GLD",       // Gold ETF
    cryptoId: null,
    desc: "Tracks real gold price",
  },
  ARMS: {
    name: "⚔️ Arms Dealer",
    basePrice: 250,
    volatility: 0.12,
    realTicker: "LMT",       // Lockheed Martin
    cryptoId: null,
    desc: "Tracks defense sector",
  },
  SILK: {
    name: "🧵 Silk Road",
    basePrice: 150,
    volatility: 0.07,
    realTicker: "NKE",       // Nike / luxury consumer
    cryptoId: null,
    desc: "Tracks luxury & consumer goods",
  },
  DARK: {
    name: "🌑 Dark Market",
    basePrice: 1000,
    volatility: 0.22,
    realTicker: null,
    cryptoId: "bitcoin",     // BTC
    desc: "Tracks Bitcoin — never sleeps",
  },
  RUNE: {
    name: "🔮 Rune Exchange",
    basePrice: 750,
    volatility: 0.18,
    realTicker: null,
    cryptoId: "ethereum",    // ETH
    desc: "Tracks Ethereum — never sleeps",
  },
  // ── Penny Stocks ──────────────────────────────────────────
  COAL: {
    name: "🪨 Coal Mines",
    basePrice: 50,        // 50 copper per share = 0.50 Silver
    volatility: 0.28,
    realTicker: "BTU",
    cryptoId: null,
    desc: "⚠️ Penny stock — high risk, high reward",
    penny: true,
  },
  GRAIN: {
    name: "🌾 Grain Market",
    basePrice: 80,        // 80 copper per share = 0.80 Silver
    volatility: 0.24,
    realTicker: "WEAT",
    cryptoId: null,
    desc: "⚠️ Penny stock — high risk, high reward",
    penny: true,
  },
  WOOD: {
    name: "🪵 Timber Trade",
    basePrice: 120,       // 120 copper per share = 1.20 Silver
    volatility: 0.26,
    realTicker: "WY",
    cryptoId: null,
    desc: "⚠️ Penny stock — high risk, high reward",
    penny: true,
  },
};

let stockPrices = {};
let stockCandles = {};   // { [ticker]: { o, h, l, c, label }[] }  — OHLC per 30-min tick
let stockPortfolios = new Map();
let stockMarketOpen = true;
let kingManipulation = null;

// Server-wide Kings Call cooldown
let kingsCallLastUsed = 0;
const KINGS_CALL_COOLDOWN = 24 * 60 * 60 * 1000;

// Market pressure from large buys/sells
const marketPressure = {};

// Track average buy price per user per ticker for P&L
const avgBuyPrice = new Map(); // `${userId}-${ticker}` -> avg copper per share

function initStockPrices() {
  for (const [ticker, stock] of Object.entries(STOCKS)) {
    // Penny stocks: basePrice IS the copper price directly
    // Regular stocks: basePrice × 100 (e.g. GOLD base 500 = 50,000 copper = 5 Gold)
    stockPrices[ticker] = stock.penny ? stock.basePrice : stock.basePrice * 100;
    stockCandles[ticker] = [];
  }
}

function fixPennyStockPrices() {
  for (const [ticker, stock] of Object.entries(STOCKS)) {
    if (stock.penny && (!stockPrices[ticker] || stockPrices[ticker] > stock.basePrice * 50)) {
      // Price is way too high — was multiplied by 100 incorrectly, reset
      stockPrices[ticker] = stock.basePrice;
      stockCandles[ticker] = [];
      console.log(`[STOCKS] Reset ${ticker} to ${stock.basePrice} copper`);
    }
  }
}

// ── Real market data fetchers ─────────────────────────────────

function isMarketHours() {
  const now = new Date();
  // Convert to EST
  const est = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = est.getDay(); // 0=Sun, 6=Sat
  const hour = est.getHours();
  const minute = est.getMinutes();
  const timeVal = hour * 60 + minute;
  if (day === 0 || day === 6) return false;
  return timeVal >= 9 * 60 + 30 && timeVal < 16 * 60;
}

async function fetchStockChange(ticker) {
  try {
    const key = process.env.ALPHA_VANTAGE_KEY;
    if (!key) return null;
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const quote = data["Global Quote"];
    if (!quote || !quote["10. change percent"]) return null;
    const pct = parseFloat(quote["10. change percent"].replace("%", ""));
    if (isNaN(pct)) return null;
    console.log(`[STOCKS] ${ticker} real change: ${pct.toFixed(2)}%`);
    return pct / 100;
  } catch (e) {
    console.error(`[STOCKS] Alpha Vantage fetch failed for ${ticker}:`, e.message);
    return null;
  }
}

async function fetchCryptoChange(coinId) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const pct = data[coinId]?.usd_24h_change;
    if (pct === undefined || pct === null) return null;
    // Scale 24h change to 30min equivalent (roughly 1/48th)
    const scaled = (pct / 100) / 48;
    console.log(`[STOCKS] ${coinId} 24h: ${pct.toFixed(2)}% → 30min scaled: ${(scaled * 100).toFixed(3)}%`);
    return scaled;
  } catch (e) {
    console.error(`[STOCKS] CoinGecko fetch failed for ${coinId}:`, e.message);
    return null;
  }
}

// Alpha Vantage free tier: 25 calls/day = ~1 call per stock per market session
// We cache last fetched change and reuse it with noise for intermediate ticks
const cachedRealChanges = {};
let lastAlphaFetch = 0;
const ALPHA_FETCH_INTERVAL = 4 * 60 * 60 * 1000; // fetch real data every 4h max

async function tickStockMarket() {
  const marketOpen = isMarketHours();

  const tickTime = new Date();
  const timeLabel = tickTime.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });

  for (const [ticker, stock] of Object.entries(STOCKS)) {
    const isTraditional = !stock.cryptoId;
    const open = stockPrices[ticker];

    // 1-min candle: scale volatility down (30min vol / sqrt(30))
    const minVol = stock.volatility / Math.sqrt(30);

    // Base drift from cached real data scaled to 1 min
    let realInfluence = (cachedRealChanges[ticker] || 0) / 30;

    // Outside market hours tiny drift for traditional stocks
    if (isTraditional && !marketOpen) {
      realInfluence = (Math.random() - 0.5) * 0.001;
    }

    const noise = (Math.random() - 0.5) * 2 * minVol;
    let change = realInfluence + noise;

    // King manipulation
    if (kingManipulation && kingManipulation.ticker === ticker && kingManipulation.rounds > 0) {
      change += kingManipulation.direction * 0.15;
      kingManipulation.rounds--;
      if (kingManipulation.rounds === 0) kingManipulation = null;
    }

    // Community market pressure — spikes next candle then decays
    if (marketPressure[ticker]) {
      change += marketPressure[ticker];
      marketPressure[ticker] = marketPressure[ticker] * 0.3;
      if (Math.abs(marketPressure[ticker]) < 0.001) marketPressure[ticker] = 0;
    }

    // Mean reversion very gentle at 1-min scale
    const base = stock.basePrice * 100;
    const drift = (base - stockPrices[ticker]) / base * 0.001;
    change += drift;

    // Intra-candle high/low
    const wickSize = Math.abs(change) * 0.5 + minVol * Math.random();
    const close = Math.max(1, Math.round(open * (1 + change)));
    const high  = Math.max(open, close) + Math.round(open * wickSize * 0.5);
    const low   = Math.max(1, Math.min(open, close) - Math.round(open * wickSize * 0.5));

    stockPrices[ticker] = close;

    if (!stockCandles[ticker]) stockCandles[ticker] = [];
    stockCandles[ticker].push({ o: open, h: high, l: low, c: close, label: timeLabel });
    if (stockCandles[ticker].length > 60) stockCandles[ticker].shift();
  }
}


async function buyStock(userId, ticker, shares) {
  ticker = ticker.toUpperCase();
  if (!STOCKS[ticker]) return `⚔️ Unknown stock. Valid: ${Object.keys(STOCKS).join(", ")}`;
  if (!stockMarketOpen) return "⚔️ The market is closed. King's orders.";
  if (shares < 1) return "⚔️ Buy at least 1 share.";

  const price = stockPrices[ticker];
  const total = price * shares;

  const deducted = await eco.deductCopper(userId, total).catch(() => null);
  if (!deducted) return `⚔️ You need **${eco.formatWallet(eco.fromCopper(total))}** to buy ${shares} shares of ${ticker}.`;

  if (!stockPortfolios.has(userId)) {
    // Try loading from Supabase first before assuming empty
    try {
      const { data } = await supabase.from("stock_portfolios").select("portfolio").eq("user_id", userId).single();
      if (data?.portfolio) { stockPortfolios.set(userId, JSON.parse(data.portfolio)); if (data.avg_prices) { const ap = JSON.parse(data.avg_prices); for (const [t,p] of Object.entries(ap)) avgBuyPrice.set(`${userId}-${t}`, p); } }
      else stockPortfolios.set(userId, {});
    } catch { stockPortfolios.set(userId, {}); }
  }
  const portfolio = stockPortfolios.get(userId);

  // Track average buy price
  const key = `${userId}-${ticker}`;
  const prevShares = portfolio[ticker] || 0;
  const prevAvg = avgBuyPrice.get(key) || price;
  const newAvg = prevShares === 0 ? price : Math.round((prevAvg * prevShares + price * shares) / (prevShares + shares));
  avgBuyPrice.set(key, newAvg);

  portfolio[ticker] = prevShares + shares;
  await savePortfolio(userId, portfolio);

  // Market pressure — based on share count, not copper value
  // 500 shares = ~1% pressure, 5000 shares = ~10%, max 15%
  const pressureStrength = Math.min(0.15, shares / 50000);
  if (pressureStrength > 0.01) {
    if (!marketPressure[ticker]) marketPressure[ticker] = 0;
    marketPressure[ticker] += pressureStrength;
  }

  await logStockTransaction(userId, ticker, "buy", shares, price, total, null);

  const pressureLine = pressureStrength > 0.01
    ? `\n📢 *Large order detected — **${ticker}** will spike on the next candle! 📈*`
    : "";

  return (
    `📈 **BOUGHT ${shares}x ${STOCKS[ticker].name} (${ticker})**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 Price per share: **${eco.formatWallet(eco.fromCopper(price))}**\n` +
    `💸 Total spent: **${eco.formatWallet(eco.fromCopper(total))}**\n` +
    `📊 Your holdings: **${portfolio[ticker]} shares**\n` +
    `📉 Avg buy price: **${eco.formatWallet(eco.fromCopper(newAvg))}**` +
    pressureLine
  );
}

async function sellStock(userId, ticker, shares) {
  ticker = ticker.toUpperCase();
  if (!STOCKS[ticker]) return `⚔️ Unknown stock. Valid: ${Object.keys(STOCKS).join(", ")}`;
  if (!stockMarketOpen) return "⚔️ The market is closed. King's orders.";

  if (!stockPortfolios.has(userId)) {
    try {
      const { data } = await supabase.from("stock_portfolios").select("portfolio").eq("user_id", userId).single();
      if (data?.portfolio) { stockPortfolios.set(userId, JSON.parse(data.portfolio)); if (data.avg_prices) { const ap = JSON.parse(data.avg_prices); for (const [t,p] of Object.entries(ap)) avgBuyPrice.set(`${userId}-${t}`, p); } }
      else stockPortfolios.set(userId, {});
    } catch { stockPortfolios.set(userId, {}); }
  }
  const portfolio = stockPortfolios.get(userId) || {};
  const held = portfolio[ticker] || 0;
  if (held < shares) return `⚔️ You only have **${held} shares** of ${ticker}.`;

  const price = stockPrices[ticker];
  const total = price * shares;

  // Calculate profit/loss
  const key = `${userId}-${ticker}`;
  const avgPrice = avgBuyPrice.get(key) || price;
  const profitLoss = (price - avgPrice) * shares;
  const plText = profitLoss >= 0
    ? `✅ **+${eco.formatWallet(eco.fromCopper(Math.abs(Math.round(profitLoss))))} profit**`
    : `❌ **-${eco.formatWallet(eco.fromCopper(Math.abs(Math.round(profitLoss))))} loss**`;

  portfolio[ticker] -= shares;
  if (portfolio[ticker] === 0) {
    delete portfolio[ticker];
    avgBuyPrice.delete(key);
  }
  stockPortfolios.set(userId, portfolio);

  await eco.addCopper(userId, total).catch(() => {});
  await savePortfolio(userId, portfolio);
  await logStockTransaction(userId, ticker, "sell", shares, price, total, Math.round(profitLoss));

  // Market pressure — based on share count
  const pressureStrength = Math.min(0.15, shares / 50000);
  if (pressureStrength > 0.01) {
    if (!marketPressure[ticker]) marketPressure[ticker] = 0;
    marketPressure[ticker] -= pressureStrength;
  }

  const pressureLine = pressureStrength > 0.01
    ? `\n📢 *Large sell detected — **${ticker}** will drop on the next candle! 📉*`
    : "";

  return (
    `📉 **SOLD ${shares}x ${STOCKS[ticker].name} (${ticker})**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 Price per share: **${eco.formatWallet(eco.fromCopper(price))}**\n` +
    `💵 Total received: **${eco.formatWallet(eco.fromCopper(total))}**\n` +
    `${plText}\n` +
    `📊 Remaining: **${portfolio[ticker] || 0} shares**` +
    pressureLine
  );
}

function getMarketBoardData() {
  const marketOpen = isMarketHours();
  const candleData = {};
  const stockInfo  = {};

  for (const [ticker, stock] of Object.entries(STOCKS)) {
    const candles = stockCandles[ticker] || [];
    const price   = stockPrices[ticker] || stock.basePrice * 100;

    // Use first candle open vs current close for accurate % change
    const visibleCandles = candles.slice(-20);
    const firstOpen = visibleCandles.length > 0 ? visibleCandles[0].o : price;
    const changePct = firstOpen > 0 ? ((price - firstOpen) / firstOpen * 100) : 0;

    candleData[ticker] = candles;
    stockInfo[ticker]  = {
      name: stock.name,
      currentPrice: price,
      changePercent: parseFloat(changePct.toFixed(2)),
      marketOpen,
      isCrypto: !!stock.cryptoId,
      isPenny: !!stock.penny,
    };
  }

  return { candleData, stockInfo, marketOpen };
}

// Text fallback (used in help displays)
function getMarketBoard() {
  const marketOpen = isMarketHours();
  const lines = [
    `📊 **EMPIRE STOCK MARKET** ${stockMarketOpen ? (marketOpen ? "🟢 LIVE" : "🌙 AFTER HOURS") : "🔴 CLOSED"}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  ];
  for (const [ticker, stock] of Object.entries(STOCKS)) {
    const candles = stockCandles[ticker] || [];
    const price   = stockPrices[ticker];
    const prev    = candles.length >= 2 ? candles[candles.length - 2].c : price;
    const changePct = prev ? ((price - prev) / prev * 100).toFixed(1) : "0.0";
    const arrow   = parseFloat(changePct) > 0 ? "📈" : parseFloat(changePct) < 0 ? "📉" : "➡️";
    lines.push(`${arrow} **${ticker}** — ${stock.name} | ${eco.formatWallet(eco.fromCopper(price))} | ${parseFloat(changePct) >= 0 ? "+" : ""}${changePct}%`);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*Knight stocks — view chart image*`);
  return lines.join("\n");
}

async function getPortfolio(userId) {
  if (!stockPortfolios.has(userId)) {
    try {
      const { data } = await supabase.from("stock_portfolios").select("portfolio").eq("user_id", userId).single();
      if (data?.portfolio) { stockPortfolios.set(userId, JSON.parse(data.portfolio)); if (data.avg_prices) { const ap = JSON.parse(data.avg_prices); for (const [t,p] of Object.entries(ap)) avgBuyPrice.set(`${userId}-${t}`, p); } }
      else stockPortfolios.set(userId, {});
    } catch { stockPortfolios.set(userId, {}); }
  }
  const portfolio = stockPortfolios.get(userId) || {};
  const entries = Object.entries(portfolio).filter(([, s]) => s > 0);
  if (!entries.length) return "📊 You have no stocks. Buy with **Knight stock buy [TICKER] [shares]**.";

  // Simple copper formatter — shows highest denomination only
  function fmt(copper) {
    copper = Math.abs(Math.round(copper));
    if (copper >= 1000000) return `⭐ ${(copper / 1000000).toFixed(2)} Stellar`;
    if (copper >= 10000)   return `🥇 ${(copper / 10000).toFixed(2)} Gold`;
    if (copper >= 100)     return `🪙 ${(copper / 100).toFixed(1)} Silver`;
    return `🟤 ${copper} Copper`;
  }

  let totalValue = 0;
  let totalCost = 0;
  const lines = [`📊 **YOUR PORTFOLIO**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];

  for (const [ticker, shares] of entries) {
    const price = stockPrices[ticker] || 0;
    const value = price * shares;
    const avgP = avgBuyPrice.get(`${userId}-${ticker}`) || price;
    const cost = avgP * shares;
    const pl = value - cost;
    const plSign = pl >= 0 ? `✅ +${fmt(pl)}` : `❌ -${fmt(pl)}`;
    const pct = cost > 0 ? ((pl / cost) * 100).toFixed(1) : "0.0";
    totalValue += value;
    totalCost += cost;
    lines.push(
      `**${ticker}** — ${STOCKS[ticker]?.name || ticker}\n` +
      `  ${shares.toLocaleString()} shares | Avg: ${fmt(avgP)} | Now: ${fmt(price)}\n` +
      `  Value: **${fmt(value)}** | P&L: ${plSign} (${parseFloat(pct) >= 0 ? "+" : ""}${pct}%)`
    );
  }

  const totalPL = totalValue - totalCost;
  const totalPct = totalCost > 0 ? ((totalPL / totalCost) * 100).toFixed(1) : "0.0";
  lines.push(
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💼 **Total:** ${fmt(totalValue)} | P&L: ${totalPL >= 0 ? `✅ +${fmt(totalPL)}` : `❌ -${fmt(totalPL)}`} (${parseFloat(totalPct) >= 0 ? "+" : ""}${totalPct}%)`
  );
  return lines.join("\n");
}

async function getStockHistory(userId) {
  try {
    const { data } = await supabase
      .from("stock_transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (!data || !data.length) return "📊 No trade history yet. Start trading with **Knight stock buy [TICKER] [shares]**.";
    const lines = [`📊 **YOUR TRADE HISTORY** (last 10)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];
    for (const tx of data) {
      const isBuy = tx.action === "buy";
      const plStr = tx.profit_loss !== null && tx.profit_loss !== undefined
        ? ` | ${tx.profit_loss >= 0 ? `✅ +${eco.formatWallet(eco.fromCopper(Math.abs(tx.profit_loss)))}` : `❌ -${eco.formatWallet(eco.fromCopper(Math.abs(tx.profit_loss)))}`}`
        : "";
      const date = new Date(tx.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
      lines.push(
        `${isBuy ? "📈 BUY " : "📉 SELL"} **${tx.ticker}** x${tx.shares} @ ${eco.formatWallet(eco.fromCopper(tx.price_per_share))} | Total: ${eco.formatWallet(eco.fromCopper(tx.total_copper))}${plStr} *(${date})*`
      );
    }
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    return lines.join("\n");
  } catch (e) {
    console.error("[STOCK HISTORY]", e.message);
    return "⚔️ Couldn't load trade history.";
  }
}

async function logStockTransaction(userId, ticker, action, shares, pricePerShare, totalCopper, profitLoss) {
  try {
    await supabase.from("stock_transactions").insert({
      user_id: userId,
      ticker,
      action,
      shares,
      price_per_share: pricePerShare,
      total_copper: totalCopper,
      profit_loss: profitLoss,
    });
  } catch (e) { console.error("[LOG TX]", e.message); }
}

async function savePortfolio(userId, portfolio) {
  try {
    // Save portfolio + avgBuyPrice together
    const avgPrices = {};
    for (const [key, val] of avgBuyPrice.entries()) {
      if (key.startsWith(userId + "-")) {
        avgPrices[key.replace(userId + "-", "")] = val;
      }
    }
    await supabase.from("stock_portfolios").upsert({
      user_id: userId,
      portfolio: JSON.stringify(portfolio),
      avg_prices: JSON.stringify(avgPrices),
    }, { onConflict: "user_id" });
  } catch (e) { console.error("[SAVE PORTFOLIO]", e.message); }
}

async function loadPortfolios() {
  try {
    const { data } = await supabase.from("stock_portfolios").select("*");
    if (!data) return;
    for (const row of data) {
      try {
        stockPortfolios.set(row.user_id, JSON.parse(row.portfolio));
        // Load avg prices if saved
        if (row.avg_prices) {
          const avgP = JSON.parse(row.avg_prices);
          for (const [ticker, price] of Object.entries(avgP)) {
            avgBuyPrice.set(`${row.user_id}-${ticker}`, price);
          }
        }
      } catch {}
    }
    console.log(`[STOCKS] Loaded ${data.length} portfolio(s) with avg prices`);
  } catch (e) { console.error("[LOAD PORTFOLIOS]", e.message); }
}

async function saveStockPrices() {
  try {
    await supabase.from("empire_data").upsert({
      key: "stock_prices",
      value: { prices: stockPrices, candles: stockCandles },
    }, { onConflict: "key" });
  } catch (e) { console.error("[SAVE STOCKS]", e.message); }
}

async function loadStockPrices() {
  try {
    const { data } = await supabase.from("empire_data").select("value").eq("key", "stock_prices").single();
    if (data?.value?.prices) {
      stockPrices  = data.value.prices;
      stockCandles = data.value.candles || {};
      fixPennyStockPrices(); // fix any wrong penny prices
      console.log("[STOCKS] Prices + candles loaded from Supabase");
    } else {
      initStockPrices();
    }
  } catch {
    initStockPrices();
  }
}

function startStockMarket(guild, generalChannelId) {
  // Fetch real data every 4 hours independently
  const fetchRealData = async () => {
    try {
      const marketOpen = isMarketHours();

      // Always fetch crypto first — unlimited
      const btcChange = await fetchCryptoChange("bitcoin");
      const ethChange = await fetchCryptoChange("ethereum");
      if (btcChange !== null) cachedRealChanges["DARK"] = btcChange;
      if (ethChange !== null) cachedRealChanges["RUNE"] = ethChange;

      // Use crypto sentiment as fallback for all stocks
      // If BTC/ETH data available, derive traditional stock movements from it
      const cryptoSentiment = ((btcChange || 0) + (ethChange || 0)) / 2;

      // Try Alpha Vantage for traditional stocks
      let alphaWorking = true;
      for (const [ticker, stock] of Object.entries(STOCKS)) {
        if (stock.penny || stock.cryptoId) continue;
        if (!stock.realTicker || !marketOpen) {
          // Outside market hours — use scaled crypto sentiment + noise
          cachedRealChanges[ticker] = cryptoSentiment * 0.3 + (Math.random() - 0.5) * 0.005;
          continue;
        }
        if (!alphaWorking) {
          // Alpha Vantage exhausted — use crypto sentiment scaled by stock volatility
          cachedRealChanges[ticker] = cryptoSentiment * (stock.volatility / 0.20) * 0.4 + (Math.random() - 0.5) * 0.003;
          continue;
        }
        const change = await fetchStockChange(stock.realTicker);
        if (change !== null) {
          cachedRealChanges[ticker] = change;
          await new Promise(r => setTimeout(r, 15000));
        } else {
          // Alpha Vantage returned nothing — mark as exhausted, use crypto fallback
          alphaWorking = false;
          cachedRealChanges[ticker] = cryptoSentiment * (stock.volatility / 0.20) * 0.4 + (Math.random() - 0.5) * 0.003;
          console.log(`[STOCKS] Alpha Vantage exhausted — using crypto fallback for ${ticker}`);
        }
      }

      // Penny stocks always use crypto sentiment + extra noise
      for (const [ticker, stock] of Object.entries(STOCKS)) {
        if (!stock.penny) continue;
        cachedRealChanges[ticker] = cryptoSentiment * (stock.volatility / 0.20) * 0.6 + (Math.random() - 0.5) * stock.volatility * 0.1;
      }

      console.log(`[STOCKS] Real data fetched | BTC: ${btcChange?.toFixed(4) || "N/A"} | ETH: ${ethChange?.toFixed(4) || "N/A"} | Alpha: ${alphaWorking ? "OK" : "EXHAUSTED→crypto fallback"}`);
    } catch (e) {
      console.error("[STOCKS] Real data fetch error:", e.message);
    }
    setTimeout(fetchRealData, 4 * 60 * 60 * 1000);
  };
  setTimeout(fetchRealData, 5000);

  // Tick every 1 minute — ALWAYS reschedules even on error
  const tick = async () => {
    console.log("[STOCKS TICK] Starting tick at", new Date().toISOString());
    try {
      await tickStockMarket();
      await saveStockPrices();
      console.log("[STOCKS TICK] Tick complete — prices saved");
      const channel = guild.channels.cache.get(generalChannelId);
      if (channel) {
        for (const [ticker] of Object.entries(STOCKS)) {
          const candles = stockCandles[ticker] || [];
          if (candles.length < 2) continue;
          const prev = candles[candles.length - 2].c;
          const curr = candles[candles.length - 1].c;
          const pct = (curr - prev) / prev * 100;
          if (Math.abs(pct) >= 5) {
            const dir = pct > 0 ? "📈 **SURGING**" : "📉 **CRASHING**";
            await channel.send(
              `${dir} **${ticker}** — ${STOCKS[ticker].name} moved **${pct > 0 ? "+" : ""}${pct.toFixed(1)}%** in 1 minute!\n` +
              `Current: **${eco.formatWallet(eco.fromCopper(stockPrices[ticker]))}** | Knight stocks / Knight market / Knight trade`
            ).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error("[STOCKS TICK ERROR]", e.message);
    }
    setTimeout(tick, 60 * 1000);
  };

  setTimeout(tick, 60 * 1000);
  console.log("📊 Stock market started — 1 min candles | Real data every 4h | Crypto live");
}

async function tickImmediately() {
  await tickStockMarket();
  await saveStockPrices();
  console.log("[STOCKS] Immediate tick complete");
}

/**
 * Force N instant candles on a specific ticker at +5% or -5% each.
 * direction: 1 = pump (green), -1 = crash (red)
 */
async function forcePumpCrash(ticker, rounds, direction) {
  ticker = ticker.toUpperCase();
  if (!STOCKS[ticker]) return;
  for (let i = 0; i < rounds; i++) {
    const open = stockPrices[ticker];
    const move = direction * 0.05; // exactly 5% per candle
    const close = Math.max(1, Math.round(open * (1 + move)));
    // Wick extends slightly beyond body
    const high  = direction > 0 ? Math.round(close * 1.005) : Math.round(open * 1.002);
    const low   = direction > 0 ? Math.round(open * 0.998)  : Math.round(close * 0.995);
    const now   = new Date();
    const label = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
    if (!stockCandles[ticker]) stockCandles[ticker] = [];
    stockCandles[ticker].push({ o: open, h: high, l: low, c: close, label });
    if (stockCandles[ticker].length > 60) stockCandles[ticker].shift();
    stockPrices[ticker] = close;
    // Small delay between candles so they look distinct
    if (i < rounds - 1) await new Promise(r => setTimeout(r, 300));
  }
  await saveStockPrices();
  console.log(`[STOCKS] Force ${direction > 0 ? "PUMP" : "CRASH"} ${ticker} x${rounds} — final price: ${stockPrices[ticker]}`);
}

// ═══════════════════════════════════════════════════════════════
// ── MARRIAGE SYSTEM ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const MARRIAGE_COST = 5000;
const DIVORCE_COST = 10000;
const pendingProposals = new Map();

async function proposeMarriage(proposerId, targetId, guild, channelId) {
  if (proposerId === targetId) return "⚔️ You can't marry yourself. Touch grass.";
  if (targetId === MASTER_ID) return "👑 You dare propose to the King? Absolutely not.";

  const existing = await getMarriage(proposerId);
  if (existing) return `⚔️ You're already married to <@${existing.partnerId}>. Divorce first.`;
  const targetExisting = await getMarriage(targetId);
  if (targetExisting) return `⚔️ <@${targetId}> is already married to <@${targetExisting.partnerId}>.`;

  const deducted = await eco.deductCopper(proposerId, MARRIAGE_COST).catch(() => null);
  if (!deducted) return `⚔️ You need **${eco.formatWallet(eco.fromCopper(MARRIAGE_COST))}** to propose. Buy a ring first.`;

  if (pendingProposals.has(targetId)) {
    await eco.addCopper(proposerId, MARRIAGE_COST).catch(() => {});
    return "⚔️ That person already has a pending proposal.";
  }

  const timeout = setTimeout(async () => {
    if (pendingProposals.has(targetId)) {
      pendingProposals.delete(targetId);
      await eco.addCopper(proposerId, MARRIAGE_COST).catch(() => {});
      const ch = guild.channels.cache.get(channelId);
      if (ch) await ch.send(`💔 <@${targetId}> didn't respond in time. Proposal expired. Ring refunded.`).catch(() => {});
    }
  }, 60000);

  pendingProposals.set(targetId, { proposerId, channelId, timeout });

  return (
    `💍 **MARRIAGE PROPOSAL**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<@${proposerId}> has proposed to <@${targetId}>! 💕\n\n` +
    `<@${targetId}> — say **Knight marry accept** to say yes\n` +
    `or **Knight marry decline** to break their heart.\n\n` +
    `*You have 60 seconds to decide.*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Married couples get a **+10% daily bonus**!*`
  );
}

async function acceptProposal(targetId, guild, channelId) {
  const proposal = pendingProposals.get(targetId);
  if (!proposal) return "⚔️ No pending proposal for you.";

  clearTimeout(proposal.timeout);
  pendingProposals.delete(targetId);

  const marriedAt = new Date().toISOString();
  await supabase.from("marriages").upsert([
    { user_id: proposal.proposerId, partner_id: targetId, married_at: marriedAt },
    { user_id: targetId, partner_id: proposal.proposerId, married_at: marriedAt },
  ]).catch(() => {});

  return (
    `💒 **MARRIED!** 💒\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<@${proposal.proposerId}> 💍 <@${targetId}>\n\n` +
    `*The Empire witnesses this union. May it last forever... or at least a week.*\n` +
    `💡 Married couples get a **+10% daily bonus**!\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  );
}

async function declineProposal(targetId) {
  const proposal = pendingProposals.get(targetId);
  if (!proposal) return "⚔️ No pending proposal for you.";
  clearTimeout(proposal.timeout);
  pendingProposals.delete(targetId);
  await eco.addCopper(proposal.proposerId, MARRIAGE_COST).catch(() => {});
  return `💔 <@${targetId}> said **no**. Ring returned. That's rough.`;
}

async function divorce(userId) {
  const marriage = await getMarriage(userId);
  if (!marriage) return "⚔️ You're not married.";

  const deducted = await eco.deductCopper(userId, DIVORCE_COST).catch(() => null);
  if (!deducted) return `⚔️ Divorce costs **${eco.formatWallet(eco.fromCopper(DIVORCE_COST))}**. Can't even afford that, huh?`;

  try { await supabase.from("marriages").delete().eq("user_id", userId); await supabase.from("marriages").delete().eq("user_id", marriage.partnerId); } catch (e) { console.error("[DIVORCE]", e.message); }

  return `💔 **DIVORCED** — <@${userId}> and <@${marriage.partnerId}> are no longer married.\n*The Empire has seen many such endings. It's for the best.*`;
}

async function getMarriage(userId) {
  try {
    const { data } = await supabase.from("marriages").select("*").eq("user_id", userId).single();
    if (!data) return null;
    return { partnerId: data.partner_id, marriedAt: data.married_at };
  } catch { return null; }
}

async function getMarriageBonus(userId) {
  const m = await getMarriage(userId);
  return m ? 0.10 : 0;
}

// ═══════════════════════════════════════════════════════════════
// ── SHOP SYSTEM ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const SHOP_ITEMS = {
  rob_shield: {
    id: "rob_shield",
    name: "🛡️ Rob Shield",
    desc: "Immune to robbery for 24 hours",
    price: 50000,        // 5 Gold
    tier: "copper",
    duration: 24 * 60 * 60 * 1000,
  },
  lucky_charm: {
    id: "lucky_charm",
    name: "🍀 Lucky Charm",
    desc: "Better odds for 5 minutes — rerolls bad spins on slots (no match) & bad wheel spins (<1x), +5% coinflip win chance. No payout boost. Max 3 per day.",
    price: 5000000,      // 500 Gold — expensive for a reason
    tier: "copper",
    duration: 5 * 60 * 1000,
  },
  xp_boost: {
    id: "xp_boost",
    name: "⭐ Daily Boost",
    desc: "Double your next daily reward",
    price: 100000,       // 10 Gold
    tier: "copper",
    duration: null,
  },
  noble_pass: {
    id: "noble_pass",
    name: "📜 Noble Pass",
    desc: "Skip gambling cooldown once",
    price: 5000,         // 50 Silver
    tier: "copper",
    duration: null,
  },
  heist_boost: {
    id: "heist_boost",
    name: "🗝️ Vault Key",
    desc: "+20% heist success chance for your next heist",
    price: 200000,       // 20 Gold
    tier: "copper",
    duration: null,
  },
  stock_tip: {
    id: "stock_tip",
    name: "📰 Market Intel",
    desc: "Shows pending buy/sell pressure + momentum signals for all stocks — see what's coming before the next candle",
    price: 100000,       // 10 Gold
    tier: "copper",
    duration: null,
  },
  kings_call: {
    id: "kings_call",
    name: "👑 The King's Call",
    desc: "Summons the King to intervene in the market. King decides which stock and whether to pump or crash. 24h server cooldown. No refunds.",
    price: 10000000,     // 10 Stellar
    tier: "copper",
    duration: null,
  },
};

const userInventories = new Map();
const activeEffects = new Map();
// Daily purchase tracker: userId -> { date: "YYYY-MM-DD", lucky_charm: count }
const dailyPurchases = new Map();

function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function getDailyPurchaseCount(userId, itemId) {
  const today = getTodayKey();
  const record = dailyPurchases.get(userId);
  if (!record || record.date !== today) return 0;
  return record[itemId] || 0;
}

function recordDailyPurchase(userId, itemId, quantity) {
  const today = getTodayKey();
  const record = dailyPurchases.get(userId);
  if (!record || record.date !== today) {
    dailyPurchases.set(userId, { date: today, [itemId]: quantity });
  } else {
    record[itemId] = (record[itemId] || 0) + quantity;
  }
}

async function buyShopItem(userId, itemId, quantity = 1) {
  const item = SHOP_ITEMS[itemId];
  if (!item) return `⚔️ Item not found. Check **Knight shop** for available items.`;
  if (itemId === "rob_shield" && quantity > 1) return `⚔️ **Rob Shield** can only be held one at a time. Buy 1.`;
  if (quantity < 1 || quantity > 100) return `⚔️ Buy between 1 and 100 at a time.`;

  // Daily purchase limits
  const DAILY_LIMITS = { lucky_charm: 3 };
  if (DAILY_LIMITS[itemId] !== undefined) {
    const alreadyBought = getDailyPurchaseCount(userId, itemId);
    const limit = DAILY_LIMITS[itemId];
    if (alreadyBought >= limit) return `⚔️ You've already bought **${limit}x ${SHOP_ITEMS[itemId].name}** today. Daily limit reached — come back tomorrow.`;
    if (alreadyBought + quantity > limit) return `⚔️ That would exceed the daily limit of **${limit}x ${SHOP_ITEMS[itemId].name}**. You can only buy **${limit - alreadyBought}** more today.`;
  }

  const totalPrice = item.price * quantity;
  const deducted = await eco.deductCopper(userId, totalPrice).catch(() => null);
  if (!deducted) return `⚔️ You need **🟤 ${totalPrice.toLocaleString()} Copper** to buy ${quantity}x **${item.name}**.`;

  // Record daily purchase count
  if (DAILY_LIMITS && DAILY_LIMITS[itemId] !== undefined) recordDailyPurchase(userId, itemId, quantity);

  if (!userInventories.has(userId)) userInventories.set(userId, {});
  const inv = userInventories.get(userId);

  if (item.duration) {
    // Timed items — stack duration
    const currentExpiry = inv[itemId]?.expiresAt || Date.now();
    const addedDuration = item.duration * quantity;
    const newExpiry = Math.max(Date.now(), currentExpiry) + addedDuration;
    inv[itemId] = { expiresAt: newExpiry };
    const timeLeft = newExpiry - Date.now();
    setTimeout(() => {
      const i = userInventories.get(userId);
      if (i && i[itemId]?.expiresAt <= Date.now()) delete i[itemId];
    }, timeLeft);
  } else {
    // One-use items — stack uses
    inv[itemId] = { uses: (inv[itemId]?.uses || 0) + quantity };
  }

  await saveInventory(userId, inv);

  const totalDuration = item.duration ? item.duration * quantity : null;
  return (
    `🛒 **PURCHASED!** ${quantity}x ${item.name}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${item.desc}\n` +
    `💰 Total cost: **🟤 ${totalPrice.toLocaleString()} Copper**\n` +
    (totalDuration ? `⏰ Total duration: **${Math.round(totalDuration / 60000)} minutes**` : `🎯 **${quantity} use(s) added to inventory**`) +
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Use it with **Knight use ${itemId}***`
  );
}

async function useShopItem(userId, itemId, quantity = 1) {
  const item = SHOP_ITEMS[itemId];
  if (!item) return `⚔️ Unknown item.`;

  const inv = userInventories.get(userId) || {};
  const owned = inv[itemId];
  if (!owned) return `⚔️ You don't own **${item.name}**. Buy it with **Knight shop buy ${itemId}**.`;

  if (owned.expiresAt && owned.expiresAt > Date.now()) {
    // Rob shield can't be extended — one at a time only
    if (itemId === "rob_shield") return `⚔️ **${item.name}** is already active! Expires <t:${Math.floor(owned.expiresAt / 1000)}:R>`;
    // Other timed items — extend duration
    if (quantity > 1 && item.duration) {
      owned.expiresAt += item.duration * (quantity - 1);
      await saveInventory(userId, inv);
      return `✅ **${item.name}** extended! Now active for **${Math.round((owned.expiresAt - Date.now()) / 60000)} more minutes**.`;
    }
    return `⚔️ **${item.name}** is already active! Expires <t:${Math.floor(owned.expiresAt / 1000)}:R>`;
  }
  if (owned.uses !== undefined) {
    if (owned.uses <= 0) return `⚔️ You have no **${item.name}** uses left. Buy more with **Knight shop buy ${itemId}**.`;
    if (quantity > owned.uses) return `⚔️ You only have **${owned.uses}** use(s) of **${item.name}**.`;
  }

  // Special case: market intel
  if (itemId === "stock_tip") {
    owned.uses = 0;
    await saveInventory(userId, inv);

    const lines = [`📰 **MARKET INTEL — CLASSIFIED** 🔒\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];

    for (const [ticker, stock] of Object.entries(STOCKS)) {
      const candles = stockCandles[ticker] || [];
      const price   = stockPrices[ticker] || stock.basePrice * 100;

      // Pending pressure
      const pressure = marketPressure[ticker] || 0;
      const pressureStr = pressure > 0.02  ? `🔥 Heavy buy pressure (+${(pressure * 100).toFixed(1)}%)`
                        : pressure < -0.02 ? `🩸 Heavy sell pressure (${(pressure * 100).toFixed(1)}%)`
                        : pressure > 0     ? `📈 Light buy pressure`
                        : pressure < 0     ? `📉 Light sell pressure`
                        : `😴 No pending pressure`;

      // Momentum — last 5 candles
      const recent = candles.slice(-5);
      const bullish = recent.filter(c => c.c >= c.o).length;
      const bearish = recent.filter(c => c.c < c.o).length;
      const momentum = bullish >= 4 ? `🟢 Strong bullish (${bullish}/5 green)`
                     : bullish >= 3 ? `🟡 Mild bullish (${bullish}/5 green)`
                     : bearish >= 4 ? `🔴 Strong bearish (${bearish}/5 red)`
                     : bearish >= 3 ? `🟡 Mild bearish (${bearish}/5 red)`
                     : `⚪ Neutral — no clear trend`;

      // Signal
      const signal = (pressure > 0.02 || bullish >= 4) ? `⚡ **BUY SIGNAL**`
                   : (pressure < -0.02 || bearish >= 4) ? `⚠️ **SELL SIGNAL**`
                   : `🔍 **HOLD/WATCH**`;

      lines.push(`**${ticker}** — ${stock.name}\n  ${pressureStr}\n  ${momentum}\n  ${signal}`);
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*This intel expires after 1 minute. Act fast.*`);
    return lines.join("\n");
  }

  if (itemId === "kings_call") {
    // Check server-wide cooldown
    const now = Date.now();
    const remaining = KINGS_CALL_COOLDOWN - (now - kingsCallLastUsed);
    if (remaining > 0) {
      const hrs = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      return `⚔️ **The King's Call** is on server cooldown — available again in **${hrs}h ${mins}m**. Your use was **NOT** consumed.`;
    }
    kingsCallLastUsed = now;
    owned.uses = Math.max(0, (owned.uses || 1) - 1);
    await saveInventory(userId, inv);
    return `__KINGS_CALL__:${userId}`;
  }

  // noble_pass: don't consume on use — consumed when cooldown is actually skipped
  if (itemId === "noble_pass") {
    const available = owned.uses || 0;
    if (available <= 0) return `⚔️ You have no **Noble Pass** uses left.`;
    return `📜 **Noble Pass ready** — you have **${available}** use(s). Next time you hit a gambling cooldown it will be skipped automatically.`;
  }

  if (!activeEffects.has(userId)) activeEffects.set(userId, new Set());
  activeEffects.get(userId).add(itemId);

  if (item.duration) {
    const totalDuration = item.duration * quantity;
    owned.expiresAt = Date.now() + totalDuration;
    setTimeout(() => {
      const effects = activeEffects.get(userId);
      if (effects) effects.delete(itemId);
    }, totalDuration);
    await saveInventory(userId, inv);
    return `✅ **${quantity}x ${item.name}** activated! ${item.desc} — Active for **${Math.round(totalDuration / 60000)} minutes**`;
  } else {
    owned.uses = (owned.uses || 0) - quantity;
    await saveInventory(userId, inv);
    return `✅ **${quantity}x ${item.name}** used! ${item.desc}`;
  }
}

function hasEffect(userId, itemId) {
  const inv = userInventories.get(userId) || {};
  const owned = inv[itemId];
  if (!owned) return false;
  if (owned.expiresAt) return owned.expiresAt > Date.now();
  if (owned.uses !== undefined) return owned.uses > 0;
  return false;
}

function consumeItem(userId, itemId) {
  const inv = userInventories.get(userId) || {};
  if (inv[itemId]?.uses !== undefined) {
    inv[itemId].uses = Math.max(0, inv[itemId].uses - 1);
    saveInventory(userId, inv).catch(() => {});
  }
}

function getShopDisplay() {
  function fmtPrice(copper) {
    if (copper >= 1000000) return `⭐ ${(copper / 1000000).toFixed(0)} Stellar`;
    if (copper >= 10000)   return `🥇 ${(copper / 10000).toFixed(0)} Gold`;
    if (copper >= 100)     return `🪙 ${(copper / 100).toFixed(0)} Silver`;
    return `🟤 ${copper} Copper`;
  }
  const lines = [`🛒 **EMPIRE SHOP**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];
  for (const [id, item] of Object.entries(SHOP_ITEMS)) {
    lines.push(
      `${item.name} — **${fmtPrice(item.price)}**\n` +
      `  *${item.desc}*\n` +
      `  ID: \`${id}\``
    );
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*Buy: **Knight shop buy [id] [qty]** | Use: **Knight use [id]***`);
  return lines.join("\n");
}

function getInventoryDisplay(userId) {
  const inv = userInventories.get(userId) || {};
  const entries = Object.entries(inv).filter(([, v]) => {
    if (v.expiresAt) return v.expiresAt > Date.now();
    if (v.uses !== undefined) return v.uses > 0;
    return false;
  });
  if (!entries.length) return "🎒 Your inventory is empty. Buy items with **Knight shop**.";
  const lines = [`🎒 **YOUR INVENTORY**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];
  for (const [id, data] of entries) {
    const item = SHOP_ITEMS[id];
    if (!item) continue;
    const status = data.expiresAt
      ? `Expires <t:${Math.floor(data.expiresAt / 1000)}:R>`
      : `${data.uses} use(s) left`;
    lines.push(`${item.name} — *${status}*`);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*Use: **Knight use [id]***`);
  return lines.join("\n");
}

async function saveInventory(userId, inv) {
  try {
    await supabase.from("inventories").upsert({
      user_id: userId,
      inventory: JSON.stringify(inv),
    }, { onConflict: "user_id" });
  } catch (e) { console.error("[SAVE INV]", e.message); }
}

async function loadInventories() {
  try {
    const { data } = await supabase.from("inventories").select("*");
    if (!data) return;
    const now = Date.now();
    for (const row of data) {
      try {
        const inv = JSON.parse(row.inventory);
        for (const [id, val] of Object.entries(inv)) {
          if (val.expiresAt && val.expiresAt <= now) delete inv[id];
        }
        userInventories.set(row.user_id, inv);
      } catch {}
    }
    console.log(`[SHOP] Loaded ${data.length} inventories`);
  } catch (e) { console.error("[LOAD INV]", e.message); }
}

module.exports = {
  initFeatures,
  // AFK
  setAfk, removeAfk, getAfk, isAfk, getAfkPingerMute, formatAfkTime,
  // Giveaway
  startGiveaway, endGiveaway, rerollGiveaway, loadGiveaways, activeGiveaways,
  // Trivia
  activeTournaments, startTriviaRound, getScoreBoard, endTriviaTournament, TRIVIA_QUESTIONS,
  // Heist
  activeHeists, startHeist, joinHeist, executeHeist,
  // Stocks
  STOCKS, stockPrices,
  get stockCandles() { return stockCandles; },
  stockPortfolios,
  buyStock, sellStock, getMarketBoard, getMarketBoardData, getPortfolio, getStockHistory,
  startStockMarket, loadPortfolios, loadStockPrices, tickImmediately,
  forcePumpCrash,
  get marketPressure() { return marketPressure; },
  isMarketHours,
  get stockMarketOpen() { return stockMarketOpen; },
  setStockMarketOpen: (v) => { stockMarketOpen = v; },
  get kingManipulation() { return kingManipulation; },
  setKingManipulation: (v) => { kingManipulation = v; },
  // Marriage
  proposeMarriage, acceptProposal, declineProposal, divorce,
  getMarriage, getMarriageBonus, pendingProposals,
  MARRIAGE_COST, DIVORCE_COST,
  // Shop
  SHOP_ITEMS, buyShopItem, useShopItem, hasEffect, consumeItem,
  getShopDisplay, getInventoryDisplay, loadInventories,
};
