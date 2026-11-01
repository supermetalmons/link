import type { DatabaseSync } from "node:sqlite";

export function activateStrictLocalSchemaFixture(db: DatabaseSync): void {
  const control = db
    .prepare(
      "SELECT backend,state,epoch FROM match_state_control WHERE singleton=1",
    )
    .get();
  if (
    control?.backend === "durable" &&
    control.state === "active" &&
    typeof control.epoch === "number" &&
    control.epoch > 0
  )
    return;
  if (
    control?.backend !== "rtdb" ||
    control.state !== "active" ||
    control.epoch !== 1
  )
    throw new Error("strict-local-test-authority-conflict");
  db.prepare(
    `UPDATE match_state_control SET backend='durable',state='active',epoch=2,
    candidate_version_id='11111111-1111-4111-8111-111111111111',
    import_id='22222222-2222-4222-8222-222222222222',
    source_digest=?,verified_digest=?,fence_digest=?,
    source_record_count=0,source_claim_count=0,source_bundle_count=0,
    verified_at_ms=1,activated_at_ms=1 WHERE singleton=1`,
  ).run("a".repeat(64), "a".repeat(64), "b".repeat(64));
}
