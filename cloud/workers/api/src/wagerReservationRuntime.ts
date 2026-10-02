import {
  WAGER_STORAGE_VERSION,
  WAGER_STORAGE_VERSION_HEADER,
} from "@mons/shared/wagers";
import type { GameplayRepository } from "./gameplayRepository.ts";
import { assertProfileMutationAllowed } from "./profileCanonicalActivation.ts";
import {
  createWagerFrozenD1Store,
  readWagerReservationBalance,
} from "./wagerFrozenD1.ts";
import { createWagerStateRepository } from "./wagerStateRepository.ts";
import { notifyInviteRooms } from "./inviteRoomNotifications.ts";
import type { WagerFrozenBalance } from "./wagerFrozenStore.ts";
import {
  acquireWagerReservationAdmission,
  assertWagerReservationAdmission,
  readWagerReservationControl,
  releaseWagerReservationAdmission,
  wagerReservationAdmissionGuards,
  type WagerReservationAdmission,
} from "./wagerReservationControl.ts";

export class WagerClientUpdateRequired extends Error {
  constructor() {
    super("Reload this page to continue wagering.");
  }
}

export type WagerReservationRuntime = {
  assertClientVersion: (request: Request) => Promise<void>;
  readBalance: (playerUid: string) => Promise<WagerFrozenBalance>;
  run: <T>(
    kind: string,
    work: (
      repository: GameplayRepository,
      assertMutationAllowed: () => Promise<void>,
    ) => Promise<T>,
  ) => Promise<T>;
};

export function createWagerReservationRuntime(
  env: Env,
  repository: GameplayRepository,
  { now = Date.now, logFailure = console.error } = {},
): WagerReservationRuntime {
  const db = env.PROFILE_DB;
  const readControl = () => readWagerReservationControl(db);
  const assertAdmission = async (admission: WagerReservationAdmission) => {
    await assertProfileMutationAllowed(env);
    await assertWagerReservationAdmission(db, admission, now());
  };

  return {
    async assertClientVersion(request) {
      if (
        request.headers.get(WAGER_STORAGE_VERSION_HEADER) !==
        WAGER_STORAGE_VERSION
      ) {
        throw new WagerClientUpdateRequired();
      }
      await readControl();
    },
    readBalance: (playerUid) => readWagerReservationBalance(db, playerUid),
    async run(kind, work) {
      const admission = await acquireWagerReservationAdmission(db, kind, now());
      try {
        const writeGuards = () =>
          wagerReservationAdmissionGuards(db, admission, now());
        const store = createWagerFrozenD1Store(db, {
          now,
          writeGuards,
        });
        const wagerState = createWagerStateRepository(db, {
          now,
          writeGuards,
          notify: (inviteId) =>
            notifyInviteRooms(
              env,
              [inviteId],
              "notifyWagersChanged",
              "invite_wagers_notify_failed",
            ),
        });
        await assertAdmission(admission);
        return await work(
          {
            ...repository,
            wagerFrozen: store,
            wagers: wagerState,
            wagerWriter: wagerState,
          },
          () => assertAdmission(admission),
        );
      } finally {
        await releaseWagerReservationAdmission(db, admission).catch(() => {
          logFailure({
            event: "wager_reservation_admission_release_failed",
            admissionId: admission.admissionId,
          });
        });
      }
    },
  };
}
