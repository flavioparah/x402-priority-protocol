"use strict";

const { logger } = require("./logger");

function isMainnet({ NETWORK, REAL_RPC_URL }) {
  if (String(NETWORK || "").toLowerCase() === "mainnet") return true;
  if (typeof REAL_RPC_URL === "string" && REAL_RPC_URL.includes("mainnet-beta")) return true;
  return false;
}

function checkTrustedDepositsGuard(env) {
  const trusted =
    env.ESCROW_TRUST_DEPOSITS === "1" || env.ESCROW_TRUST_DEPOSITS === "true";
  if (!trusted) return;
  if (!isMainnet(env)) return;
  logger.fatal({
    reason: "boot_guard_trusted_deposits_mainnet",
    env: {
      NETWORK: env.NETWORK || null,
      REAL_RPC_URL: env.REAL_RPC_URL || null,
    },
    msg: "ESCROW_TRUST_DEPOSITS=1 must NEVER run against mainnet — refusing to boot",
  });
  setTimeout(() => process.exit(1), 50);
  throw new Error("boot_guard_trusted_deposits_mainnet");
}

async function waitForRedisOrFail(store, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30_000;
  const intervalMs = opts.intervalMs || 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let healthy = false;
    try { healthy = await store.isStoreHealthy(); } catch {}
    if (healthy) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("boot_guard_redis_required_timeout");
}

function parseAdminKeys(env) {
  const raw = env.ADMIN_KEYS_JSON;
  if (!raw) return new Map();
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return new Map();
    const m = new Map();
    for (const [keyId, secret] of Object.entries(obj)) {
      if (typeof secret === "string" && secret.length >= 32) m.set(keyId, secret);
    }
    return m;
  } catch {
    return new Map();
  }
}

module.exports = {
  checkTrustedDepositsGuard,
  waitForRedisOrFail,
  parseAdminKeys,
  isMainnet,
};
