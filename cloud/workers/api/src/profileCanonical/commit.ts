import { CANONICAL_PROFILE_TOPOLOGY_VIOLATION_PREDICATE } from "../profileTopologySql.ts";
import { ProfileWritesDisabledFailure } from "../authErrors.ts";
import { classifyD1Failure } from "../d1Failure.ts";
import {
  type CanonicalMutation,
  type CanonicalCommitPlan,
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
} from "./types.ts";
import { guardStatement, buildCanonicalGuardStatements } from "./guards.ts";
import {
  canonicalTopologyProfileIds,
  validateCanonicalCommitPlan,
} from "./commitPlan.ts";
import { buildProfileMutationStatements } from "./profileStatements.ts";
import { buildAuthMutationStatements } from "./authStatements.ts";
import { buildAccountingMutationStatements } from "./accountingStatements.ts";

function mutationStatements(
  db: D1Database,
  mutation: CanonicalMutation,
): D1PreparedStatement[] {
  switch (mutation.kind) {
    case "insert-active-profile":
    case "update-active-profile":
    case "patch-active-profile":
    case "retire-profile-with-redirect":
    case "delete-retired-profile":
    case "insert-login-owner":
    case "update-login-owner":
    case "move-login-owner-set":
    case "delete-login-owner":
      return buildProfileMutationStatements(db, mutation);
    case "insert-auth-method":
    case "update-auth-method":
    case "delete-auth-method":
    case "insert-auth-operation":
    case "update-auth-operation":
    case "delete-auth-operation":
    case "insert-method-revocation":
    case "update-method-revocation":
    case "delete-method-revocation":
    case "insert-method-cooldown":
    case "update-method-cooldown":
    case "delete-method-cooldown":
    case "insert-auth-recovery":
    case "update-auth-recovery":
    case "delete-auth-recovery":
      return buildAuthMutationStatements(db, mutation);
    case "insert-february-opponent":
    case "delete-february-opponent":
    case "insert-rating-update":
    case "update-rating-update":
    case "update-rating-projection":
    case "delete-rating-update":
    case "insert-wager-settlement":
      return buildAccountingMutationStatements(db, mutation);
    default: {
      const unsupported: never = mutation;
      throw new TypeError("unsafe-canonical-commit-plan", {
        cause: unsupported,
      });
    }
  }
}

function canonicalTopologyGuardStatement(
  db: D1Database,
  plan: CanonicalCommitPlan,
): D1PreparedStatement {
  return guardStatement(
    db,
    CANONICAL_PROFILE_TOPOLOGY_VIOLATION_PREDICATE,
    [JSON.stringify(canonicalTopologyProfileIds(plan))],
    "invariant",
  );
}

export async function commitCanonicalPlan(
  db: D1Database,
  plan: CanonicalCommitPlan,
  { maxStatements }: { maxStatements?: number } = {},
): Promise<void> {
  validateCanonicalCommitPlan(plan);
  if (
    maxStatements !== undefined &&
    (!Number.isSafeInteger(maxStatements) || maxStatements < 0)
  ) {
    throw new TypeError("invalid-canonical-commit-budget");
  }
  if (plan.mutations.length === 0) return;
  const statements = [
    guardStatement(
      db,
      `NOT EXISTS (
         SELECT 1 FROM profile_canonical_control
         WHERE singleton = 1 AND state = 'active'
       )`,
      [],
      "invariant",
    ),
    ...buildCanonicalGuardStatements(db, plan.expectations),
    ...plan.mutations.flatMap((mutation) => mutationStatements(db, mutation)),
    canonicalTopologyGuardStatement(db, plan),
  ];
  if (maxStatements !== undefined && statements.length > maxStatements) {
    throw new CanonicalProfileCorruption();
  }
  try {
    await db.batch(statements);
  } catch (error) {
    const failure = classifyD1Failure(error);
    if (failure === "profile-conflict" || failure === "username-conflict") {
      throw new CanonicalProfileConflict({ cause: error });
    }
    if (failure === "guard") {
      let control: { state: string } | null;
      try {
        control = await db
          .withSession("first-primary")
          .prepare(
            "SELECT state FROM profile_canonical_control WHERE singleton = 1",
          )
          .first<{ state: string }>();
      } catch {
        throw new Error("canonical-profile-unavailable", { cause: error });
      }
      if (control?.state === "frozen") {
        throw new ProfileWritesDisabledFailure({ cause: error });
      }
      throw new CanonicalProfileCorruption({ cause: error });
    }
    if (failure !== "unknown") {
      throw new CanonicalProfileCorruption({ cause: error });
    }
    throw error;
  }
}
