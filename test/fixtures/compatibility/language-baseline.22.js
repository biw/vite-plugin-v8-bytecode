"use strict";

const assert = require("node:assert/strict");

class Counter {
  #value;

  constructor(value = 0) {
    this.#value = value;
  }

  *values(...offsets) {
    for (const offset of offsets) {
      yield this.#value + offset;
    }
  }
}

async function* asynchronously(iterable) {
  for (const value of iterable) {
    yield await Promise.resolve(value);
  }
}

module.exports = (async () => {
  const counter = new Counter(40);
  const values = [];

  for await (const value of asynchronously(counter.values(1, 2))) {
    values.push(value);
  }

  const configuration = {
    nested: { answer: values.at(-1) },
  };
  assert.deepEqual(values, [41, 42]);
  assert.equal(configuration?.nested?.answer ?? 0, 42);
})();
