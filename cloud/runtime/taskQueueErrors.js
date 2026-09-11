"use strict";

const normalizeTaskQueueErrorCode = (error) => {
  const raw =
    typeof error?.code === "string" || typeof error?.code === "number"
      ? error.code
      : error?.status;
  return typeof raw === "string" || typeof raw === "number"
    ? String(raw).trim().toLowerCase()
    : "";
};

const stripFunctionsErrorCodePrefix = (code) =>
  code.startsWith("functions/") ? code.slice("functions/".length) : code;

const isTaskAlreadyExistsError = (error) => {
  const code = stripFunctionsErrorCodePrefix(
    normalizeTaskQueueErrorCode(error),
  );
  if (
    code === "task-already-exists" ||
    code === "already-exists" ||
    code === "already_exists" ||
    code === "6"
  ) {
    return true;
  }
  const message =
    typeof error?.message === "string" ? error.message.toLowerCase() : "";
  return message.includes("task") && message.includes("already exists");
};

module.exports = {
  isTaskAlreadyExistsError,
  normalizeTaskQueueErrorCode,
};
