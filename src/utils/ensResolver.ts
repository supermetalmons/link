type ENSCache = {
  [address: string]: string | null;
};

let ensCache: ENSCache = {};
let cacheGeneration = 0;

export type EnsProfile = { name: string; avatar?: string | null };

export const decodeEnsName = (value: unknown): string | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : null;
};

export const decodeEnsProfile = (value: unknown): EnsProfile | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const fields = value as { name?: unknown; avatar?: unknown };
  if (!fields.name) {
    return null;
  }
  const eligibleName = fields.name;
  if (typeof eligibleName !== "string" || eligibleName.trim() === "") {
    return null;
  }
  const name = fields.name;
  if (typeof name !== "string") {
    return null;
  }
  const avatar = fields.avatar;
  return {
    name,
    avatar: typeof avatar === "string" || avatar === null ? avatar : undefined,
  };
};

export async function resolveENS(address: string): Promise<string | null> {
  const requestGeneration = cacheGeneration;
  if (address in ensCache) {
    return ensCache[address];
  }

  try {
    const response = await fetch(
      `https://api.ensideas.com/ens/resolve/${address}`,
    );
    if (!response.ok) {
      if (requestGeneration === cacheGeneration) {
        ensCache[address] = null;
      }
      return null;
    }

    const data: unknown = await response.json();
    const name = decodeEnsName(data);
    if (requestGeneration === cacheGeneration) {
      ensCache[address] = name;
    }
    return name;
  } catch (error) {
    console.error("Failed to resolve ENS:", error);
    if (requestGeneration === cacheGeneration) {
      ensCache[address] = null;
    }
    return null;
  }
}

export function resetEnsCache() {
  cacheGeneration += 1;
  ensCache = {};
}
