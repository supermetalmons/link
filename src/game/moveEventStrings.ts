import * as MonsRules from "mons-rules";
import * as Board from "./board";
import { colors } from "../content/boardStyles";

export type MoveHistoryToken =
  | { type: "icon"; icon: string; alt: string }
  | { type: "text"; text: string }
  | { type: "emoji"; emoji: string; alt: string }
  | { type: "square"; color: string; alt: string }
  | {
      type: "composite";
      baseIcon: string;
      overlayIcon: string;
      alt: string;
      overlayAlt: string;
      variant: "mana" | "supermana" | "bomb";
    };

export type MoveHistorySegment = MoveHistoryToken[];

export type MoveHistoryEntry = {
  segments: MoveHistorySegment[];
  segmentRoles?: MoveHistorySegmentRole[];
  hasTurnSeparator?: boolean;
};

export type MoveHistorySegmentRole = "arrow" | "destination" | "normal";

type DirectionalGameEvent = Extract<
  MonsRules.GameEvent,
  { readonly from: MonsRules.Position; readonly to: MonsRules.Position }
>;

function arrowForEvent(e: DirectionalGameEvent): {
  arrow: string;
  isRight: boolean;
} {
  let di = e.to.row - e.from.row;
  let dj = e.to.column - e.from.column;
  if (Board.isFlipped) {
    di = -di;
    dj = -dj;
  }
  if (di === 0 && dj > 0) return { arrow: "→", isRight: true };
  if (di === 0 && dj < 0) return { arrow: "←", isRight: false };
  if (dj === 0 && di > 0) return { arrow: "↓", isRight: true };
  if (dj === 0 && di < 0) return { arrow: "↑", isRight: true };
  if (di < 0 && dj > 0) return { arrow: "↗", isRight: true };
  if (di > 0 && dj > 0) return { arrow: "↘", isRight: true };
  if (di > 0 && dj < 0) return { arrow: "↙", isRight: false };
  if (di < 0 && dj < 0) return { arrow: "↖", isRight: false };
  return { arrow: "→", isRight: true };
}

function addArrowToken(tokens: MoveHistoryToken[], ev: DirectionalGameEvent) {
  const { arrow, isRight } = arrowForEvent(ev);
  const arrowToken: MoveHistoryToken = { type: "text", text: arrow };
  if (isRight) {
    tokens.push(arrowToken);
  } else {
    tokens.unshift(arrowToken);
  }
}

function addActionArrowTokens(
  tokens: MoveHistoryToken[],
  ev: DirectionalGameEvent,
): boolean {
  const { arrow, isRight } = arrowForEvent(ev);
  const actionToken: MoveHistoryToken = {
    type: "emoji",
    emoji: "statusAction",
    alt: "action",
  };
  const arrowToken: MoveHistoryToken = { type: "text", text: arrow };
  if (isRight) {
    tokens.push(actionToken);
    tokens.push(arrowToken);
  } else {
    tokens.unshift(actionToken);
    tokens.unshift(arrowToken);
  }
  return isRight;
}

function compositeToken(
  base: { icon: string; alt: string },
  overlay: { icon: string; alt: string },
  variant: "mana" | "supermana" | "bomb",
): MoveHistoryToken {
  return {
    type: "composite",
    baseIcon: base.icon,
    overlayIcon: overlay.icon,
    alt: `${base.alt} carrying ${overlay.alt}`,
    overlayAlt: overlay.alt,
    variant,
  };
}

function tokensForItem(item?: MonsRules.BoardItem): MoveHistoryToken[] {
  if (!item) return [];
  const tokens: MoveHistoryToken[] = [];
  switch (item.kind) {
    case "mon": {
      const monToken = monIconForKind(item.mon.kind, item.mon.color);
      if (!monToken) {
        break;
      }
      if (item.carrying?.kind === "mana") {
        const manaToken = manaOverlayIconFor(item.carrying.mana);
        tokens.push(
          compositeToken(
            monToken,
            { icon: manaToken.icon, alt: manaToken.alt },
            manaToken.variant,
          ),
        );
      } else if (item.carrying?.kind === "consumable") {
        tokens.push(
          compositeToken(
            monToken,
            consumableIconFor(item.carrying.consumable),
            "bomb",
          ),
        );
      } else {
        tokens.push({ type: "icon", ...monToken });
      }
      break;
    }
    case "mana": {
      tokens.push({ type: "icon", ...manaIconFor(item.mana) });
      break;
    }
    case "consumable": {
      tokens.push({ type: "icon", ...consumableIconFor(item.consumable) });
      break;
    }
  }
  return tokens;
}

