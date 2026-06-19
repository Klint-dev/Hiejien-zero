const { createClient } = require("@supabase/supabase-js");

let supabase;
function initBank(url, key) {
  supabase = createClient(url, key);
  console.log("🏦 Bank system initialized");
}

// ── Vault Tiers ───────────────────────────────────────────────────────────────
const VAULT_TIERS = {
  basic:    { label: "🪨 Basic Vault",     maxStorage: 50 * 10000,            cost: 0,                interestRate: 0.005, feeRate: 0.001, emoji: "🪨" },
  stone:    { label: "⚔️ Stone Vault",     maxStorage: 500 * 10000,           cost: 20 * 10000,       interestRate: 0.010, feeRate: 0.002, emoji: "⚔️" },
  iron:     { label: "🛡️ Iron Vault",      maxStorage: 2000 * 10000,          cost: 80 * 10000,       interestRate: 0.015, feeRate: 0.003, emoji: "🛡️" },
  steel:    { label: "💠 Steel Vault",     maxStorage: 10 * 1000000,          cost: 300 * 10000,      interestRate: 0.020, feeRate: 0.004, emoji: "💠" },
  crystal:  { label: "💎 Crystal Vault",   maxStorage: 50 * 1000000,          cost: 5 * 1000000,      interestRate: 0.025, feeRate: 0.005, emoji: "💎" },
  stellar:  { label: "🌟 Stellar Vault",   maxStorage: 150 * 1000000,         cost: 20 * 1000000,     interestRate: 0.030, feeRate: 0.006, emoji: "🌟" },
  royal:    { label: "👑 Royal Vault",     maxStorage: 400 * 1000000,         cost: 80 * 1000000,     interestRate: 0.035, feeRate: 0.007, emoji: "👑" },
  emperor:  { label: "⚡ Emperor's Vault", maxStorage: 1000 * 1000000,        cost: 200 * 1000000,    interestRate: 0.040, feeRate: 0.008, emoji: "⚡" },
  sovereign:{ label: "🌌 Sovereign Vault", maxStorage: 10000 * 1000000,       cost: 500 * 1000000,    interestRate: 0.045, feeRate: 0.009, emoji: "🌌" },
  king:     { label: "♾️ Infinite Vault",  maxStorage: Number.MAX_SAFE_INTEGER, cost: 0,              interestRate: 0.000, feeRate: 0.000, emoji: "♾️" },
};

const TIER_ORDER = ["basic","stone","iron","steel","crystal","stellar","royal","emperor","sovereign","king"];

function getNextTier(currentTier) {
  const idx = TIER_ORDER.indexOf(currentTier);
  if (idx === -1 || idx === TIER_ORDER.length - 1) return null;
  return TIER_ORDER[idx + 1];
}

// ── Bank Operations ───────────────────────────────────────────────────────────
async function getBankAccount(userId) {
  try {
    const { data } = await supabase.from("banks").select("*").eq("user_id", userId).single();
    if (!data) return { user_id: userId, balance: 0, vault_tier: "basic", last_processed: new Date().toISOString() };
    return data;
  } catch {
    return { user_id: userId, balance: 0, vault_tier: "basic", last_processed: new Date().toISOString() };
  }
}

async function saveBankAccount(account) {
  try {
    await supabase.from("banks").upsert(account, { onConflict: "user_id" });
  } catch (e) { console.error("[SAVE BANK]", e.message); }
}

async function processBank(account, masterId, addToTreasury) {
  const now = Date.now();
  const lastProcessed = new Date(account.last_processed).getTime();
  const hoursSince = (now - lastProcessed) / (1000 * 60 * 60);
  if (hoursSince < 24) return account; // not yet

  const tier = VAULT_TIERS[account.vault_tier] || VAULT_TIERS.basic;
  const balance = account.balance;
  if (balance <= 0) {
    account.last_processed = new Date().toISOString();
    await saveBankAccount(account);
    return account;
  }

  const interest = Math.floor(balance * tier.interestRate);
  const fee = Math.floor(balance * tier.feeRate);
  const net = interest - fee;

  account.balance = Math.max(0, balance + net);
  account.last_processed = new Date().toISOString();
  await saveBankAccount(account);

  // Fee goes to King's treasury
  if (fee > 0 && addToTreasury) await addToTreasury(masterId, fee);

  return account;
}

