import type { AutomatchRecordMap } from "../../../../runtime/automatchRecords.js";
import type { RecoveryScanPage } from "../recoveryScanPage.ts";

export const AUTOMATCH_RECORD_TABLES = {
  automatch: {
    table: "automatch_entries_canonical",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  telegramAutomatches: {
    table: "automatch_telegram_sources_canonical",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  "telegramProjectionOutbox/automatch": {
    table: "automatch_telegram_projection_outbox_canonical",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  "profileGameProjectionOutbox/automatch": {
    table: "game_session_projection_outbox_canonical",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  gameplayMutationReceipts: {
    table: "game_session_mutation_receipts_canonical",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  gameplayMutationReceiptExpirations: {
    table: "game_session_mutation_receipts_canonical",
    valueColumn: "expiration_json",
    revisionColumn: "expiration_revision",
  },
} as const;

export type AutomatchRoot = keyof typeof AUTOMATCH_RECORD_TABLES;
export type AutomatchRecordValue<Root extends AutomatchRoot> =
  AutomatchRecordMap[Root] | null;

export type AutomatchRecordSnapshot<
  Root extends AutomatchRoot = AutomatchRoot,
> = {
  [Key in Root]: {
    root: Key;
    key: string;
    value: AutomatchRecordValue<Key>;
    revision: number;
  };
}[Root];

export type AutomatchOutboxRoot =
  | "telegramProjectionOutbox/automatch"
  | "profileGameProjectionOutbox/automatch";
export type AutomatchOutboxClaimSnapshot<
  Root extends AutomatchOutboxRoot = AutomatchOutboxRoot,
> = AutomatchRecordSnapshot<Root>;

export type AutomatchOutboxRecoveryPage<
  Root extends AutomatchOutboxRoot = AutomatchOutboxRoot,
> = {
  [Key in Root]: RecoveryScanPage<Record<
    string,
    AutomatchRecordValue<Key>
  > | null> & {
    snapshots?: ReadonlyMap<string, AutomatchOutboxClaimSnapshot<Key>>;
  };
}[Root];

export type AutomatchRecordMutation<
  Root extends AutomatchRoot = AutomatchRoot,
> = {
  [Key in Root]: {
    current: AutomatchRecordSnapshot<Key>;
    value: AutomatchRecordValue<Key>;
  };
}[Root];

export type AutomatchRuntimeControl = {
  backend: "d1";
  state: "active" | "frozen";
  epoch: number;
  freezeGeneration: number;
  stagedAtMs: number | null;
  candidateVersionId: string | null;
  importedAtMs: number | null;
  sourceDigest: string | null;
  importDigest: string | null;
  activatedAtMs: number | null;
};

export type AutomatchWriteAdmission = {
  admissionId: string;
  backend: "d1";
  epoch: number;
  freezeGeneration: number;
  kind: string;
  createdAtMs: number;
};

export type ControlRow = {
  backend: string;
  state: string;
  epoch: number;
  freeze_generation: number;
  staged_at_ms: number | null;
  candidate_version_id: string | null;
  imported_at_ms: number | null;
  source_digest: string | null;
  import_digest: string | null;
  activated_at_ms: number | null;
};

export type AdmissionRow = {
  admission_id: string;
  backend: "d1";
  epoch: number;
  freeze_generation: number;
  kind: string;
  created_at_ms: number;
};

export type RecordRow = {
  record_key: string;
  payload_json: string | null;
  revision: number;
};

export type MutationRecordRow = RecordRow & {
  expiration_json: string | null;
  expiration_revision: number;
};

export class AutomatchD1Failure extends Error {
  constructor(message = "automatch-state-unavailable", options?: ErrorOptions) {
    super(message, options);
  }
}