function locationsEqual(
  a?: MonsRules.Position,
  b?: MonsRules.Position,
): boolean {
  if (!a || !b) return false;
  return a.row === b.row && a.column === b.column;
}

function targetTokensFromActionEvents(
  events: readonly MonsRules.GameEvent[],
  startIndex: number,
  targetLoc?: MonsRules.Position,
): MoveHistoryToken[] {
  if (!targetLoc) return [];
  let targetMon: MonsRules.Mon | null = null;
  let sawBombExplosion = false;
  let manaOverlay: {
    icon: string;
    alt: string;
    variant: "mana" | "supermana";
  } | null = null;
  let supermanaTokens: MoveHistoryToken[] | null = null;
  let manaTokens: MoveHistoryToken[] | null = null;

  for (let i = startIndex + 1; i < events.length; i++) {
    const next = events[i];
    switch (next.kind) {
      case "mon-fainted":
        if (
          locationsEqual(next.from, targetLoc) ||
          locationsEqual(next.to, targetLoc)
        ) {
          targetMon = next.mon;
        }
        break;
      case "mana-dropped":
        if (locationsEqual(next.at, targetLoc)) {
          manaTokens = [{ type: "icon", ...manaIconFor(next.mana) }];
          const overlay = manaOverlayIconFor(next.mana);
          manaOverlay = {
            icon: overlay.icon,
            alt: overlay.alt,
            variant: overlay.variant,
          };
        }
        break;
      case "supermana-back-to-base":
        if (locationsEqual(next.from, targetLoc)) {
          supermanaTokens = [
            { type: "icon", icon: "supermana", alt: "supermana" },
          ];
          manaOverlay = {
            icon: "supermanaSimple",
            alt: "supermana",
            variant: "supermana",
          };
        }
        break;
      case "bomb-explosion":
        if (locationsEqual(next.at, targetLoc)) {
          sawBombExplosion = true;
        }
        break;
      default:
        break;
    }
    if (targetMon && sawBombExplosion) break;
  }

  if (targetMon) {
    const monToken = monIconForKind(targetMon.kind, targetMon.color);
    if (monToken) {
      if (manaOverlay) {
        return [
          compositeToken(
            monToken,
            { icon: manaOverlay.icon, alt: manaOverlay.alt },
            manaOverlay.variant,
          ),
        ];
      }
      if (sawBombExplosion) {
        const bombToken = consumableIconFor(MonsRules.Consumable.Bomb);
        return [compositeToken(monToken, bombToken, "bomb")];
      }
      return [{ type: "icon", ...monToken }];
    }
  }

  return supermanaTokens ?? manaTokens ?? [];
}

function monIconForKind(
  kind: MonsRules.MonKind | undefined,
  color?: MonsRules.Color,
): { icon: string; alt: string } | null {
  if (kind === undefined || kind === null) return null;
  const isBlack = color === MonsRules.Color.Black;
  switch (kind) {
    case MonsRules.MonKind.Demon:
      return {
        icon: isBlack ? "demonB" : "demon",
        alt: isBlack ? "black demon" : "demon",
      };
    case MonsRules.MonKind.Drainer:
      return {
        icon: isBlack ? "drainerB" : "drainer",
        alt: isBlack ? "black drainer" : "drainer",
      };
    case MonsRules.MonKind.Angel:
      return {
        icon: isBlack ? "angelB" : "angel",
        alt: isBlack ? "black angel" : "angel",
      };
    case MonsRules.MonKind.Spirit:
      return {
        icon: isBlack ? "spiritB" : "spirit",
        alt: isBlack ? "black spirit" : "spirit",
      };
    case MonsRules.MonKind.Mystic:
      return {
        icon: isBlack ? "mysticB" : "mystic",
        alt: isBlack ? "black mystic" : "mystic",
      };
    default:
      return null;
  }
}

function manaIconFor(mana?: MonsRules.Mana | null): {
  icon: string;
  alt: string;
} {
  if (!mana) {
    return { icon: "mana", alt: "mana" };
  }
  if (mana.kind === "supermana") {
    return { icon: "supermana", alt: "supermana" };
  }
  const isBlack = mana.color === MonsRules.Color.Black;
  return {
    icon: isBlack ? "manaB" : "mana",
    alt: isBlack ? "black mana" : "mana",
  };
}

function manaOverlayIconFor(mana?: MonsRules.Mana | null): {
  icon: string;
  alt: string;
  variant: "mana" | "supermana";
} {
  if (!mana) {
    return { icon: "mana", alt: "mana", variant: "mana" };
  }
  if (mana.kind === "supermana") {
    return { icon: "supermanaSimple", alt: "supermana", variant: "supermana" };
  }
  const isBlack = mana.color === MonsRules.Color.Black;
  return {
    icon: isBlack ? "manaB" : "mana",
    alt: isBlack ? "black mana" : "mana",
    variant: "mana",
  };
}

