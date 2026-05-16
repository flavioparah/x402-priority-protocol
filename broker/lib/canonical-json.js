/**
 * broker/lib/canonical-json.js
 *
 * Minimal RFC 8785 (JSON Canonicalization Scheme, JCS) implementation,
 * scoped to the shapes the Trust-Score Broker actually signs/verifies:
 * flat-or-shallowly-nested objects whose values are strings, numbers,
 * booleans, null, arrays, or further objects with the same constraints.
 *
 * Rules implemented (RFC 8785):
 *   - Object members are sorted lexicographically by UTF-16 code-point order
 *     of the key (JS's default Array.prototype.sort on strings does exactly
 *     this — code-point order, not locale-aware).
 *   - Strings are emitted with only the mandatory backslash escapes:
 *       "  \  and any control code < 0x20
 *     No optional escapes (no \/ , no \uXXXX for codepoints >= 0x20).
 *   - Numbers use the ECMA-262 Number.prototype.toString algorithm, which V8
 *     already implements (matches `JSON.stringify` output for finite values).
 *   - No insignificant whitespace.
 *   - Output is a JS string; the caller is responsible for UTF-8 encoding
 *     (typically via TextEncoder) before signing.
 *
 * Deliberate non-features (documented limitations):
 *   - NFC Unicode normalization is NOT applied. Callers must ensure inputs
 *     are already NFC-normalized if interop across normalizing peers matters.
 *     For our broker bodies (machine-generated ASCII-ish JSON), this is moot.
 *   - Non-BMP codepoints requiring surrogate-pair-aware escaping above 0x20
 *     are passed through as-is via the source string's UTF-16 units. RFC 8785
 *     mandates this is correct (no escape needed for codepoints >= 0x20).
 *   - IEEE 754 edge cases beyond V8's standard Number-to-string conversion
 *     are not specially handled; -0 serializes as "0" (matches JSON.stringify
 *     and ECMA-262 §6.1.6.1.13 step 2).
 *   - NaN and +/-Infinity throw (not representable in JSON; RFC 8785 §3.2.2.3).
 *   - `undefined` values throw (no JSON representation).
 */

function canonicalize(value) {
  return _serialize(value);
}

function _serialize(value) {
  if (value === null) return "null";
  if (value === undefined) {
    throw new TypeError("Cannot canonicalize undefined");
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return _serializeNumber(value);
  if (typeof value === "string") return _serializeString(value);
  if (Array.isArray(value)) {
    // Arrays preserve insertion order per RFC 8785 §3.2.2.
    const items = value.map(_serialize);
    return "[" + items.join(",") + "]";
  }
  if (typeof value === "object") {
    // Object.keys returns own enumerable string-keyed properties in
    // insertion order; we then sort lexicographically by UTF-16
    // code-point order (default String compare).
    const keys = Object.keys(value).sort();
    const pairs = keys.map(function (k) {
      return _serializeString(k) + ":" + _serialize(value[k]);
    });
    return "{" + pairs.join(",") + "}";
  }
  throw new TypeError("Cannot canonicalize value of type " + typeof value);
}

function _serializeNumber(n) {
  if (!isFinite(n)) {
    throw new RangeError("Non-finite number cannot be canonicalized: " + n);
  }
  // Normalize -0 to 0 (RFC 8785 / ECMA-262 ToString(Number) yields "0").
  if (Object.is(n, -0)) return "0";
  return n.toString();
}

function _serializeString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) {
      out += '\\"';
    } else if (c === 0x5c) {
      out += "\\\\";
    } else if (c === 0x08) {
      out += "\\b";
    } else if (c === 0x09) {
      out += "\\t";
    } else if (c === 0x0a) {
      out += "\\n";
    } else if (c === 0x0c) {
      out += "\\f";
    } else if (c === 0x0d) {
      out += "\\r";
    } else if (c < 0x20) {
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else {
      out += s[i];
    }
  }
  return out + '"';
}

module.exports = { canonicalize };
