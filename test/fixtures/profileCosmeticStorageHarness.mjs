import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * @typedef {typeof import("../../src/utils/profileCosmeticStorage.ts").createProfileCosmeticWrites} CreateProfileCosmeticWrites
 * @typedef {Pick<typeof import("../../src/utils/storage.ts").storage,
 *   "setCardBackgroundId" | "setCardStickers" | "setCardSubtitleId"
 *   | "setProfileCounter" | "setProfileMons">} CosmeticStorage
 * @typedef {(storage: CosmeticStorage, localStorage: Pick<Storage, "getItem">,
 *   toStorageKey: (key: string) => string) => CreateProfileCosmeticWrites} BindProfileCosmeticStorage
 */

const path = new URL(
  "../../src/utils/profileCosmeticStorage.ts",
  import.meta.url,
);
const source = ts.createSourceFile(
  path.pathname,
  readFileSync(path, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === "createProfileCosmeticWrites",
);
assert.ok(declaration);
const { outputText } = ts.transpileModule(
  declaration.getText(source).replace(/^export /, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);

const bind = /** @type {BindProfileCosmeticStorage} */ (
  new Function(
    "storage",
    "localStorage",
    "applicationStorageKey",
    `${outputText}\nreturn createProfileCosmeticWrites;`,
  )
);

/**
 * @param {CosmeticStorage} storage
 * @param {Pick<Storage, "getItem">} localStorage
 * @param {(key: string) => string} [toStorageKey]
 * @returns {CreateProfileCosmeticWrites}
 */
export const bindProfileCosmeticStorage = (
  storage,
  localStorage,
  toStorageKey = (key) => key,
) => bind(storage, localStorage, toStorageKey);