function consumableIconFor(consumable?: MonsRules.Consumable | null): {
  icon: string;
  alt: string;
} {
  switch (consumable) {
    case MonsRules.Consumable.Potion:
      return { icon: "potion", alt: "potion" };
    case MonsRules.Consumable.Bomb:
      return { icon: "bomb", alt: "bomb" };
    case MonsRules.Consumable.BombOrPotion:
      return { icon: "bombOrPotion", alt: "bomb or potion" };
    default:
      return { icon: "bombOrPotion", alt: "consumable" };
  }
}

export function tokensForSingleMoveEvents(
  events: readonly MonsRules.GameEvent[],
  activeColor?: MonsRules.Color,
): MoveHistoryEntry {
  const segments: MoveHistorySegment[] = [];
  const segmentRoles: MoveHistorySegmentRole[] = [];
  let hasTurnSeparator = false;
  let lastArrowIndex: number | null = null;
  let lastArrowIsRight = true;
  let rightInsertIndex = 0;
  let lastActionSegment: MoveHistorySegment | null = null;

  const insertDestinationSegment = (segment: MoveHistorySegment) => {
    if (lastArrowIndex === null) {
      segments.push(segment);
      segmentRoles.push("destination");
    } else if (lastArrowIsRight) {
      segments.splice(rightInsertIndex, 0, segment);
      segmentRoles.splice(rightInsertIndex, 0, "destination");
      rightInsertIndex += 1;
    } else {
      segments.splice(lastArrowIndex, 0, segment);
      segmentRoles.splice(lastArrowIndex, 0, "destination");
      lastArrowIndex += 1;
      rightInsertIndex = lastArrowIndex + 1;
    }
  };

  const insertPotionIntoActionSegment = (segment: MoveHistorySegment) => {
    const potionToken: MoveHistoryToken = {
      type: "emoji",
      emoji: "statusPotion",
      alt: "potion status",
    };
    const actionIndex = segment.findIndex(
      (token) => token.type === "emoji" && token.emoji === "statusAction",
    );
    const existingPotionIndices: number[] = [];
    segment.forEach((token, index) => {
      if (token.type === "emoji" && token.emoji === "statusPotion") {
        existingPotionIndices.push(index);
      }
    });
    if (actionIndex === -1) {
      if (existingPotionIndices.length === 0) {
        segment.push(potionToken);
      }
      return;
    }
    segment[actionIndex] = potionToken;
    for (let i = existingPotionIndices.length - 1; i >= 0; i--) {
      const index = existingPotionIndices[i];
      if (index !== actionIndex) {
        segment.splice(index, 1);
      }
    }
  };

  for (let index = 0; index < events.length; index++) {
    const ev = events[index];
    const tokens: MoveHistoryToken[] = [];
    let segmentRole: "arrow" | "destination" | "normal" | "skip" = "normal";
    let arrowIsRight = true;
    let extraDestinationTokens: MoveHistorySegment | null = null;
    switch (ev.kind) {
      case "mon-move": {
        tokens.push(...tokensForItem(ev.item));
        addArrowToken(tokens, ev);
        arrowIsRight = arrowForEvent(ev).isRight;
        segmentRole = "arrow";
        break;
      }
      case "mana-move": {
        const manaToken = manaIconFor(ev.mana);
        tokens.push({ type: "icon", ...manaToken });
        addArrowToken(tokens, ev);
        arrowIsRight = arrowForEvent(ev).isRight;
        segmentRole = "arrow";
        break;
      }
      case "mystic-action": {
        const monToken = monIconForKind(ev.mystic.kind, ev.mystic.color);
        let actorToken: MoveHistoryToken | null = null;
        if (monToken) {
          actorToken = { type: "icon", ...monToken };
          tokens.push(actorToken);
        }
        arrowIsRight = addActionArrowTokens(tokens, ev);
        segmentRole = "arrow";
        const targetTokens = targetTokensFromActionEvents(events, index, ev.to);
        if (targetTokens.length > 0) extraDestinationTokens = targetTokens;
        break;
      }
      case "demon-action": {
        const monToken = monIconForKind(ev.demon.kind, ev.demon.color);
        let actorToken: MoveHistoryToken | null = null;
        if (monToken) {
          actorToken = { type: "icon", ...monToken };
          tokens.push(actorToken);
        }
        arrowIsRight = addActionArrowTokens(tokens, ev);
        segmentRole = "arrow";
        const targetTokens = targetTokensFromActionEvents(events, index, ev.to);
        if (targetTokens.length > 0) extraDestinationTokens = targetTokens;
        break;
      }
      case "spirit-target-move": {
        const targetTokens = tokensForItem(ev.item);
        const spiritToken = monIconForKind(
          MonsRules.MonKind.Spirit,
          activeColor ?? MonsRules.Color.White,
        );
        const actionToken: MoveHistoryToken = {
          type: "emoji",
          emoji: "statusAction",
          alt: "action",
        };
        const { arrow, isRight } = arrowForEvent(ev);
        const arrowToken: MoveHistoryToken = { type: "text", text: arrow };
        let actorToken: MoveHistoryToken | null = null;
        if (spiritToken) {
          actorToken = { type: "icon", ...spiritToken };
        }
        if (isRight) {
          if (actorToken) tokens.push(actorToken);
          tokens.push(actionToken);
          if (targetTokens.length > 0) tokens.push(...targetTokens);
          tokens.push(arrowToken);
        } else {
          tokens.push(arrowToken);
          if (targetTokens.length > 0) tokens.push(...targetTokens);
          tokens.push(actionToken);
          if (actorToken) tokens.push(actorToken);
        }
        arrowIsRight = isRight;
        segmentRole = "arrow";
        break;
      }
      case "bomb-attack": {
        const monToken = monIconForKind(ev.by.kind, ev.by.color);
        const bombToken = consumableIconFor(MonsRules.Consumable.Bomb);
        if (monToken) {
          tokens.push(compositeToken(monToken, bombToken, "bomb"));
        } else {
          tokens.push({ type: "icon", ...bombToken });
        }
        addArrowToken(tokens, ev);
        arrowIsRight = arrowForEvent(ev).isRight;
        segmentRole = "arrow";
        const targetTokens = targetTokensFromActionEvents(events, index, ev.to);
        if (targetTokens.length > 0) extraDestinationTokens = targetTokens;
        break;
      }
      case "mana-scored": {
        tokens.push({ type: "square", color: colors.manaPool, alt: "score" });
        segmentRole = "destination";
        break;
      }
      case "pickup-bomb": {
        tokens.push({
          type: "icon",
          ...consumableIconFor(MonsRules.Consumable.Bomb),
        });
        segmentRole = "destination";
        break;
      }
      case "pickup-potion": {
        tokens.push({
          type: "icon",
          ...consumableIconFor(MonsRules.Consumable.Potion),
        });
        segmentRole = "destination";
        break;
      }
      case "pickup-mana": {
        const prevKind = index > 0 ? events[index - 1].kind : undefined;
        const cameFromManaMove =
          prevKind === "mana-move" || prevKind === "spirit-target-move";
        if (cameFromManaMove) {
          const monToken = monIconForKind(ev.by.kind, ev.by.color);
          if (monToken) {
            tokens.push({ type: "icon", ...monToken });
          }
        } else {
          const manaToken = manaIconFor(ev.mana);
          tokens.push({ type: "icon", ...manaToken });
        }
        segmentRole = "destination";
        break;
      }
      case "bomb-explosion":
        // TODO: explosion indicator when there is a swagpacked one
        break;
      case "game-over":
        // TODO: add game ended indicator depending on the reason game ended
        break;
      case "use-potion":
        if (lastActionSegment) {
          insertPotionIntoActionSegment(lastActionSegment);
          segmentRole = "skip";
        } else {
          tokens.push({
            type: "emoji",
            emoji: "statusPotion",
            alt: "potion status",
          });
        }
        break;
      case "next-turn":
        hasTurnSeparator = true;
        segmentRole = "skip";
        break;
      case "mon-fainted":
      case "mana-dropped":
      case "mon-awake":
      case "takeback":
      case "supermana-back-to-base":
      case "demon-additional-step":
        break;
    }

    if (tokens.length === 0 || segmentRole === "skip") {
      continue;
    }

    if (segmentRole === "arrow") {
      segments.push(tokens);
      segmentRoles.push("arrow");
      lastArrowIndex = segments.length - 1;
      lastArrowIsRight = arrowIsRight;
      rightInsertIndex = lastArrowIndex + 1;
      if (
        ev.kind === "mystic-action" ||
        ev.kind === "demon-action" ||
        ev.kind === "spirit-target-move"
      ) {
        lastActionSegment = tokens;
      } else {
        lastActionSegment = null;
      }
    } else if (segmentRole === "destination") {
      insertDestinationSegment(tokens);
    } else {
      segments.push(tokens);
      segmentRoles.push("normal");
      lastArrowIndex = null;
      rightInsertIndex = segments.length;
      lastActionSegment = null;
    }

    if (extraDestinationTokens) {
      insertDestinationSegment(extraDestinationTokens);
    }
  }

  return { segments, segmentRoles, hasTurnSeparator };
}
