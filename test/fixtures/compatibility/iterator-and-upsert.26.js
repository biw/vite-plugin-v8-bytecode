"use strict";

const assert = require("node:assert/strict");

const values = Iterator.concat([1, 2], new Set([3, 4])).toArray();
assert.deepEqual(values, [1, 2, 3, 4]);

const map = new Map();
assert.equal(map.getOrInsert("answer", 42), 42);
assert.equal(map.getOrInsert("answer", 100), 42);
assert.equal(
  map.getOrInsertComputed("computed", (key) => `${key}:value`),
  "computed:value"
);

const key = {};
const weakMap = new WeakMap();
assert.equal(weakMap.getOrInsert(key, 42), 42);
assert.equal(weakMap.getOrInsertComputed(key, () => 100), 42);
