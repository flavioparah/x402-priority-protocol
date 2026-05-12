"use strict";

const { audit, admin } = require("./logger");

function writeDepositVerified(entry) {
  try {
    const rec = { ...entry, ts: entry.ts ?? Date.now() };
    audit.info(rec);
  } catch {
    // Never throw from a logger.
  }
}

function writeAdminAction(entry) {
  try {
    const rec = { ...entry, ts: entry.ts ?? Date.now() };
    admin.info(rec);
  } catch {
    // Never throw from a logger.
  }
}

module.exports = {
  writeDepositVerified,
  writeAdminAction,
};
