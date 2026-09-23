import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { connection } from "../../connection/connection";
import type { EthereumWalletChoice } from "../EthereumWalletPicker";
import {
  createWalletAuthFlowController,
  type WalletAuthFlowOptions,
} from "./walletAuthFlowController";

type WalletProof =
  | { method: "sol"; publicKey: string; signature: string; intentId: string }
  | { method: "eth"; message: string; signature: string; intentId: string };

export const useWalletAuthFlow = ({
  method,
  requestWalletSelection,
  notFoundDurationMs,
  ...options
}: WalletAuthFlowOptions & {
  method: "sol" | "eth";
  requestWalletSelection: () => Promise<EthereumWalletChoice>;
  notFoundDurationMs: number;
}) => {
  const controller = useMemo(
    () =>
      createWalletAuthFlowController<WalletProof>({
        notFoundDurationMs,
        dependencies: {
          connect: async () => {
            if (method === "sol") {
              const { connectToSolana } =
                await import("../../connection/solanaConnection");
              return { method, ...(await connectToSolana()) };
            }
            const choice = await requestWalletSelection();
            if (choice.status === "cancelled") return null;
            const { connectToEthereumAndSign } =
              await import("../../connection/ethereumConnection");
            return {
              method,
              ...(await connectToEthereumAndSign(choice.wallet)),
            };
          },
          verify: (proof) =>
            proof.method === "sol"
              ? connection.verifySolanaAddress(
                  proof.publicKey,
                  proof.signature,
                  proof.intentId,
                )
              : connection.verifyEthAddress(
                  proof.message,
                  proof.signature,
                  proof.intentId,
                ),
        },
      }),
    [method, notFoundDurationMs, requestWalletSelection],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useLayoutEffect(() => {
    controller.attach();
    return controller.detach;
  }, [controller]);
  useLayoutEffect(() => controller.setOptions(options));

  return {
    state,
    isBusy: state === "connecting" || state === "verifying",
    start: controller.start,
    invalidateAction: controller.invalidateAction,
  };
};
