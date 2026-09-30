// Generated from src/batchRead.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.batchReadWithRetry = void 0;
const batchReadWithRetry = async (readers) => {
  const initial = await Promise.allSettled(readers.map((read) => read()));
  return Promise.all(
    initial.map((result, index) => {
      if (result.status === "rejected") {
        console.error("Error in initial batch read:", result.reason);
        return readers[index]();
      }
      return result.value;
    }),
  );
};
exports.batchReadWithRetry = batchReadWithRetry;
