import assert from "node:assert/strict";
import { Color, Game } from "mons-rules";
import { canonicalMatch } from "./canonicalData.mjs";

const moves =
  `l10,5;l9,4|l9,4;l8,5|l8,5;l7,4|l7,4;l6,5|l6,5;l5,5|l0,5;l1,6|l1,6;l2,5|l2,5;l3,5|l3,5;l4,6|l4,6;l5,6|l4,7;l3,8|l5,5;l4,6|l4,6;l3,7|l3,7;l2,8|l2,8;l1,9|l1,9;l0,10|l6,7;l5,6|l5,6;l6,7|l6,7;l7,7|l7,7;l8,8|l8,8;l9,9|l9,9;l10,10|l3,8;l4,7|l0,10;l0,9|l10,7;l9,7|l9,7;l8,8|l8,8;l10,10|l0,9;l1,8|l1,8;l2,7|l7,4;l7,3|l0,7;l1,6|l1,6;l2,5|l2,5;l2,7|l2,7;l3,8|l3,8;l4,9|l4,9;l5,10;mb|l5,10;l8,8|l3,4;l2,3|l10,6;l9,5|l9,5;l7,3;l8,2|l10,3;l9,2|l9,2;l8,3|l8,3;l7,3|l7,3;l6,4|l8,2;l9,1|l0,5;l1,5|l0,4;l1,3|l1,3;l1,5;l2,6|l2,6;l3,5|l3,5;l4,4|l4,4;l5,3|l2,3;l1,2|l9,5;l8,4|l8,4;l7,3|l7,3;l5,3;l4,2|l7,3;l6,2|l6,2;l5,1|l5,1;l5,0;mb|l5,0;l4,2|l9,1;l10,0|l1,3;l2,4|l0,3;l1,3|l2,4;l1,2;l0,1|l0,6;l1,5|l1,3;l2,3|l2,3;l3,4|l3,6;l2,7|l10,5;l9,4|l9,4;l8,3|l8,3;l7,2|l5,0;l7,2;l6,3|l6,3;l5,4|l5,4;l4,5|l7,6;l8,7|l3,4;l2,3|l2,3;l4,5|l0,5;l1,6|l1,6;l2,7|l1,5;l1,6|l2,4;l3,4|l0,1;l0,0|l10,7;l9,7|l9,7;l8,8|l8,8;l7,8|l7,8;l5,10|l7,8;l6,7|l6,7;l5,7|l8,7;l9,8|l3,4;l3,5|l2,7;l1,8|l1,8;l0,9|l0,9;l0,10|l3,5;l4,7;l3,7|l0,10;l1,9|l3,7;l2,8|l5,7;l4,6|l4,6;l3,7|l10,5;l9,6|l3,7;l1,9|l6,4;l5,3|l9,6;l8,7|l5,4;l6,3|l3,5;l2,6|l2,6;l2,8;l1,9|l1,9;l0,10`.split(
    "|",
  );

/** @param {{hostColor?: "white" | "black"; completed?: boolean}} [options] */
export function canonicalScoreMatchPair({
  hostColor = "white",
  completed = true,
} = {}) {
  const game = new Game();
  const positions = {
    white: { fen: game.toFen(), flatMovesString: "" },
    black: { fen: game.toFen(), flatMovesString: "" },
  };
  for (const input of moves.slice(0, completed ? moves.length : -1)) {
    const side = game.activeColor === Color.White ? "white" : "black";
    const previous = positions[side];
    game.playFen(input);
    positions[side] = {
      fen: game.toFen(),
      flatMovesString: previous.flatMovesString
        ? `${previous.flatMovesString}-${input}`
        : input,
    };
  }
  assert.equal(game.winner, completed ? Color.Black : undefined);
  const guestColor = hostColor === "white" ? "black" : "white";
  return {
    hostMatch: canonicalMatch({ color: hostColor, ...positions[hostColor] }),
    guestMatch: canonicalMatch({ color: guestColor, ...positions[guestColor] }),
  };
}
