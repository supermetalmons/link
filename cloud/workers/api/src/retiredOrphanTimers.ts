import { createHash } from "node:crypto";

export type OrphanTimerIdentity = {
  inviteId: string;
  matchId: string;
  playerId: string;
  opponentId: string;
  turnNumber: number;
  deadlineAtMs: number;
};

export function retiredOrphanTimerSignature(
  value: OrphanTimerIdentity,
): string {
  for (const key of [
    "inviteId",
    "matchId",
    "playerId",
    "opponentId",
  ] as const) {
    const id = value[key];
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 768 ||
      id.trim() !== id ||
      Array.from(id).some(
        (character) =>
          character.charCodeAt(0) < 32 || ".#$[]/".includes(character),
      )
    )
      throw new TypeError("invalid-orphan-timer-identity");
  }
  if (
    value.playerId === value.opponentId ||
    !Number.isSafeInteger(value.turnNumber) ||
    value.turnNumber < 0 ||
    !Number.isSafeInteger(value.deadlineAtMs) ||
    value.deadlineAtMs <= 0
  )
    throw new TypeError("invalid-orphan-timer-identity");
  return createHash("sha256")
    .update(
      JSON.stringify([
        "mons-orphan-timer-cancellation-v1",
        value.inviteId,
        value.matchId,
        value.playerId,
        value.opponentId,
        value.turnNumber,
        value.deadlineAtMs,
      ]),
    )
    .digest("hex");
}

export const RETIRED_ORPHAN_TIMER_SIGNATURES: readonly string[] = Object.freeze(
  [
    "049dfd4cb21e15c19d17d6b35fa694b08555d90e8287a74fa6da64fb8831413a",
    "0e8711c3f53b3ef898615f45be416f077da4bc91bee9d822b7ef728a1cb31efa",
    "2d399f9319579c2af71fa612334e46bb265715d4ee5dbc83ac3eb475193b549c",
    "34cff6781f6d1295fceb5fac71831fd34aab9be8ad2fa2f6481932ad1620f357",
    "3a15e0ac076ccb0b5c9129c6bc64fd2434eb2f0eb421b80846dbf24c111a6804",
    "3d021784b018d912768482af6e441345b5311965926b9964ec3f9ddf80656414",
    "443dfb81bdb455556e6a4f74e6b5e88cb0f6a133d3f8361269a609034710b621",
    "4bf4d01370aef2664907864b9810c7fc085c8cc154b391abcd09e2a05f51bccf",
    "594a12b75e9e060f519f4fc7b9fc65e556e60d41511b168ecdaa728556e21665",
    "68a411406829eaa9634125d3909a79d3640fbcbc9b4d8a20a8e166e48b6aa1bc",
    "6fd2d82099142f7cd3f53549d02bdbcd50c286046b6696729aeab4997c3de1b6",
    "703560e8508a4fc1e2c3dffe21ff212d1d8e7d9fb418e90c89d774c92e957449",
    "77ca61663322297814ac14edc03fcd962ba475a9854829d9b6027908b3439231",
    "7dba7638b853cce617b109c89da15d0849c9b9a6e5ee20eef6b94e8678bfcf37",
    "92ec8976bfaa5218708b958a65380b7f1ea49a3a9cff638e8e8e82e4e48e618d",
    "b26edf589a4818af187c53979e200a1bae803beb6b809a46f788e1c5e9f82afd",
    "ba170c46ba16aa46468b49ed461ec24d9b49f4d2a7901031d75a0314315cf94c",
    "d41aad62c617e15337779e01890d055c5d4a0e6e60396c570edfb90eb1164a3c",
    "e1f8b8e8dae99b9a14c55d80a8af0ac13190b8763356eb099a0002d5ad0b3fdf",
    "e620ac69c21096d8ed81c5bc692bde57340e88eb00b559aa42e4e1b141131c45",
    "e9981a2973685626b12b3474623189876bada4450e39a7c11b2c143aeebe8a12",
  ],
);
const signatures = new Set(RETIRED_ORPHAN_TIMER_SIGNATURES);
export function isRetiredOrphanTimer(value: OrphanTimerIdentity): boolean {
  return signatures.has(retiredOrphanTimerSignature(value));
}

