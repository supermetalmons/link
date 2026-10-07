import {
  acquireEventWriteAdmission,
  releaseEventWriteAdmission,
} from "./eventD1/coordination.ts";
import {
  EventWritesDisabled,
  type EventD1Connection,
  type EventWriteAdmission,
} from "./eventD1/types.ts";

type MutationAdmissionPolicy = {
  kind: "mutation";
  context:
    "event-path-transaction" | "event-root-patch" | "transition-recovery";
};

type DispatchAdmissionPolicy = { kind: "dispatch" };
type MatchEffectAdmissionPolicy = { kind: "match-effect" };

export function withEventWriteAdmission(
  db: EventD1Connection,
  policy: DispatchAdmissionPolicy,
  work: (admission: EventWriteAdmission) => Promise<void>,
): Promise<void>;
export function withEventWriteAdmission<T>(
  db: EventD1Connection,
  policy: MutationAdmissionPolicy | MatchEffectAdmissionPolicy,
  work: (admission: EventWriteAdmission) => Promise<T>,
): Promise<T>;
export async function withEventWriteAdmission<T>(
  db: EventD1Connection,
  policy:
    | MutationAdmissionPolicy
    | DispatchAdmissionPolicy
    | MatchEffectAdmissionPolicy,
  work: (admission: EventWriteAdmission) => Promise<T>,
): Promise<T | void> {
  let admission: EventWriteAdmission;
  try {
    admission = await acquireEventWriteAdmission(db);
  } catch (error) {
    if (policy.kind === "dispatch" && error instanceof EventWritesDisabled)
      return;
    throw error;
  }
  let result: T;
  let released = false;
  try {
    result = await work(admission);
  } finally {
    if (policy.kind === "match-effect") {
      released = await releaseEventWriteAdmission(db, admission);
    } else {
      let failureKind: string | null = null;
      try {
        if (!(await releaseEventWriteAdmission(db, admission))) {
          failureKind = policy.kind === "mutation" ? "missing" : "unconfirmed";
        }
      } catch (error) {
        failureKind = error instanceof Error ? error.name : typeof error;
      }
      if (failureKind !== null && (policy.kind === "mutation" || failureKind)) {
        console.error(
          JSON.stringify(
            policy.kind === "mutation"
              ? {
                  event: "event_write_admission_release_failed",
                  admissionId: admission.admissionId,
                  freezeGeneration: admission.freezeGeneration,
                  attempts: 1,
                  context: policy.context,
                  kind: failureKind,
                }
              : {
                  event: "event_progress_dispatch_admission_release_failed",
                  kind: failureKind,
                },
          ),
        );
      }
    }
  }
  if (policy.kind === "match-effect" && !released)
    throw new Error("match-event-admission-release-unconfirmed");
  return result;
}
