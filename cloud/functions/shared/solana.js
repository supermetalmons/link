"use strict";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const getBase58DecodedLength = (value) => {
  const bytes = [0];
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return 0;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (
    let index = 0;
    value[index] === "1" && index < value.length - 1;
    index += 1
  ) {
    bytes.push(0);
  }
  return bytes.length;
};

const isValidSolanaAddress = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return false;
  }
  return getBase58DecodedLength(value) === 32;
};

module.exports = {
  isValidSolanaAddress,
};
