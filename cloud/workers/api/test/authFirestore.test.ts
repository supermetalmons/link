import assert from "node:assert/strict";
import test from "node:test";
import {
  authDocumentName,
  authUpdateWrite,
  createAuthFirestoreClient,
  encodeFields,
} from "../src/authFirestore.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = TELEGRAM_TEST_ENV as Env;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("encodes nested Firestore values and deletion masks without assertions", () => {
  assert.deepEqual(
    encodeFields({
      text: "value",
      count: 3,
      ratio: 1.5,
      active: true,
      empty: null,
      list: ["a", 2],
      map: { nested: "yes" },
    }),
    {
      text: { stringValue: "value" },
      count: { integerValue: "3" },
      ratio: { doubleValue: 1.5 },
      active: { booleanValue: true },
      empty: { nullValue: null },
      list: {
        arrayValue: {
          values: [{ stringValue: "a" }, { integerValue: "2" }],
        },
      },
      map: {
        mapValue: { fields: { nested: { stringValue: "yes" } } },
      },
    },
  );
  assert.deepEqual(
    authUpdateWrite(
      authDocumentName("users", "profile-1"),
      { username: "Mons" },
      ["username", "eth"],
      true,
    ),
    {
      update: {
        name: authDocumentName("users", "profile-1"),
        fields: { username: { stringValue: "Mons" } },
      },
      updateMask: { fieldPaths: ["username", "eth"] },
      currentDocument: { exists: true },
    },
  );
  assert.deepEqual(
    encodeFields({
      custom: { __firestoreInteger: "123", aura: "rainbow" },
    }),
    {
      custom: {
        mapValue: {
          fields: {
            __firestoreInteger: { stringValue: "123" },
            aura: { stringValue: "rainbow" },
          },
        },
      },
    },
  );
});

test("retries Firestore transaction conflicts with the prior transaction", async () => {
  const calls: Array<{ input: string; body: Record<string, unknown> }> = [];
  let begins = 0;
  let commits = 0;
  const client = createAuthFirestoreClient(env, {
    getAccessToken: async () => "google-token",
    fetcher: async (input, init) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      calls.push({ input: String(input), body });
      if (String(input).endsWith(":beginTransaction")) {
        begins++;
        return json({ transaction: `transaction-${begins}` });
      }
      if (String(input).endsWith(":commit")) {
        commits++;
        return commits === 1
          ? json({ error: { status: "FAILED_PRECONDITION" } }, 400)
          : json({});
      }
      if (String(input).endsWith(":rollback")) {
        return json({});
      }
      throw new Error(`unexpected ${String(input)}`);
    },
  });
  const result = await client.runTransaction(async () => ({
    result: "done",
    writes: [
      authUpdateWrite(authDocumentName("authOps", "op-1"), {
        status: "started",
      }),
    ],
  }));
  assert.equal(result, "done");
  assert.equal(begins, 2);
  assert.equal(commits, 2);
  const secondBegin = calls.filter((call) =>
    call.input.endsWith(":beginTransaction"),
  )[1];
  assert.deepEqual(secondBegin.body, {
    options: { readWrite: { retryTransaction: "transaction-1" } },
  });
});

test("paginates subcollection documents and decodes exact values", async () => {
  let pages = 0;
  const client = createAuthFirestoreClient(env, {
    getAccessToken: async () => "google-token",
    fetcher: async (input) => {
      const url = new URL(String(input));
      pages++;
      const id = pages === 1 ? "game-1" : "game-2";
      assert.equal(url.searchParams.get("pageSize"), "100");
      if (pages === 2) {
        assert.equal(url.searchParams.get("pageToken"), "next-page");
      }
      return json({
        documents: [
          {
            name: `projects/mons-link/databases/(default)/documents/users/profile-1/games/${id}`,
            fields: {
              score: { integerValue: String(pages) },
              large: { integerValue: "9223372036854775807" },
              special: {
                doubleValue: pages === 1 ? "NaN" : "-Infinity",
              },
              tags: {
                arrayValue: { values: [{ stringValue: "rated" }] },
              },
            },
          },
        ],
        ...(pages === 1 ? { nextPageToken: "next-page" } : {}),
      });
    },
  });
  const firstPage = await client.listPage("users/profile-1", "games");
  const secondPage = await client.listPage(
    "users/profile-1",
    "games",
    firstPage.nextPageToken,
  );
  const documents = [...firstPage.documents, ...secondPage.documents];
  assert.deepEqual(
    documents.map((document) => [document.id, document.fields]),
    [
      [
        "game-1",
        {
          score: 1,
          large: { __firestoreInteger: "9223372036854775807" },
          special: { __firestoreDouble: "NaN" },
          tags: ["rated"],
        },
      ],
      [
        "game-2",
        {
          score: 2,
          large: { __firestoreInteger: "9223372036854775807" },
          special: { __firestoreDouble: "-Infinity" },
          tags: ["rated"],
        },
      ],
    ],
  );
  assert.deepEqual(encodeFields(documents[0].fields).large, {
    integerValue: "9223372036854775807",
  });
  assert.deepEqual(encodeFields(documents[0].fields).special, {
    doubleValue: "NaN",
  });
});

test("accepts valid large documents and projects query fields", async () => {
  const large = "a".repeat(1_048_480);
  const client = createAuthFirestoreClient(env, {
    getAccessToken: async () => "google-token",
    fetcher: async (input, init) => {
      if (String(input).endsWith(":runQuery")) {
        const body = JSON.parse(String(init?.body)) as {
          structuredQuery: Record<string, unknown>;
        };
        assert.deepEqual(body.structuredQuery.select, {
          fields: [{ fieldPath: "username" }],
        });
        assert.deepEqual(body.structuredQuery.orderBy, [
          {
            field: { fieldPath: "__name__" },
            direction: "ASCENDING",
          },
        ]);
        assert.deepEqual(body.structuredQuery.startAt, {
          values: [
            {
              referenceValue: authDocumentName("users", "profile-0"),
            },
          ],
          before: false,
        });
        return json([]);
      }
      return json({
        name: authDocumentName("users", "profile-1"),
        fields: { payload: { stringValue: large } },
      });
    },
  });
  const document = await client.get(authDocumentName("users", "profile-1"));
  assert.equal(document?.fields.payload, large);
  await client.query("users", {}, 100, ["username"], "profile-0");
});
