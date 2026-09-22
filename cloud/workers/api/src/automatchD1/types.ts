import { RETIRED_STATE_BACKEND } from "../stateCompatibility.ts";

export const AUTOMATCH_RECORD_TABLES = {
  automatch: {
    table: "automatch_entries",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  telegramAutomatches: {
    table: "automatch_telegram_sources",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  "telegramProjectionOutbox/automatch": {
    table: "automatch_telegram_projection_outbox",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  "profileGameProjectionOutbox/automatch": {
    table: "game_session_projection_outbox",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  gameplayMutationReceipts: {
    table: "game_session_mutation_receipts",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  gameplayMutationReceiptExpirations: {
    table: "game_session_mutation_receipts",
    valueColumn: "expiration_json",
    revisionColumn: "expiration_revision",
  },
} as const;

export type AutomatchRoot = keyof typeof AUTOMATCH_RECORD_TABLES;
export type AutomatchRecordSnapshot = {
  root: AutomatchRoot;
  key: string;
  value: unknown;
  revision: number;
};

export type AutomatchRecordMutation = {
  current: AutomatchRecordSnapshot;
  value: unknown;
};

export type AutomatchRuntimeControl = {
  backend: typeof RETIRED_STATE_BACKEND | "d1";
  state: "active" | "frozen";
  epoch: number;
  freezeGeneration: number;
  stagedAtMs: number | null;
  candidateVersionId: string | null;
  importedAtMs: number | null;
  sourceDigest: string | null;
  importDigest: string | null;
  activatedAtMs: number | null;
  metadata: unknown;
};

export type AutomatchWriteAdmission = {
  admissionId: string;
  backend: typeof RETIRED_STATE_BACKEND | "d1";
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
  metadata_json: string | null;
};

export type AdmissionRow = {
  admission_id: string;
  backend: typeof RETIRED_STATE_BACKEND | "d1";
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

export type AutomatchD1StoreOptions = {
  now?: () => number;
  writeGuards?: () => readonly D1PreparedStatement[];
};
