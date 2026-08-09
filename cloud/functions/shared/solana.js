"use strict";

const bs58 = require("bs58");

const isValidSolanaAddress = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return false;
  }
  try {
    return bs58.default.decode(value).byteLength === 32;
  } catch {
    return false;
  }
};

module.exports = {
  isValidSolanaAddress,
};
