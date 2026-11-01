import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledEventRecoveryCandidate } from "../src/eventScheduledRecoveryD1.ts";
import { createScheduledRecoveryBudget } from "../src/scheduledRecoveryBudget.ts";

const nowMs = 1_000_000;
const hourMs = 60 * 60 * 1_000;

function candidate(
  eventId: string,
  overrides: Partial<
    NonNullable<ScheduledEventRecoveryCandidate["event"]>
  > = {},
): ScheduledEventRecoveryCandidate {
  const event = {
    eventId,
    status: "scheduled" as const,
    startAtMs: nowMs + 5 * hourMs,
    isSundayMons: false,
    ...overrides,
  };
  return { cursor: { eventId, startAtMs: event.startAtMs }, event };
}

function ordinaryRows(count: number, prefix = "ordinary") {
  return Array.from({ length: count }, (_, index) =>
    candidate(`${prefix}-${index}`),
  );
}

test("urgent and background allowances admit exact prefixes independently", () => {
  const budget = createScheduledRecoveryBudget(nowMs);
  const urgent = ordinaryRows(451);
  assert.deepEqual(budget.select(urgent, "urgent"), {
    selected: urgent.slice(0, 450),
    traversedCount: 450,
  });
  assert.deepEqual(budget.select(urgent.slice(450), "urgent"), {
    selected: [],
    traversedCount: 0,
  });
  const background = [urgent[450]!, ...ordinaryRows(100, "background")];
  assert.deepEqual(budget.select(background, "background"), {
    selected: background.slice(0, 100),
    traversedCount: 100,
  });
  assert.deepEqual(budget.select(background.slice(100), "background"), {
    selected: [],
    traversedCount: 0,
  });
});

test("an unaffordable event stops traversal before cheaper later rows", () => {
  const budget = createScheduledRecoveryBudget(nowMs);
  const ordinary = ordinaryRows(99);
  const sunday = candidate("sunday", { isSundayMons: true });
  const later = candidate("later");
  assert.deepEqual(budget.select([...ordinary, sunday, later], "background"), {
    selected: ordinary,
    traversedCount: 99,
  });
  assert.deepEqual(budget.select([sunday, later], "background"), {
    selected: [],
    traversedCount: 0,
  });
  assert.deepEqual(budget.select([sunday], "urgent"), {
    selected: [sunday],
    traversedCount: 1,
  });
  assert.deepEqual(budget.select([sunday, later], "background"), {
    selected: [later],
    traversedCount: 2,
  });
});

test("visited events traverse an exhausted lane without another reservation", () => {
  const budget = createScheduledRecoveryBudget(nowMs);
  const rows = ordinaryRows(450);
  budget.select(rows, "urgent");
  assert.deepEqual(budget.select(rows, "urgent"), {
    selected: [],
    traversedCount: rows.length,
  });
  const background = ordinaryRows(100, "background");
  assert.deepEqual(budget.select([...rows, ...background], "background"), {
    selected: background,
    traversedCount: rows.length + background.length,
  });
});

test("invalid rows remain selected once for reporting without consuming budget", () => {
  const budget = createScheduledRecoveryBudget(nowMs);
  const invalid = { ...candidate("invalid"), event: null };
  const rows = ordinaryRows(100);
  assert.deepEqual(budget.select([invalid, ...rows], "background"), {
    selected: [invalid, ...rows],
    traversedCount: 101,
  });
  assert.deepEqual(budget.select([invalid], "urgent"), {
    selected: [],
    traversedCount: 1,
  });
  const anotherInvalid = { ...candidate("another-invalid"), event: null };
  assert.deepEqual(budget.select([anotherInvalid], "background"), {
    selected: [anotherInvalid],
    traversedCount: 1,
  });
});

test("ineligible and elapsed announcements reserve only their event starts", () => {
  for (const event of [
    candidate("z3oj52Iiime"),
    candidate("sunday-without-prizes", {
      isSundayMons: true,
      startAtMs: nowMs + 4 * hourMs - 1,
    }),
    candidate("z3oj52Iiime", {
      isSundayMons: true,
      startAtMs: nowMs + hourMs - 1,
    }),
  ]) {
    const budget = createScheduledRecoveryBudget(nowMs);
    const rows = [event, ...ordinaryRows(100)];
    assert.deepEqual(budget.select(rows, "background"), {
      selected: rows.slice(0, 100),
      traversedCount: 100,
    });
  }
});

test("a reminder due exactly now retains its full announcement reservation", () => {
  const budget = createScheduledRecoveryBudget(nowMs);
  const rows = Array.from({ length: 21 }, (_, index) =>
    candidate(`sunday-${index}`, {
      isSundayMons: true,
      startAtMs: nowMs + 4 * hourMs,
    }),
  );
  assert.deepEqual(budget.select(rows, "background"), {
    selected: rows.slice(0, 20),
    traversedCount: 20,
  });
});

test("an elapsed reminder leaves the eligible prize announcement reserved", () => {
  const budget = createScheduledRecoveryBudget(nowMs);
  const rows = [
    candidate("z3oj52Iiime", {
      isSundayMons: true,
      startAtMs: nowMs + 4 * hourMs - 1,
    }),
    ...ordinaryRows(96),
  ];
  assert.deepEqual(budget.select(rows, "background"), {
    selected: rows.slice(0, 96),
    traversedCount: 96,
  });
});

test("an event eligible for both announcement kinds reserves both", () => {
  const budget = createScheduledRecoveryBudget(nowMs);
  const rows = [
    candidate("z3oj52Iiime", { isSundayMons: true }),
    ...ordinaryRows(92),
  ];
  assert.deepEqual(budget.select(rows, "background"), {
    selected: rows.slice(0, 92),
    traversedCount: 92,
  });
});

test("separate sweeps do not share reservations or visited event IDs", () => {
  const rows = ordinaryRows(100);
  const first = createScheduledRecoveryBudget(nowMs);
  const second = createScheduledRecoveryBudget(nowMs);
  assert.deepEqual(first.select(rows, "background"), {
    selected: rows,
    traversedCount: 100,
  });
  assert.deepEqual(second.select(rows, "background"), {
    selected: rows,
    traversedCount: 100,
  });
});
