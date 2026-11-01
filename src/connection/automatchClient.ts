import type {
  CancelAutomatchResponse,
  StartAutomatchRequest,
  StartAutomatchResponse,
} from "@mons/shared/navigation";
import type { AuthTokenProvider } from "../services/apiTransport";
import type { SessionUser } from "../session/sessionAuth";
import type { PendingAutomatchOperation } from "../utils/storage";

export type AutomatchClientApi = Pick<
  typeof import("../services/gameplayApi"),
  "startAutomatchViaApi" | "cancelAutomatchViaApi"
>;

export type AutomatchClientDependencies = {
  ensureAuthenticated: () => Promise<void>;
  getCurrentUser: () => SessionUser | null;
  getUserBoundAuthTokenProvider: (uid: string) => AuthTokenProvider & {
    readonly assertCurrentUser: () => void;
  };
  storage: Pick<
    typeof import("../utils/storage").storage,
    "getPendingAutomatchOperation" | "setPendingAutomatchOperation"
  >;
  getPlayerPresentation: () => StartAutomatchRequest;
  withOperationLock: <T>(uid: string, work: () => Promise<T>) => Promise<T>;
  api: AutomatchClientApi;
  seedGameBootstrap: typeof import("../services/initialGameBootstrap").seedAutomatchGameBootstrap;
  notifyNavigationGamesChanged: () => void;
  now: () => number;
  createOperationId: () => string;
};

const AUTOMATCH_OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export class AutomatchClient {
  private readonly dependencies: AutomatchClientDependencies;

  constructor(dependencies: AutomatchClientDependencies) {
    this.dependencies = dependencies;
  }

  public getPendingOperationId(uid: string): string | undefined {
    return this.dependencies.storage.getPendingAutomatchOperation(uid)
      ?.operationId;
  }

  private clearPendingRequest(uid: string, operationId?: string): void {
    const { storage } = this.dependencies;
    const stored = storage.getPendingAutomatchOperation(uid);
    if (operationId && stored?.operationId !== operationId) return;
    storage.setPendingAutomatchOperation(uid, null);
  }

  private getPendingRequest(uid: string): PendingAutomatchOperation {
    const { storage } = this.dependencies;
    const nowMs = this.dependencies.now();
    const stored = storage.getPendingAutomatchOperation(uid);
    if (
      stored &&
      nowMs >= stored.createdAtMs &&
      nowMs - stored.createdAtMs <= AUTOMATCH_OPERATION_RETENTION_MS
    ) {
      return stored;
    }
    this.clearPendingRequest(uid);
    const operation: PendingAutomatchOperation = {
      createdAtMs: nowMs,
      operationId: this.dependencies.createOperationId(),
      request: this.dependencies.getPlayerPresentation(),
      resolvedInviteId: null,
      uid,
    };
    storage.setPendingAutomatchOperation(uid, operation);
    return operation;
  }

  public reconcilePendingRequest(
    uid: string,
    inviteId: string,
    observedOperationId: string | null,
  ): void {
    void this.dependencies
      .withOperationLock(uid, async () => {
        const pending =
          this.dependencies.storage.getPendingAutomatchOperation(uid);
        if (
          pending &&
          (pending.resolvedInviteId === inviteId ||
            pending.operationId === observedOperationId)
        ) {
          this.clearPendingRequest(uid, pending.operationId);
        }
      })
      .catch((error) => {
        console.error("Failed to clear completed automatch operation", error);
      });
  }

  public async automatch(): Promise<StartAutomatchResponse> {
    try {
      await this.dependencies.ensureAuthenticated();
      const user = this.dependencies.getCurrentUser();
      if (!user) {
        throw new Error("Failed to authenticate user");
      }
      return await this.dependencies.withOperationLock(user.uid, async () => {
        const tokenProvider = this.dependencies.getUserBoundAuthTokenProvider(
          user.uid,
        );
        const pendingRequest = this.getPendingRequest(user.uid);
        const response = await this.dependencies.api.startAutomatchViaApi(
          pendingRequest.request,
          tokenProvider,
          pendingRequest.operationId,
        );
        tokenProvider.assertCurrentUser();
        if (!response.ok) {
          this.clearPendingRequest(user.uid, pendingRequest.operationId);
        } else {
          this.dependencies.storage.setPendingAutomatchOperation(user.uid, {
            ...pendingRequest,
            resolvedInviteId: response.inviteId,
          });
        }
        if (response.ok && response.mode === "matched" && response.bootstrap) {
          this.dependencies.seedGameBootstrap({
            inviteId: response.inviteId,
            operationId: pendingRequest.operationId,
            user,
            bootstrap: response.bootstrap,
          });
        }
        this.dependencies.notifyNavigationGamesChanged();
        if (response.ok && response.mode === "matched") {
          const { bootstrap: _bootstrap, ...result } = response;
          return result;
        }
        return response;
      });
    } catch (error) {
      console.error("Error calling automatch:", error);
      throw error;
    }
  }

  public async cancelAutomatch(): Promise<CancelAutomatchResponse> {
    try {
      await this.dependencies.ensureAuthenticated();
      const user = this.dependencies.getCurrentUser();
      if (!user) {
        throw new Error("Failed to authenticate user");
      }
      return await this.dependencies.withOperationLock(user.uid, async () => {
        const pending = this.dependencies.storage.getPendingAutomatchOperation(
          user.uid,
        );
        const operationId = pending?.operationId ?? null;
        const tokenProvider = this.dependencies.getUserBoundAuthTokenProvider(
          user.uid,
        );
        const response =
          await this.dependencies.api.cancelAutomatchViaApi(tokenProvider);
        tokenProvider.assertCurrentUser();
        if (response.ok && operationId) {
          this.clearPendingRequest(user.uid, operationId);
        }
        this.dependencies.notifyNavigationGamesChanged();
        return response;
      });
    } catch (error) {
      console.error("Error canceling automatch:", error);
      throw error;
    }
  }
}
