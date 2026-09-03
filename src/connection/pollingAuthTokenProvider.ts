import type { AuthTokenProvider } from "../services/authApi";

type BoundAuthTokenProvider = AuthTokenProvider & {
  readonly assertCurrentUser: () => void;
};

type PollingAuthTokenProviderDependencies = {
  ensureAuthenticated: () => Promise<void>;
  getUserBoundProvider: () => BoundAuthTokenProvider;
  isSessionCurrent: () => boolean;
  signal?: AbortSignal;
};

export function createPollingAuthTokenProvider({
  ensureAuthenticated,
  getUserBoundProvider,
  isSessionCurrent,
  signal,
}: PollingAuthTokenProviderDependencies): BoundAuthTokenProvider {
  let boundProvider: BoundAuthTokenProvider | null = null;
  const assertCurrentUser = () => {
    if (!isSessionCurrent() || signal?.aborted || !boundProvider) {
      throw new Error("authentication-changed");
    }
    boundProvider.assertCurrentUser();
  };
  return Object.assign(
    async (forceRefresh: boolean) => {
      if (!isSessionCurrent() || signal?.aborted) {
        throw new Error("authentication-changed");
      }
      if (!boundProvider) {
        await ensureAuthenticated();
        if (!isSessionCurrent() || signal?.aborted) {
          throw new Error("authentication-changed");
        }
        boundProvider = getUserBoundProvider();
      }
      return boundProvider(forceRefresh);
    },
    { assertCurrentUser },
  );
}
