const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { VALID_REACTION_IDS } = require("@mons/shared/nfts");
const { HELIUS_RPC_API_KEY, getHeliusRpcUrl } = require("./heliusRpc");
const { readProfileByLoginUid } = require("./profileLookup");

exports.getNfts = onCall({ secrets: [HELIUS_RPC_API_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  const profileDocument = await readProfileByLoginUid(request.auth.uid, [
    "sol",
    "eth",
  ]);
  if (!profileDocument) {
    throw new HttpsError("not-found", "profile-not-found");
  }
  const profile = profileDocument.data() || {};
  const sol = profile.sol ?? "";
  const eth = profile.eth ?? "";
  if (!sol && !eth) {
    return {
      ok: true,
      specials: [],
      swagpack_avatars: [],
      swagpack_reactions: [],
    };
  }

  try {
    async function fetchCollectionIdCounts(
      ownerAddress,
      collectionId,
      heliusRpcUrl,
    ) {
      const idCounts = new Map();
      if (!ownerAddress) return [];
      let cursor = undefined;
      const limit = 1000;
      let fetched = 0;
      let total = Infinity;
      while (fetched < total) {
        const params = {
          ownerAddress,
          grouping: ["collection", collectionId],
          limit,
        };
        if (cursor) {
          params.cursor = cursor;
        }
        const solResponse = await fetch(heliusRpcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "mons-get-nfts",
            method: "searchAssets",
            params,
          }),
        });
        const solData = await solResponse.json();
        if (!solResponse.ok || solData?.error) {
          throw new Error("Helius searchAssets request failed.");
        }
        const resultNode = solData?.result;
        if (
          !resultNode ||
          typeof resultNode !== "object" ||
          !Array.isArray(resultNode.items)
        ) {
          throw new Error("Helius searchAssets response was malformed.");
        }
        const items = resultNode.items;
        total = typeof resultNode.total === "number" ? resultNode.total : total;
        for (const item of items) {
          const jsonUri = item?.content?.json_uri || "";
          if (typeof jsonUri !== "string" || jsonUri.length === 0) continue;
          try {
            const lastSlash = jsonUri.lastIndexOf("/");
            let tail = lastSlash >= 0 ? jsonUri.slice(lastSlash + 1) : jsonUri;
            const q = tail.indexOf("?");
            if (q >= 0) tail = tail.slice(0, q);
            const h = tail.indexOf("#");
            if (h >= 0) tail = tail.slice(0, h);
            const idNum = parseInt(tail, 10);
            if (!Number.isFinite(idNum)) continue;
            if (!idCounts.has(idNum)) idCounts.set(idNum, 0);
            idCounts.set(idNum, idCounts.get(idNum) + 1);
          } catch {}
        }
        fetched += items.length;
        if (!items.length || fetched >= total || items.length < limit) break;
        cursor = resultNode.cursor;
        if (!cursor) break;
      }
      return Array.from(idCounts.entries()).map(([id, count]) => ({
        id,
        count,
      }));
    }

    let swagpack_avatars = [];
    let swagpack_reactions = [];
    let specials = [];

    if (sol) {
      const heliusRpcUrl = getHeliusRpcUrl();
      if (!heliusRpcUrl) {
        throw new Error("Helius RPC is not configured.");
      }
      const primaryCollectionId =
        "C22esis7kQMbX9JGWsMaKvsh1X5GeBmHPju28jiKDyAP";
      const specialsCollectionId =
        "GCcbUaghGawyM76BhJHsHUXb9kq7H3AZhPL7S3p9WajP";
      const avatarsPromise = fetchCollectionIdCounts(
        sol,
        primaryCollectionId,
        heliusRpcUrl,
      );
      const specialsPromise = fetchCollectionIdCounts(
        sol,
        specialsCollectionId,
        heliusRpcUrl,
      );
      const [avatars, specialIds] = await Promise.all([
        avatarsPromise,
        specialsPromise,
      ]);
      swagpack_avatars = avatars;
      const reactionSet = new Set(VALID_REACTION_IDS);
      swagpack_reactions = avatars.filter((x) => reactionSet.has(x.id));
      specials = specialIds;
    }

    return { ok: true, specials, swagpack_avatars, swagpack_reactions };
  } catch (error) {
    console.error("Error fetching NFTs:", error);
    throw new HttpsError("unavailable", "nft-provider-unavailable");
  }
});
