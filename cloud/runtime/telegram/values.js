// Generated from src/telegram/values.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readProperty = readProperty;
exports.isRecord = isRecord;
function readProperty(value, key) {
  return value == null ? undefined : value[key];
}
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
