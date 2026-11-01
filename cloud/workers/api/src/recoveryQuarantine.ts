const QUARANTINE_TARGETS = {
  auth: {
    table: "profile_auth_recovery_quarantine_canonical",
    identityColumns: ["profile_id"],
  },
  "profile-link": {
    table: "profile_link_catchup_quarantine_canonical",
    identityColumns: ["login_uid"],
  },
  rating: {
    table: "rating_projection_recovery_quarantine_canonical",
    identityColumns: ["operation_id", "projection_kind"],
  },
} as const;

type QuarantineSqlFragment = {
  sql: string;
  bindings: readonly (string | number | Uint8Array | null)[];
};

export function buildRecoveryQuarantineWrite({
  target,
  select,
  beforeInsert,
}: {
  target: keyof typeof QUARANTINE_TARGETS;
  select: QuarantineSqlFragment;
  beforeInsert?: QuarantineSqlFragment;
}) {
  const { table, identityColumns } = QUARANTINE_TARGETS[target];
  const identities = identityColumns.join(", ");
  return {
    sql: `${beforeInsert ? `${beforeInsert.sql}\n` : ""}INSERT INTO ${table} (
      ${identities}, revision_token, reason, quarantined_at_ms
    )
    ${select.sql}
    ON CONFLICT (${identities}) DO UPDATE SET
      revision_token = excluded.revision_token,
      reason = excluded.reason,
      quarantined_at_ms = excluded.quarantined_at_ms
    WHERE ${table}.revision_token != excluded.revision_token`,
    bindings: [...(beforeInsert?.bindings ?? []), ...select.bindings],
  };
}
