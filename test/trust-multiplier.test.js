const {
  getTrustMultiplier,
  requiresFraudCorroboration,
  tier4ImmuneByScore,
  getTrustBand,
} = require("../lib/trust-multipliers");

let n = 0, failed = 0;
function check(label, cond) {
  n++;
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

// getTrustMultiplier
check("score 0 → 1×",   getTrustMultiplier(0)   === 1);
check("score 20 → 1×",  getTrustMultiplier(20)  === 1);
check("score 21 → 2×",  getTrustMultiplier(21)  === 2);
check("score 50 → 2×",  getTrustMultiplier(50)  === 2);
check("score 51 → 5×",  getTrustMultiplier(51)  === 5);
check("score 80 → 5×",  getTrustMultiplier(80)  === 5);
check("score 81 → 10×", getTrustMultiplier(81)  === 10);
check("score 100 → 10×",getTrustMultiplier(100) === 10);
check("undefined score → 1×", getTrustMultiplier(undefined) === 1);
check("null score → 1×",      getTrustMultiplier(null) === 1);
check("negative score → 1×",  getTrustMultiplier(-5) === 1);
check("score >100 → 10×",     getTrustMultiplier(150) === 10);

// requiresFraudCorroboration (≥ 81)
check("requires(80) === false", requiresFraudCorroboration(80) === false);
check("requires(81) === true",  requiresFraudCorroboration(81) === true);
check("requires(100) === true", requiresFraudCorroboration(100) === true);

// tier4ImmuneByScore (≥ 51)
check("tier4Immune(50) === false", tier4ImmuneByScore(50) === false);
check("tier4Immune(51) === true",  tier4ImmuneByScore(51) === true);

// getTrustBand
check("band(10)  === '0-20'",   getTrustBand(10)  === "0-20");
check("band(35)  === '21-50'",  getTrustBand(35)  === "21-50");
check("band(70)  === '51-80'",  getTrustBand(70)  === "51-80");
check("band(95)  === '81-100'", getTrustBand(95)  === "81-100");

if (failed > 0) {
  console.error(`\n${failed} of ${n} assertions failed.\n`);
  process.exit(1);
}
console.log(`\nAll ${n} assertions passed.\n`);
