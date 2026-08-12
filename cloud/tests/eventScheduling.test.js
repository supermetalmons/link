"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_STARTS_IN_MINUTES,
  MIN_STARTS_IN_MINUTES,
} = require("@mons/shared/events");
const {
  assertScheduledStartWindow,
  hasDateTimeScheduleRequest,
  parseScheduledDateParts,
  parseScheduledTimeParts,
  resolveRequestedScheduleTimezone,
  resolveScheduledDateTimeStartAtMs,
} = require("../functions/events/scheduling");

test("parses complete calendar dates and 24-hour wall times", () => {
  assert.deepEqual(parseScheduledDateParts("2028-02-29"), {
    year: 2028,
    month: 2,
    day: 29,
  });
  assert.equal(parseScheduledDateParts("2027-02-29"), null);
  assert.deepEqual(parseScheduledTimeParts("23:59"), {
    hour: 23,
    minute: 59,
  });
  assert.equal(parseScheduledTimeParts("24:00"), null);
});

test("maps preset and local schedule timezones", () => {
  assert.equal(
    resolveRequestedScheduleTimezone({ scheduledTimezone: "ET" }),
    "America/New_York",
  );
  assert.equal(
    resolveRequestedScheduleTimezone({ scheduledTimezone: "pt" }),
    "America/Los_Angeles",
  );
  assert.equal(
    resolveRequestedScheduleTimezone({
      scheduledTimezone: "local",
      localTimezoneIana: "Europe/Istanbul",
    }),
    "Europe/Istanbul",
  );
  assert.throws(
    () =>
      resolveRequestedScheduleTimezone({
        scheduledTimezone: "local",
        localTimezoneIana: "Invalid/Timezone",
      }),
    /valid IANA timezone/,
  );
});

test("rejects nonexistent DST wall times", () => {
  assert.throws(
    () =>
      resolveScheduledDateTimeStartAtMs({
        scheduledDate: "2026-03-08",
        scheduledTime: "02:30",
        scheduledTimezone: "ET",
      }),
    /does not exist/,
  );
});

test("selects the next future instant for an ambiguous DST wall time", () => {
  const request = {
    scheduledDate: "2026-11-01",
    scheduledTime: "01:30",
    scheduledTimezone: "ET",
  };

  assert.equal(
    resolveScheduledDateTimeStartAtMs(request, Date.UTC(2026, 10, 1, 4, 0)),
    Date.UTC(2026, 10, 1, 5, 30),
  );
  assert.equal(
    resolveScheduledDateTimeStartAtMs(request, Date.UTC(2026, 10, 1, 6, 0)),
    Date.UTC(2026, 10, 1, 6, 30),
  );
});

test("detects explicit date-time requests and enforces the scheduling window", () => {
  assert.equal(hasDateTimeScheduleRequest({ startsInMinutes: 10 }), false);
  assert.equal(
    hasDateTimeScheduleRequest({ scheduledDate: "2026-12-01" }),
    true,
  );
  const nowMs = Date.UTC(2026, 0, 1);

  assert.doesNotThrow(() =>
    assertScheduledStartWindow(
      nowMs + MIN_STARTS_IN_MINUTES * 60 * 1000,
      nowMs,
    ),
  );
  assert.throws(
    () =>
      assertScheduledStartWindow(
        nowMs + (MIN_STARTS_IN_MINUTES - 1) * 60 * 1000,
        nowMs,
      ),
    /at least/,
  );
  assert.throws(
    () =>
      assertScheduledStartWindow(
        nowMs + (MAX_STARTS_IN_MINUTES + 1) * 60 * 1000,
        nowMs,
      ),
    /within/,
  );
});