export type ApprovedOrphanTimerContext = {
  signature: string;
  beforeDigest: string;
  afterDigest: string;
};
export const APPROVED_ORPHAN_TIMER_CONTEXTS: readonly ApprovedOrphanTimerContext[] =
  Object.freeze([
    {
      signature:
        "049dfd4cb21e15c19d17d6b35fa694b08555d90e8287a74fa6da64fb8831413a",
      beforeDigest:
        "26f9fc5d436ad2224741ba225fed92487fe189cf7452c855fb57d15c5be091b7",
      afterDigest:
        "4170ee9561105c8b1b0133d33fc53a015a705392bf9b3c7c62b46aa39e7be238",
    },
    {
      signature:
        "0e8711c3f53b3ef898615f45be416f077da4bc91bee9d822b7ef728a1cb31efa",
      beforeDigest:
        "1132f62dfa02fe6bbe291443290ec4354cc0c9627af64d416bf6b3d52e8ed4ab",
      afterDigest:
        "2226723963df634bc7c53c44cf4256bc4dc871fe500f13e842eebe36c20cf636",
    },
    {
      signature:
        "2d399f9319579c2af71fa612334e46bb265715d4ee5dbc83ac3eb475193b549c",
      beforeDigest:
        "bfb69e7a3541653fdc2366b78d0b2a957ad690074e4c90305ace509d75ee2523",
      afterDigest:
        "a8e8e2763299f38b9487daf30c0db00d12a5b799c34d02112baffbf6e35128c4",
    },
    {
      signature:
        "34cff6781f6d1295fceb5fac71831fd34aab9be8ad2fa2f6481932ad1620f357",
      beforeDigest:
        "3f7e8982f01067a8c37c28c78664059686de65ed394153c8094dbb8a16ee0503",
      afterDigest:
        "fded89ee899863b7a3e7ec037fface52b3f16f012d2d1ea6701c532d09311e34",
    },
    {
      signature:
        "3a15e0ac076ccb0b5c9129c6bc64fd2434eb2f0eb421b80846dbf24c111a6804",
      beforeDigest:
        "2ac63fb1ecbabb1fa602d635f254711794e018de52386709df9859f4e62a4810",
      afterDigest:
        "4cc8bf5d2129060d68318466f0e789895df94cc83facf14cb5ed9553cf734599",
    },
    {
      signature:
        "3d021784b018d912768482af6e441345b5311965926b9964ec3f9ddf80656414",
      beforeDigest:
        "3b2f0add89125656f1032ca27a76ec39505e5fb9cf0a6cb196ccf83948054783",
      afterDigest:
        "b10a41282c40d2c859a2c2208fc4f57cb90ccdccde3e2ed0775099924a442449",
    },
    {
      signature:
        "443dfb81bdb455556e6a4f74e6b5e88cb0f6a133d3f8361269a609034710b621",
      beforeDigest:
        "4e707490f06d0f2566e198b885e5ecb29941edcebc03c0a54aea895b22eee565",
      afterDigest:
        "0f1e29f50221fddaab064f2febed7f62b918aa9a9d437441d2049cb979a99187",
    },
    {
      signature:
        "4bf4d01370aef2664907864b9810c7fc085c8cc154b391abcd09e2a05f51bccf",
      beforeDigest:
        "f1d681aa9fc521f92f4af7fd8778fb6e0bf7b9c5062a01d849539e93a68f77e2",
      afterDigest:
        "0182804d30b55928201b6c543493374387504c662c47e7a7a39452d3335e6fb9",
    },
    {
      signature:
        "594a12b75e9e060f519f4fc7b9fc65e556e60d41511b168ecdaa728556e21665",
      beforeDigest:
        "cb4c1eaff7fb3efe54873a7bb0f50f713e9b6a40d971c0a8bdf3353e4c6c0102",
      afterDigest:
        "c3091aab13d64534203bc147558434773489cf651863d8306d51bc8b16182959",
    },
    {
      signature:
        "68a411406829eaa9634125d3909a79d3640fbcbc9b4d8a20a8e166e48b6aa1bc",
      beforeDigest:
        "2d75ced8c17a800e8927d3fe694a169a8d68afcf5eb96c5de194bbdb326be52e",
      afterDigest:
        "09860a85e20f7ef5b18d6396c5ad1ae865929840ddb424197bb6ec954897f9f6",
    },
    {
      signature:
        "6fd2d82099142f7cd3f53549d02bdbcd50c286046b6696729aeab4997c3de1b6",
      beforeDigest:
        "947575bec1a3cad4ea6bbc43ee505195c56f2395773104546e6c67a80ff8ef95",
      afterDigest:
        "a1a043827591621bd2ffc4edb9dd02af2e90ec3b4c5f15475e391836517dd227",
    },
    {
      signature:
        "703560e8508a4fc1e2c3dffe21ff212d1d8e7d9fb418e90c89d774c92e957449",
      beforeDigest:
        "46d3078b8cbf9a0a68d7de85e80b8358278dc482ad02e6670c73e248f56f0092",
      afterDigest:
        "3e3df062ce10d14abd7b2556ad4a46e29958f8e9119f21f437859bed1c87a6a9",
    },
    {
      signature:
        "77ca61663322297814ac14edc03fcd962ba475a9854829d9b6027908b3439231",
      beforeDigest:
        "432de51971694db0fbb5efeb09057ecd9ad1c8f7857d7fc4dbd34523c7648ac7",
      afterDigest:
        "ee45aa668e3f6371ab22c8aefa33b93471ab024031ba16ac1b854de43a507f42",
    },
    {
      signature:
        "7dba7638b853cce617b109c89da15d0849c9b9a6e5ee20eef6b94e8678bfcf37",
      beforeDigest:
        "da07c99b647c98a5f84ca935a724877d09249326e5090c8a20cd913cf6c81f3f",
      afterDigest:
        "f1e7d6c24aaee9e90c9f837f27261df76ab77e6964540c894057e256314f64fe",
    },
    {
      signature:
        "92ec8976bfaa5218708b958a65380b7f1ea49a3a9cff638e8e8e82e4e48e618d",
      beforeDigest:
        "11a965b925fdfccd3aff4d5204ba2afb40f244c071d3e3f9b67e35c44c36d546",
      afterDigest:
        "7fe98d31f7f264a3cd810b27c39a3c7a46097b684bf24a38fb89f2d04fd87392",
    },
    {
      signature:
        "b26edf589a4818af187c53979e200a1bae803beb6b809a46f788e1c5e9f82afd",
      beforeDigest:
        "8e441b5d451e420d60beac9dc14aacc0ca16e0449b17a5292f43d2a07a1ed3aa",
      afterDigest:
        "2768de63401199c1236bfab8f8113ebc45aa437a8715266be6d6cf535b6df35d",
    },
    {
      signature:
        "ba170c46ba16aa46468b49ed461ec24d9b49f4d2a7901031d75a0314315cf94c",
      beforeDigest:
        "5db5b778d64a0fbb25257c9418745338af27adef892daf2cbe2d3985ca894c6a",
      afterDigest:
        "9be60af98fe67eda3e2dca0542026eaf25d9552ba0341f797a17cac7eb84908f",
    },
    {
      signature:
        "d41aad62c617e15337779e01890d055c5d4a0e6e60396c570edfb90eb1164a3c",
      beforeDigest:
        "ef42ba45cbccc4491928f13f7d6351e6b9525da405537f0c7a588324f25ad97a",
      afterDigest:
        "4ce7c0739fbb19fca578a7855dd2660e1307a12b957911da6b0344a8293e9c5a",
    },
    {
      signature:
        "e1f8b8e8dae99b9a14c55d80a8af0ac13190b8763356eb099a0002d5ad0b3fdf",
      beforeDigest:
        "7af15ab0e34cc37bb6dc4b7bbce8a295c3a03292f1f0b79007e4974a2d8f9276",
      afterDigest:
        "dda70cef107f46a2fe7f8eadc61b170c93a79241f320e2840e4ee4ae938cccc3",
    },
    {
      signature:
        "e620ac69c21096d8ed81c5bc692bde57340e88eb00b559aa42e4e1b141131c45",
      beforeDigest:
        "4c602b73e72659701da1bb80c3cfcf1b3403e8539804d36c109b74a258d6a789",
      afterDigest:
        "026c56c3ed7076c0033d185135e2215b9521d602178684ddaf95cf7880f979aa",
    },
    {
      signature:
        "e9981a2973685626b12b3474623189876bada4450e39a7c11b2c143aeebe8a12",
      beforeDigest:
        "65fb07529515dffe44861365466fc7e7cd3d7baa2b4d58f00607769a97ff9906",
      afterDigest:
        "aaf3f90e3c002943ae7762a272a6665726259b711ee5907d6fdfaf141efd9ad3",
    },
  ]);
