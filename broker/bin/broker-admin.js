#!/usr/bin/env node
/**
 * broker-admin — administer a Trust-Score Broker via its admin HTTP API.
 *
 * The CLI deliberately talks ONLY to the broker's public /admin/* HTTP
 * surface. It never imports broker/store.js — that way the same binary
 * works against a local in-memory broker today and a remote Postgres-backed
 * broker tomorrow, without code changes.
 *
 * Env vars:
 *   BROKER_URL          — default http://localhost:3001
 *   BROKER_ADMIN_TOKEN  — required for all commands (except help/version)
 *
 * Usage:
 *   broker-admin register --id <slug> --pubkey <bs58> --tier <alpha|beta|production>
 *   broker-admin list [--json]
 *   broker-admin show <id>
 *   broker-admin suspend <id> [--reason <text>]
 *   broker-admin unsuspend <id>
 *   broker-admin promote <id>
 *   broker-admin help
 *   broker-admin version
 */

"use strict";

const http = require("http");
const https = require("https");
const url = require("url");
const path = require("path");
const fs = require("fs");

const HELP = `broker-admin — administer a Trust-Score Broker via its admin HTTP API.

Env vars:
  BROKER_URL          default http://localhost:3001
  BROKER_ADMIN_TOKEN  required for all commands

Commands:
  register --id <slug> --pubkey <bs58> --tier <alpha|beta|production>
                              Register a new provider.
  list [--json]               List all providers (human table or JSON).
  show <id>                   Show one provider as key/value pairs.
  suspend <id> [--reason <text>]
                              Mark provider as suspended (rejects /attest + /report).
  unsuspend <id>              Restore provider to active status.
  promote <id>                Manual tier bump: alpha→beta or beta→production.
  help                        Print this message.
  version                     Print CLI version (from package.json).

Exits 0 on success, 1 on any error (auth, network, or HTTP non-2xx).
`;

// ─── tiny arg parser (no commander/yargs dep) ───────────────────────────────

/**
 * Pulls --flag <value> and --flag=value style options out of argv.
 * Mutates the returned `positional` array. Boolean flags (no value) are
 * captured as `true`. Unknown flags are passed through — caller decides.
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[a.slice(2)] = true;
        } else {
          flags[a.slice(2)] = next;
          i++;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ─── HTTP client (uses Node builtins only) ──────────────────────────────────

function request(method, pathSuffix, body) {
  const base = process.env.BROKER_URL || "http://localhost:3001";
  const token = process.env.BROKER_ADMIN_TOKEN;
  if (!token) {
    return Promise.reject(new Error(
      "BROKER_ADMIN_TOKEN env var is not set. Export it before running: " +
      "export BROKER_ADMIN_TOKEN=<token>"
    ));
  }
  const u = new url.URL(pathSuffix, base);
  const lib = u.protocol === "https:" ? https : http;
  const opts = {
    method,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
      "X-Admin-Token": token,
      "Accept": "application/json",
    },
  };
  const payload = body ? JSON.stringify(body) : null;
  if (payload) {
    opts.headers["Content-Type"] = "application/json";
    opts.headers["Content-Length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── output helpers ─────────────────────────────────────────────────────────

function die(msg, code = 1) {
  process.stderr.write(`broker-admin: ${msg}\n`);
  process.exit(code);
}

function formatProvider(p) {
  const lines = [
    `id:               ${p.id}`,
    `pubkey:           ${p.pubkey}`,
    `tier:             ${p.tier}`,
    `status:           ${p.status}`,
    `registeredAt:     ${p.registeredAt ? new Date(p.registeredAt).toISOString() : "—"}`,
    `lastAttestAt:     ${p.lastAttestAt ? new Date(p.lastAttestAt).toISOString() : "—"}`,
    `attestedCount30d: ${p.attestedCount30d}`,
  ];
  if (p.reason) lines.push(`reason:           ${p.reason}`);
  return lines.join("\n");
}

function formatTable(rows) {
  if (rows.length === 0) return "(no providers registered)";
  const cols = ["id", "tier", "status", "attestedCount30d", "pubkey"];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const pad = (s, w) => String(s ?? "").padEnd(w, " ");
  const header = cols.map((c, i) => pad(c, widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const lines = [header, sep];
  for (const r of rows) lines.push(cols.map((c, i) => pad(r[c], widths[i])).join("  "));
  return lines.join("\n");
}

function checkHttpOk(r, action) {
  if (r.status >= 200 && r.status < 300) return;
  const reason = r.body && typeof r.body === "object"
    ? (r.body.error || JSON.stringify(r.body))
    : String(r.body);
  die(`${action} failed (HTTP ${r.status}): ${reason}`);
}

// ─── commands ───────────────────────────────────────────────────────────────

async function cmdRegister(flags) {
  if (!flags.id) die("register: --id is required");
  if (!flags.pubkey) die("register: --pubkey is required");
  if (!flags.tier) die("register: --tier is required (alpha|beta|production)");
  const r = await request("POST", "/admin/providers", {
    id: flags.id,
    pubkey: flags.pubkey,
    tier: flags.tier,
  });
  checkHttpOk(r, "register");
  console.log(`registered provider "${r.body.id}" (tier=${r.body.tier})`);
  console.log(formatProvider(r.body));
}

async function cmdList(flags) {
  const r = await request("GET", "/admin/providers");
  checkHttpOk(r, "list");
  if (flags.json) {
    console.log(JSON.stringify(r.body, null, 2));
    return;
  }
  console.log(formatTable(r.body));
}

async function cmdShow(positional) {
  const id = positional[0];
  if (!id) die("show: provider id is required");
  const r = await request("GET", `/admin/providers/${encodeURIComponent(id)}`);
  checkHttpOk(r, "show");
  console.log(formatProvider(r.body));
}

async function cmdSuspend(positional, flags) {
  const id = positional[0];
  if (!id) die("suspend: provider id is required");
  const r = await request("POST", `/admin/providers/${encodeURIComponent(id)}/suspend`, {
    reason: flags.reason || "",
  });
  checkHttpOk(r, "suspend");
  console.log(`suspended provider "${id}"`);
  console.log(formatProvider(r.body));
}

async function cmdUnsuspend(positional) {
  const id = positional[0];
  if (!id) die("unsuspend: provider id is required");
  const r = await request("POST", `/admin/providers/${encodeURIComponent(id)}/unsuspend`);
  checkHttpOk(r, "unsuspend");
  console.log(`unsuspended provider "${id}"`);
  console.log(formatProvider(r.body));
}

async function cmdPromote(positional) {
  const id = positional[0];
  if (!id) die("promote: provider id is required");
  const r = await request("POST", `/admin/providers/${encodeURIComponent(id)}/promote`);
  checkHttpOk(r, "promote");
  console.log(`promoted provider "${id}" to tier=${r.body.tier}`);
  console.log(formatProvider(r.body));
}

function cmdVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    console.log(pkg.version);
  } catch (e) {
    die(`could not read package.json: ${e.message}`);
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v") {
    cmdVersion();
    return;
  }

  const cmd = argv[0];
  const { flags, positional } = parseArgs(argv.slice(1));

  switch (cmd) {
    case "register":   return cmdRegister(flags);
    case "list":       return cmdList(flags);
    case "show":       return cmdShow(positional);
    case "suspend":    return cmdSuspend(positional, flags);
    case "unsuspend":  return cmdUnsuspend(positional);
    case "promote":    return cmdPromote(positional);
    default:
      die(`unknown command "${cmd}". Run "broker-admin help" for usage.`);
  }
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
