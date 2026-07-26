"use strict";

const assert = require("node:assert/strict");

const float16 = new Float16Array([1 / 3]);
assert.equal(float16[0], Math.f16round(1 / 3));

const escaped = RegExp.escape("answer: [40+2]");
assert.equal(new RegExp(`^${escaped}$`).test("answer: [40+2]"), true);
assert.equal(Error.isError(new TypeError("expected")), true);
assert.equal(Error.isError({ name: "Error" }), false);

const pattern = new URLPattern({
  pathname: "/users/:id",
});
assert.equal(pattern.exec("https://example.com/users/42").pathname.groups.id, "42");

Atomics.pause(1);

const memory64 = new WebAssembly.Memory({
  initial: 1n,
  maximum: 2n,
  address: "i64",
});
assert.equal(memory64.buffer.byteLength, 65_536);

module.exports = Promise.try((left, right) => left + right, 40, 2).then(
  (value) => assert.equal(value, 42)
);
