import type { ProfileCustomizationUpdateRequest } from "@mons/shared/profiles";
import {
  authFieldFilter,
  authUpdateWrite,
  createAuthFirestoreClient,
  type AuthFirestoreClient,
} from "./authFirestore.ts";

export type ProfileCustomizationProfile = {
  documentName: string;
  eth: string;
  sol: string;
};

export type ProfileCustomizationUpdateOutcome =
  "updated" | "profile-not-found" | "login-profile-conflict";

export type ProfileCustomizationRepository = {
  updateCustomization: (
    uid: string,
    request: ProfileCustomizationUpdateRequest,
    authorize: (profile: ProfileCustomizationProfile) => Promise<void>,
  ) => Promise<ProfileCustomizationUpdateOutcome>;
};

function profileFromDocument(
  document: Awaited<ReturnType<AuthFirestoreClient["query"]>>[number],
): ProfileCustomizationProfile {
  return {
    documentName: document.name,
    eth: typeof document.fields.eth === "string" ? document.fields.eth : "",
    sol: typeof document.fields.sol === "string" ? document.fields.sol : "",
  };
}

function customizationWrite(
  documentName: string,
  request: ProfileCustomizationUpdateRequest,
) {
  if (request.field === "emojiAndAura") {
    return authUpdateWrite(
      documentName,
      {
        custom: {
          emoji: request.value.emoji,
          aura: request.value.aura,
        },
      },
      ["custom.emoji", "custom.aura"],
    );
  }
  return authUpdateWrite(
    documentName,
    { custom: { [request.field]: request.value } },
    [`custom.${request.field}`],
  );
}

export function createProfileCustomizationRepository(
  env: Env,
  dependencies: {
    firestore?: AuthFirestoreClient;
    signal?: AbortSignal;
  } = {},
): ProfileCustomizationRepository {
  const firestore =
    dependencies.firestore ||
    createAuthFirestoreClient(env, { signal: dependencies.signal });
  return {
    async updateCustomization(uid, request, authorize) {
      return firestore.runTransaction(async (transaction) => {
        const profiles = await transaction.query(
          "users",
          authFieldFilter("logins", "ARRAY_CONTAINS", uid),
          2,
          ["logins", "sol", "eth", "mergedIntoProfileId"],
        );
        if (profiles.length === 0) {
          return { result: "profile-not-found" as const, writes: [] };
        }
        if (
          profiles.length > 1 ||
          (typeof profiles[0].fields.mergedIntoProfileId === "string" &&
            profiles[0].fields.mergedIntoProfileId.trim())
        ) {
          return { result: "login-profile-conflict" as const, writes: [] };
        }
        const profile = profileFromDocument(profiles[0]);
        await authorize(profile);
        return {
          result: "updated" as const,
          writes: [customizationWrite(profile.documentName, request)],
        };
      });
    },
  };
}

export { customizationWrite, profileFromDocument };
