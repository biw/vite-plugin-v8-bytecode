"use strict";

const assert = require("node:assert/strict");

const instant = Temporal.Instant.from("2026-07-23T12:00:00Z");
assert.equal(
  instant.add({ hours: 2, minutes: 30 }).toString(),
  "2026-07-23T14:30:00Z"
);

const date = Temporal.PlainDate.from({ year: 2024, month: 2, day: 29 });
assert.equal(date.add({ years: 1 }).toString(), "2025-02-28");

const zoned = Temporal.ZonedDateTime.from(
  "2026-07-23T12:00:00-07:00[America/Los_Angeles]"
);
assert.equal(zoned.timeZoneId, "America/Los_Angeles");