async function deposit(userId, copperAmount) {
  const account = await getBankAccount(userId);
  const tier = VAULT_TIERS[account.vault_tier] || VAULT_TIERS.basic;
  if (account.balance + copperAmount > tier.maxStorage) {
    return { success: false, reason: "Exceeds vault storage limit of **" + formatCopper(tier.maxStorage) + "**. Upgrade your vault with **Knight bank upgrade**." };
  }
  account.balance += copperAmount;
  await saveBankAccount(account);
  return { success: true, account };
}

async function withdraw(userId, copperAmount) {
  const account = await getBankAccount(userId);
  if (copperAmount > account.balance) return { success: false, reason: "Insufficient bank balance." };
  account.balance -= copperAmount;
  await saveBankAccount(account);
  return { success: true, account };
}

async function upgradeTier(userId, masterId, addToTreasury, deductFromWallet) {
  const account = await getBankAccount(userId);
  const nextTierKey = getNextTier(account.vault_tier);
  if (!nextTierKey) return { success: false, reason: "You already have the highest vault tier available to you. 👑" };

  // King vault is exclusive to the King
  if (nextTierKey === "king" && userId !== masterId) {
    return { success: false, reason: "⚔️ The Infinite Vault is reserved for the King alone. Know your place." };
  }

  const nextTier = VAULT_TIERS[nextTierKey];
  if (nextTier.cost > 0) {
    const deducted = await deductFromWallet(userId, nextTier.cost);
    if (!deducted) return { success: false, reason: "Insufficient funds. You need **" + formatCopper(nextTier.cost) + "** to upgrade." };
    await addToTreasury(masterId, nextTier.cost); // goes to King
  }
  account.vault_tier = nextTierKey;
  await saveBankAccount(account);
  return { success: true, account, tier: nextTier };
}

async function getBankBalance(userId) {
  const account = await getBankAccount(userId);
  return account.balance;
}

async function deductFromBank(userId, amount) {
  const account = await getBankAccount(userId);
  if (account.balance < amount) {
    // Deduct what we can
    const deducted = account.balance;
    account.balance = 0;
    await saveBankAccount(account);
    return deducted;
  }
  account.balance -= amount;
  await saveBankAccount(account);
  return amount;
}

function formatCopper(copper) {
  if (copper >= 1000000) return (copper / 1000000).toFixed(2) + " Stellar";
  if (copper >= 10000) return (copper / 10000).toFixed(2) + " Gold";
  if (copper >= 100) return (copper / 100).toFixed(2) + " Silver";
  return copper + " Copper";
}

// ── Daily Processing (called every 24h) ──────────────────────────────────────
async function runDailyBankProcessing(masterId, addToTreasury) {
  try {
    const { data } = await supabase.from("banks").select("*");
    if (!data) return;
    let processed = 0;
    for (const account of data) {
      await processBank(account, masterId, addToTreasury);
      processed++;
    }
    console.log("[BANK] Daily processing complete — " + processed + " accounts");
  } catch (e) { console.error("[BANK DAILY]", e.message); }
}

async function wipeAllBanks() {
  try {
    await supabase.from("banks").update({ balance: 0 }).neq("user_id", "0");
    console.log("[BANK] All bank balances wiped by King");
    return true;
  } catch (e) {
    console.error("[BANK WIPE]", e.message);
    return false;
  }
}

module.exports = {
  initBank, getBankAccount, saveBankAccount, deposit, withdraw,
  upgradeTier, getBankBalance, deductFromBank, formatCopper,
  runDailyBankProcessing, wipeAllBanks, VAULT_TIERS, TIER_ORDER, getNextTier, processBank
};
