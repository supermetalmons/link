"use strict";

const { defineSecret } = require("firebase-functions/params");

const HELIUS_RPC_API_KEY = defineSecret("HELIUS_RPC_API_KEY");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const buildHeliusRpcUrl = (apiKey) => {
  const normalizedApiKey = normalizeString(apiKey);
  return normalizedApiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(normalizedApiKey)}`
    : "";
};

const getHeliusRpcUrl = () => buildHeliusRpcUrl(HELIUS_RPC_API_KEY.value());

module.exports = {
  HELIUS_RPC_API_KEY,
  buildHeliusRpcUrl,
  getHeliusRpcUrl,
};
