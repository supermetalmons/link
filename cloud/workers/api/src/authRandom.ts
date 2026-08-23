const ALPHANUMERIC_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const MAX_UNBIASED_BYTE =
  Math.floor(256 / ALPHANUMERIC_ALPHABET.length) * ALPHANUMERIC_ALPHABET.length;

export function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function secureAlphanumericId(
  length = 20,
  randomBytes: (length: number) => Uint8Array = secureRandomBytes,
): string {
  let result = "";
  while (result.length < length) {
    for (const byte of randomBytes(32)) {
      if (byte < MAX_UNBIASED_BYTE) {
        result += ALPHANUMERIC_ALPHABET[byte % ALPHANUMERIC_ALPHABET.length];
        if (result.length === length) {
          break;
        }
      }
    }
  }
  return result;
}
