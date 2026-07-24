"use strict";

const assert = require("node:assert/strict");

const events = [];
{
  using first = {
    [Symbol.dispose]() {
      events.push("dispose first");
    },
  };
  using second = {
    [Symbol.dispose]() {
      events.push("dispose second");
    },
  };
  events.push("body");
}

async function verifyAsyncDisposal() {
  const asyncEvents = [];
  {
    await using resource = {
      async [Symbol.asyncDispose]() {
        await Promise.resolve();
        asyncEvents.push("dispose async");
      },
    };
    asyncEvents.push("body");
  }
  assert.deepEqual(asyncEvents, ["body", "dispose async"]);
}

assert.deepEqual(events, ["body", "dispose second", "dispose first"]);
module.exports = verifyAsyncDisposal();
