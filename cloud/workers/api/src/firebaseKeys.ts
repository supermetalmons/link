export const MAX_FIREBASE_KEY_BYTES = 768;

const INVALID_FIREBASE_KEY_CHARACTERS = ".#$[]/";

export function isSafeFirebaseKey(value: string): boolean {
  const hasInvalidCharacter = Array.from(value).some((character) => {
    const code = character.codePointAt(0) || 0;
    return (
      code <= 0x1f ||
      code === 0x7f ||
      INVALID_FIREBASE_KEY_CHARACTERS.includes(character)
    );
  });
  const bytes = new TextEncoder().encode(value);
  return (
    bytes.byteLength > 0 &&
    bytes.byteLength <= MAX_FIREBASE_KEY_BYTES &&
    !hasInvalidCharacter
  );
}
