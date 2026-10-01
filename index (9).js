/**
 * Backend for a Telegram Mini App reward system.
 * All coin balances live in D1 — the frontend must NOT keep balance in
 * localStorage; it always reads/writes through this API.
 *
 * Endpoints (all POST, all require Telegram WebApp `initData`):
 *   POST /balance   { initData }                          -> current balance
 *   POST /earn      { initData, amount, type, meta? }      -> credits coins (ad reward, bonus, etc.)
 *   POST /withdraw  { initData, faucetpay_email, amount }  -> debits coins + instant FaucetPay payout
 *
 * ⚠️ REQUIRED D1 MIGRATION before deploying this version — the withdrawal
 * cooldown is now enforced with an atomic UPDATE against a column on
 * `users`, not a SELECT against `withdrawals`. Run this once:
 *
 *   ALTER TABLE users ADD COLUMN last_withdraw_at INTEGER DEFAULT 0;
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your bot's domain in production
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "Not found" }, 404);

    if (url.pathname === "/balance") return handleBalance(request, env);
    if (url.pathname === "/earn") return handleEarn(request, env);
    if (url.pathname === "/withdraw") return handleWithdraw(request, env);

    return json({ error: "Not found" }, 404);
  },
};

// ── /balance ──────────────────────────────────────────────────────────────
async function handleBalance(request, env) {
  const body = await safeJson(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const verified = await verifyTelegramInitData(body.initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified.ok) return json({ error: "Telegram verification failed: " + verified.reason }, 401);

  const user = await getOrCreateUser(env, verified.user);
  return json({ balance: user.balance });
}

// ── Server-side reward rules — the ONLY source of truth for reward amounts.
// The client's `amount` field is never trusted; the server always decides
// how many coins a given reward type/network is worth, and enforces daily
// limits + cooldowns by querying transaction history in D1. This prevents
// a user from calling /earn directly with an inflated `amount`.
const REWARD_RULES = {
  daily_bonus:   { amount: 5, dailyLimit: 1, cooldownMs: 0 },
  adsgram:       { amount: 5, dailyLimit: 3, cooldownMs: 2 * 60 * 1000 },
  monetag:       { amount: 3, dailyLimit: 3, cooldownMs: 3 * 60 * 1000 },
  monetag_popup: { amount: 2, dailyLimit: 2, cooldownMs: 3 * 60 * 1000 },
};

function resolveRewardRule(type, network) {
  if (type === "daily_bonus") {
    return { ...REWARD_RULES.daily_bonus, matchType: "daily_bonus", networkPredicate: () => true };
  }
  if (type === "ad_reward") {
    if (network === "Adsgram") {
      return { ...REWARD_RULES.adsgram, matchType: "ad_reward", networkPredicate: (n) => n === "Adsgram" };
    }
    if (network === "Monetag") {
      return { ...REWARD_RULES.monetag, matchType: "ad_reward", networkPredicate: (n) => n === "Monetag" };
    }
    if (network === "Monetag Popup") {
      return { ...REWARD_RULES.monetag_popup, matchType: "ad_reward", networkPredicate: (n) => n === "Monetag Popup" };
    }
    // App has no "normal ad" feature — any network name other than the
    // three known ones is an unrecognized reward, not a fallback type.
    return null;
  }
  return null;
}

function getISTMidnightTodayMs() {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const istNow = Date.now() + IST_OFFSET;
  const istMidnight = Math.floor(istNow / 86400000) * 86400000;
  return istMidnight - IST_OFFSET;
}

// ── Global daily earning cap — across ALL reward types combined (daily
// bonus + every ad network). Enforced on top of each rule's own
// dailyLimit/cooldown, since summing every individual rule's max
// (daily_bonus 5 + adsgram 15 + monetag 9 + popup 4 = 33)
// would let a user earn far more than this cap in a single day.
const DAILY_EARN_CAP = 33;

async function getDailyEarnedTotal(env, telegramId, sinceTs) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM coin_transactions
     WHERE telegram_id = ? AND type IN ('daily_bonus', 'ad_reward') AND created_at >= ?`
  ).bind(telegramId, sinceTs).first();
  return row ? row.total : 0;
}

async function getRuleUsage(env, telegramId, matchType, sinceTs, networkPredicate) {
  const rows = await env.DB.prepare(
    `SELECT meta, created_at FROM coin_transactions WHERE telegram_id = ? AND type = ? AND created_at >= ? ORDER BY created_at DESC`
  ).bind(telegramId, matchType, sinceTs).all();
  return (rows.results || []).filter((r) => {
    let network;
    try { network = r.meta ? JSON.parse(r.meta).network : undefined; } catch { network = undefined; }
    return networkPredicate(network);
  });
}

// ── /earn ─────────────────────────────────────────────────────────────────
async function handleEarn(request, env) {
  const body = await safeJson(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const { initData, type, meta } = body;
  if (!type || typeof type !== "string") {
    return json({ error: "Missing type (e.g. 'ad_reward', 'daily_bonus')" }, 400);
  }

  const verified = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified.ok) return json({ error: "Telegram verification failed: " + verified.reason }, 401);

  const network = meta && typeof meta === "object" ? meta.network : undefined;
  const rule = resolveRewardRule(type, network);
  if (!rule) return json({ error: "Unknown reward type" }, 400);

  const telegramId = String(verified.user.id);
  await getOrCreateUser(env, verified.user); // ensures row exists

  const sinceTs = getISTMidnightTodayMs();
  const usage = await getRuleUsage(env, telegramId, rule.matchType, sinceTs, rule.networkPredicate);

  if (usage.length >= rule.dailyLimit) {
    return json({ error: "Daily limit reached for this reward" }, 429);
  }
  if (rule.cooldownMs > 0 && usage.length > 0) {
    const elapsed = Date.now() - usage[0].created_at; // rows are DESC, so [0] is most recent
    if (elapsed < rule.cooldownMs) {
      return json({ error: "Cooldown active", ms_remaining: rule.cooldownMs - elapsed }, 429);
    }
  }

  // Global daily cap — 31 coins total per user per IST day, across every
  // reward type combined. Checked last so type-specific errors above
  // (limit/cooldown) still take priority when both apply.
  const dailyTotal = await getDailyEarnedTotal(env, telegramId, sinceTs);
  if (dailyTotal + rule.amount > DAILY_EARN_CAP) {
    return json({
      error: `Daily earning limit reached (${DAILY_EARN_CAP} Coin/day)`,
      earned_today: dailyTotal,
      cap: DAILY_EARN_CAP,
    }, 429);
  }

  // The amount is ALWAYS the server-defined value for this rule — the
  // client can no longer influence how many coins it receives.
  const amount = rule.amount;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET balance = balance + ?, updated_at = ? WHERE telegram_id = ?`)
      .bind(amount, now, telegramId),
    env.DB.prepare(
      `INSERT INTO coin_transactions (telegram_id, amount, type, meta, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(telegramId, amount, type, meta ? JSON.stringify(meta) : null, now),
  ]);

  const updated = await env.DB.prepare(`SELECT balance FROM users WHERE telegram_id = ?`)
    .bind(telegramId).first();

  return json({ success: true, balance: updated.balance, amount });
}

// ── /withdraw ─────────────────────────────────────────────────────────────
async function handleWithdraw(request, env) {
  const body = await safeJson(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const { initData, faucetpay_email, amount } = body;
  if (!initData || !faucetpay_email || !amount) {
    return json({ error: "Missing initData, faucetpay_email, or amount" }, 400);
  }
  if (typeof amount !== "number" || amount <= 0) {
    return json({ error: "Invalid amount" }, 400);
  }

  const verified = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified.ok) return json({ error: "Telegram verification failed: " + verified.reason }, 401);

  const telegramId = String(verified.user.id);
  const telegramUsername = verified.user.username || null;
  const user = await getOrCreateUser(env, verified.user);

  // 1 & 2. Enforce cooldown + balance check ATOMICALLY in one UPDATE.
  // The old code did a separate SELECT for "last completed withdrawal"
  // before deducting balance. That left a gap: if two /withdraw requests
  // land at the same time, BOTH can pass the SELECT check (since neither
  // has inserted a 'completed' row yet), so both proceed and the 12h
  // cooldown gets bypassed entirely — this is exactly the pattern seen
  // in the D1 console (same telegram_id, many withdrawals seconds apart).
  // Folding the cooldown into the same WHERE clause as the balance guard
  // makes the whole check-and-claim a single atomic statement — no two
  // concurrent requests can both succeed.
  const limitHours = Number(env.WITHDRAW_LIMIT_HOURS || "12");
  const cutoff = Date.now() - limitHours * 60 * 60 * 1000;
  const now = Date.now();
  const prevLastWithdrawAt = user.last_withdraw_at || 0;

  const claim = await env.DB.prepare(
    `UPDATE users SET balance = balance - ?, last_withdraw_at = ?, updated_at = ?
     WHERE telegram_id = ? AND balance >= ? AND (last_withdraw_at IS NULL OR last_withdraw_at <= ?)`
  ).bind(amount, now, now, telegramId, amount, cutoff).run();

  if (!claim.meta || claim.meta.changes === 0) {
    // Something failed the atomic check — figure out which, for a clear error.
    const current = await env.DB.prepare(`SELECT balance, last_withdraw_at FROM users WHERE telegram_id = ?`)
      .bind(telegramId).first();
    if (current && current.last_withdraw_at && current.last_withdraw_at > cutoff) {
      const nextAvailable = current.last_withdraw_at + limitHours * 60 * 60 * 1000;
      return json({
        error: "Withdrawal limit active",
        next_available_at: nextAvailable,
        ms_remaining: nextAvailable - Date.now(),
      }, 429);
    }
    return json({ error: "Insufficient balance", balance: current ? current.balance : user.balance }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO coin_transactions (telegram_id, amount, type, meta, created_at) VALUES (?, ?, 'withdrawal', ?, ?)`
  ).bind(telegramId, -amount, JSON.stringify({ faucetpay_email }), now).run();

  // 4. Call FaucetPay instant payout API
  const currency = env.FAUCETPAY_CURRENCY || "USDT";
  // FaucetPay's /send API expects `amount` as an INTEGER in the coin's
  // smallest unit (like satoshis: 1 unit = 10^-8 of the coin), not a
  // decimal. Our app treats 1 Coin = 0.00001 USDT, so converting to
  // FaucetPay's smallest-unit format means multiplying by 1000
  // (0.00001 * 10^8 = 1000). Without this, FaucetPay receives the raw
  // coin count as smallest-units and pays out 1000x too little
  // (e.g. 25 Coins would send 0.00000025 USDT instead of 0.00025 USDT).
  const fpAmount = Math.round(amount * 1000);
  const fpParams = new URLSearchParams({
    api_key: env.FAUCETPAY_API_KEY,
    amount: String(fpAmount),
    to: faucetpay_email,
    currency,
  });

  let fpResult, fpOk = true;
  try {
    const fpRes = await fetch("https://faucetpay.io/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: fpParams.toString(),
    });
    fpResult = await fpRes.json();
  } catch (err) {
    fpOk = false;
    fpResult = { error: String(err) };
  }

  const success = fpOk && fpResult && fpResult.status === 200;

  await env.DB.prepare(
    `INSERT INTO withdrawals
     (telegram_id, telegram_username, amount, faucetpay_email, currency, status, faucetpay_payout_id, faucetpay_response, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    telegramId, telegramUsername, amount, faucetpay_email, currency,
    success ? "completed" : "failed",
    fpResult?.payout_id ? String(fpResult.payout_id) : null,
    JSON.stringify(fpResult),
    now
  ).run();

  // 5. FaucetPay failed — refund the deducted coins AND restore the
  //    cooldown timestamp to what it was before this attempt, so a failed
  //    payout doesn't cost the user their next legitimate withdrawal window.
  if (!success) {
    const refundAt = Date.now();
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET balance = balance + ?, last_withdraw_at = ?, updated_at = ? WHERE telegram_id = ?`)
        .bind(amount, prevLastWithdrawAt, refundAt, telegramId),
      env.DB.prepare(
        `INSERT INTO coin_transactions (telegram_id, amount, type, meta, created_at) VALUES (?, ?, 'withdrawal_refund', ?, ?)`
      ).bind(telegramId, amount, JSON.stringify(fpResult), refundAt),
    ]);
    return json({ error: "FaucetPay payout failed, coins refunded", details: fpResult }, 402);
  }

  const updatedUser = await env.DB.prepare(`SELECT balance FROM users WHERE telegram_id = ?`)
    .bind(telegramId).first();

  return json({
    success: true,
    payout_id: fpResult.payout_id,
    amount,
    currency,
    balance: updatedUser.balance,
    next_available_at: now + limitHours * 60 * 60 * 1000,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────
async function getOrCreateUser(env, tgUser) {
  const telegramId = String(tgUser.id);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO users (telegram_id, telegram_username, balance, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET telegram_username = excluded.telegram_username`
  ).bind(telegramId, tgUser.username || null, now, now).run();

  return env.DB.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(telegramId).first();
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Validates Telegram WebApp initData per Telegram's documented HMAC scheme.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
async function verifyTelegramInitData(initData, botToken) {
  if (!initData) return { ok: false, reason: "Missing initData" };
  if (!botToken) return { ok: false, reason: "Bot token not configured" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "Missing hash" };
  params.delete("hash");

  const dataCheckArr = [];
  for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join("\n");

  const encoder = new TextEncoder();

  const webAppDataKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secretKeyBytes = await crypto.subtle.sign("HMAC", webAppDataKey, encoder.encode(botToken));

  const secretHmacKey = await crypto.subtle.importKey(
    "raw", secretKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", secretHmacKey, encoder.encode(dataCheckString));
  const computedHash = toHex(signature);

  if (computedHash !== hash) return { ok: false, reason: "Hash mismatch" };

  const authDate = Number(params.get("auth_date")) * 1000;
  if (!authDate || Date.now() - authDate > 24 * 60 * 60 * 1000) {
    return { ok: false, reason: "initData expired" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "Missing user field" };

  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "Malformed user field" };
  }
  if (!user.id) return { ok: false, reason: "Missing user id" };

  return { ok: true, user };
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
