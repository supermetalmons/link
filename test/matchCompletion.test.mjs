import assert from "node:assert/strict";
import test from "node:test";
import { isCompletedMatchPair } from "../src/connection/matchCompletion.ts";
import { canonicalMatch } from "./fixtures/canonicalData.mjs";
import { canonicalScoreMatchPair } from "./fixtures/completedMatchPair.mjs";

test("recognizes canonical scoring wins for either host color", () => {
  for (const hostColor of /** @type {const} */ (["white", "black"])) {
    const pair = canonicalScoreMatchPair({ hostColor });
    assert.equal(pair.hostMatch.status, "active");
    assert.equal(pair.guestMatch.status, "active");
    assert.equal(pair.hostMatch.timer.state, "idle");
    assert.equal(pair.guestMatch.timer.state, "idle");
    assert.equal(isCompletedMatchPair(pair), true);
    assert.equal(
      isCompletedMatchPair(
        canonicalScoreMatchPair({ hostColor, completed: false }),
      ),
      false,
    );
  }
});

test("recognizes surrender and timer completion on either side", () => {
  for (const side of /** @type {const} */ (["hostMatch", "guestMatch"])) {
    for (const terminal of [
      canonicalMatch({ status: "surrendered" }),
      canonicalMatch({ timer: { state: "finished" } }),
    ]) {
      const pair = {
        hostMatch: canonicalMatch(),
        guestMatch: canonicalMatch({ color: "black" }),
        [side]: terminal,
      };
      assert.equal(isCompletedMatchPair(pair), true);
    }
  }
});

test("rejects missing, malformed, and unconfirmed score completion", () => {
  const pair = canonicalScoreMatchPair();
  for (const invalid of [
    { ...pair, hostMatch: null },
    { ...pair, guestMatch: null },
    { ...pair, hostMatch: { ...pair.hostMatch, color: pair.guestMatch.color } },
    {
      hostMatch: { ...pair.hostMatch, fen: "invalid" },
      guestMatch: { ...pair.guestMatch, fen: "invalid" },
    },
    { ...pair, guestMatch: { ...pair.guestMatch, flatMovesString: "invalid" } },
  ]) {
    assert.equal(isCompletedMatchPair(invalid), false);
  }
});
