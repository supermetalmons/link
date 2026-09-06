import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("delayed profile hydration updates metadata without publishing stale match cosmetics", async () => {
  const path = new URL("../src/utils/playerMetadata.ts", import.meta.url);
  const source = ts.createSourceFile(
    path.pathname,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "updatePlayerMetadataWithProfile",
  );
  assert.ok(declaration);
  let finishProfile;
  const profileRead = new Promise((resolve) => (finishProfile = resolve));
  const mutations = [];
  const displays = [];
  let completions = 0;
  const profiles = {};
  const dependencies = {
    createPlayerMetadataSessionGuard: () => () => true,
    usernamesForUids: {},
    ethAddressesForUids: {},
    solAddressesForUids: {},
    ensForUids: {},
    profilesForUids: profiles,
    getPlayerProfileByLoginId: () => profileRead,
    syncPlayerMiningState: () => {},
    syncPlayerTutorialProgress: () => {},
    isPlayerMetadataWatchOnly: () => false,
    updatePlayerProfileDisplayName: () => {},
    updatePlayerEmojiAndAura: (...args) => displays.push(args),
    updatePlayerEmoji: (...args) => mutations.push(args),
    normalizeProfileEmojiId: Number,
    storage: new Proxy(
      {},
      {
        get: (_target, key) =>
          String(key).startsWith("get") ? () => "" : () => {},
      },
    ),
  };
  const { outputText } = ts.transpileModule(
    declaration.getText(source).replace(/^export /, ""),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  const hydrate = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn updatePlayerMetadataWithProfile;`,
  )(...Object.values(dependencies));
  hydrate({ username: "Player" }, "actor", true, () => completions++);
  assert.equal(completions, 0);
  const fetched = {
    username: "Player",
    emoji: "1",
    aura: "",
    rating: 1500,
    nonce: 1,
  };
  finishProfile(fetched);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completions, 1);
  assert.deepEqual(profiles.actor, fetched);
  assert.deepEqual(displays, [["1", "", false]]);
  assert.deepEqual(mutations, []);
});
