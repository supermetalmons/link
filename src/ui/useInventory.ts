import { useEffect, useState } from "react";
import type { AuthState } from "../connection/authModels";
import {
  fetchNftsForIdentity,
  getNftIdentityKey,
} from "../services/nftService";
import { storage } from "../utils/storage";
import type { SwagAvatarItem } from "./inventoryItems";

type InventoryState =
  | { status: "loading" | "error" }
  | {
      status: "loaded";
      snapshot: {
        avatars: SwagAvatarItem[];
        specials: SwagAvatarItem[];
        ownerKey: string | null;
        expiresAtMs: number;
      };
    };

export const useInventory = (authState: AuthState) => {
  const isAuthenticated = authState.authStatus === "authenticated";
  const ownerKey = isAuthenticated ? getNftIdentityKey(authState) : null;
  const [state, setState] = useState<InventoryState>({ status: "loading" });
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let isCancelled = false;
    const fetchInventory = async () => {
      setState({ status: "loading" });
      try {
        let snapshot = await fetchNftsForIdentity(authState);
        if (isCancelled) {
          return;
        }
        let isSnapshotFresh = snapshot.expiresAtMs > Date.now();
        if (
          snapshot.data.ok === true &&
          snapshot.expiresAtMs > 0 &&
          !isSnapshotFresh
        ) {
          snapshot = await fetchNftsForIdentity(authState);
          if (isCancelled) {
            return;
          }
          isSnapshotFresh = snapshot.expiresAtMs > Date.now();
        }
        if (isSnapshotFresh && snapshot.data.ok) {
          setState({
            status: "loaded",
            snapshot: {
              avatars: snapshot.data.swagpack_avatars,
              specials: snapshot.data.specials,
              ownerKey,
              expiresAtMs: snapshot.expiresAtMs,
            },
          });
        } else {
          setState({ status: "error" });
        }
      } catch {
        if (!isCancelled) {
          setState({ status: "error" });
        }
      }
    };
    void fetchInventory();
    return () => {
      isCancelled = true;
    };
  }, [authState, ownerKey, refreshVersion]);

  const canApplyInventoryItem = (): boolean => {
    if (
      !isAuthenticated ||
      !ownerKey ||
      state.status !== "loaded" ||
      state.snapshot.ownerKey !== ownerKey ||
      getNftIdentityKey(storage.getAuthIdentity()) !== ownerKey
    ) {
      return false;
    }
    if (state.snapshot.expiresAtMs <= Date.now()) {
      setRefreshVersion((current) => current + 1);
      return false;
    }
    return true;
  };

  return {
    avatars: state.status === "loaded" ? state.snapshot.avatars : [],
    specials: state.status === "loaded" ? state.snapshot.specials : [],
    isLoading: state.status === "loading",
    dataOk: state.status === "loading" ? null : state.status === "loaded",
    canApplyInventoryItem,
  };
};
