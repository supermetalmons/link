import assert from "node:assert/strict";
import test from "node:test";
import {
  getDefaultScheduledDateTimeInput,
  validateEventCreateSchedule,
} from "../src/ui/event/eventCreateSchedule.ts";

const fields = {
  mode: "minutes",
  startsInMinutes: "5",
  scheduledDate: "2026-09-23",
  scheduledTime: "16:30",
  scheduledTimezone: "local",
};

test("event scheduling retains minute rounding and server-side upper-bound validation", () => {
  for (const input of ["", "0", "-1", "NaN", "Infinity"]) {
    assert.deepEqual(
      validateEventCreateSchedule({ ...fields, startsInMinutes: input }),
      { ok: false, error: "Enter at least 1 minute." },
    );
  }
  for (const [input, expected] of [
    ["1.9", 1],
    [" 15 ", 15],
    ["100000000", 100000000],
  ]) {
    assert.deepEqual(
      validateEventCreateSchedule({ ...fields, startsInMinutes: input }),
      { ok: true, schedule: expected },
    );
  }
});

test("datetime validation preserves messages and includes the IANA zone only for local scheduling", () => {
  const datetime = { ...fields, mode: "datetime" };
  assert.deepEqual(
    validateEventCreateSchedule({ ...datetime, scheduledDate: "" }, "UTC"),
    { ok: false, error: "Enter a valid date." },
  );
  for (const time of ["", "24:00", "12:60", "1:00"]) {
    assert.deepEqual(
      validateEventCreateSchedule({ ...datetime, scheduledTime: time }, "UTC"),
      { ok: false, error: "Enter a valid time." },
    );
  }
  assert.deepEqual(validateEventCreateSchedule(datetime, ""), {
    ok: false,
    error: "Could not detect local timezone.",
  });
  assert.deepEqual(validateEventCreateSchedule(datetime, "Europe/Istanbul"), {
    ok: true,
    schedule: {
      scheduledDate: "2026-09-23",
      scheduledTime: "16:30",
      scheduledTimezone: "local",
      localTimezoneIana: "Europe/Istanbul",
    },
  });
  assert.deepEqual(
    validateEventCreateSchedule({ ...datetime, scheduledTimezone: "ET" }),
    {
      ok: true,
      schedule: {
        scheduledDate: "2026-09-23",
        scheduledTime: "16:30",
        scheduledTimezone: "ET",
      },
    },
  );
});

test("default schedule rounds to the next local hour at least thirty minutes away", () => {
  assert.deepEqual(
    getDefaultScheduledDateTimeInput(new Date(2026, 8, 23, 12, 30).getTime()),
    { date: "2026-09-23", time: "13:00" },
  );
  assert.deepEqual(
    getDefaultScheduledDateTimeInput(new Date(2026, 8, 23, 12, 31).getTime()),
    { date: "2026-09-23", time: "14:00" },
  );
  assert.deepEqual(
    getDefaultScheduledDateTimeInput(new Date(2026, 11, 31, 23, 45).getTime()),
    { date: "2027-01-01", time: "01:00" },
  );
});
