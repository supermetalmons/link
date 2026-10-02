import {
  MatchStateD1Failure,
  readMatchStateControl,
  type MatchStateControl,
} from "./matchStateD1.ts";

export function assertDurableMatchState(
  control: MatchStateControl,
  expectedEpoch?: number,
): void {
  if (
    control.backend !== "durable" ||
    (expectedEpoch !== undefined && control.epoch !== expectedEpoch)
  ) {
    throw new MatchStateD1Failure("durable-authority-required");
  }
}

async function requireDurableMatchState(
  db: D1Database,
  expectedEpoch?: number,
): Promise<MatchStateControl> {
  const control = await readMatchStateControl(db);
  assertDurableMatchState(control, expectedEpoch);
  return control;
}

export async function requireActiveDurableMatchState(
  db: D1Database,
  expectedEpoch?: number,
): Promise<MatchStateControl> {
  const control = await requireDurableMatchState(db, expectedEpoch);
  if (control.state !== "active") {
    throw new MatchStateD1Failure("writes-disabled");
  }
  return control;
}
