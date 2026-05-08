"use strict";

const counters = new Map();

function bumpReqCounter(route, stage, outcome) {
  const k = `${route}|${stage}|${outcome}`;
  counters.set(k, (counters.get(k) || 0) + 1);
}

function getRequestCounters() {
  const out = [];
  for (const [k, v] of counters) {
    const [route, stage, outcome] = k.split("|");
    out.push({ route, stage, outcome, count: v });
  }
  return out;
}

function resetForTest() { counters.clear(); }

module.exports = { bumpReqCounter, getRequestCounters, resetForTest };
