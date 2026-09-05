import type { WagerReservationRuntime } from "../src/wagerReservationRuntime.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { createWagerFrozenFirebaseStore } from "./wagerFrozenFirebaseFixture.ts";

export function attachFirebaseWagerFrozenStore<T extends GameplayRepository>(
  repository: T,
): T {
  repository.wagerFrozen ??= createWagerFrozenFirebaseStore({
    getPath: (...args) => repository.getRtdbPath(...args),
    transactPath: (...args) => repository.transactRtdbPath(...args),
  });
  return repository;
}

export function createTestWagerReservationRuntime(
  repository: GameplayRepository,
): WagerReservationRuntime {
  const admitted = attachFirebaseWagerFrozenStore(repository);
  return {
    assertClientVersion: async () => undefined,
    readBalance: (playerUid) => admitted.wagerFrozen!.readBalance(playerUid),
    run: (_kind, work) => work(admitted, async () => undefined),
  };
}
