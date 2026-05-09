/**
 * lib/enforcement-public.js
 *
 * Public surface consumed by index.js. Re-exports from the three internal
 * modules so callers don't need to know the file split.
 */
module.exports = {
  ...require("./enforcement"),
  ...require("./trust-multipliers"),
  ...require("./abuse-reasons"),
  getActiveFraudFlags: require("./detection").getActiveFraudFlags,
};
