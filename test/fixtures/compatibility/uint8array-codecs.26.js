"use strict";

const assert = require("node:assert/strict");

const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
const base64 = bytes.toBase64();
const hex = bytes.toHex();

assert.equal(base64, "AAEC/f7/");
assert.equal(hex, "000102fdfeff");
assert.deepEqual(Uint8Array.fromBase64(base64), bytes);
assert.deepEqual(Uint8Array.fromHex(hex), bytes);

const errorEvent = new ErrorEvent("error", {
  error: new Error("boom"),
  message: "boom",
});
assert.equal(errorEvent.message, "boom");
assert.equal(errorEvent.error.message, "boom");
