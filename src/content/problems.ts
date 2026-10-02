import { storage } from "../utils/storage";
import { notifyTutorialProgressSynced } from "../ui/controls/tutorialProgressPort";
import {
  updatePersistedCompletedProblems,
  updatePersistedTutorialCompleted,
} from "./tutorialPersistencePort";

export type Problem = {
  id: string;
  icon: string;
  label: string;
  fen: string;
  description: string;
};

// TODO: show initial text at some point

const descriptionDrainer =
  "Your drainer is the fastest way to move mana. Drainers can move onto the same tile as a mana to pick it up & carry it to a mana pool to score.";

const descriptionMana =
  "Once each turn (except for white's first turn), you must select one of your own mana & move it once in any direction. This ends your turn so save it until you're ready!";

const descriptionSpirit =
  "It is also possible to move mana by using your spirit's active ability ⭐️, which can target a mana from exactly two tiles away & push it one tile in any direction.";

const descriptionSpirit2 =
  "The spirit's active ability can in fact move any piece on the board — mana, items, or other mons. This may give you just the extra boost or reach you need.";

const descriptionDemon =
  "Opposing mons looking to upset your plans can be fainted using your demon's active ability which targets exactly two tiles away but only up, down, left, or right.";

const descriptionMystic =
  "The mystic's active ability also faints opposing mons, but targets exactly two tiles away diagonally, &— unlike the demon's rush attack — it can shoot over other pieces.";

const descriptionAngel =
  "Angels will protect any adjacent friendly mons from demon or mystic attacks, but are not immune to attack themselves.";
// TODO: not using meinong one for now while the angel puzzle is not updated

const descriptionManaB =
  "If you manage to score one of your opponent's mana yourself, that is worth 2 points. The pools are all the same; whoever dunks the mana there gets the points.";

const descriptionItems =
  "Mons can move onto an item pickup to acquire either a bomb or a potion. This one below is just in the way!";

const descriptionBomb =
  "When your attackers can't reach a threat (or also if it's protected by an angel), any mon can pick up a bomb to faint an opposing mon from up to three tiles away.";

const descriptionPotion =
  "Across all your mons, you can normally only use one active ability per turn. If you're holding a potion however, you can use it at any point to get one more. Very powerful.";

const descriptionSuperMana =
  "The super mana is worth 2 points all the time — a lucrative prize indeed!";

const descriptionSuperMana2 =
  "It can be risky grabbing the super mana though, as if a drainer is fainted while holding it, it will automatically return to the central tile.";

export const problems: Problem[] = [
  {
    id: "drainer",
    icon: "drainer",
    label: "Moving & Scoring",
    description: descriptionDrainer,
    fen: "4 0 w 0 0 0 0 0 15 n11/n11/n11/n11/n11/n11/n11/n02xxMn02D0xn05/n04xxMn02xxMn03/n11/n11",
  },
  {
    id: "mana",
    icon: "mana",
    label: "Mana Moves",
    description: descriptionMana,
    fen: "4 0 w 0 0 0 0 0 21 n11/n11/n11/n11/n11/n11/n03xxMn07/n04xxMn06/n11/n01xxMn09/n10D0x",
  },
  {
    id: "spirit",
    icon: "spirit",
    label: "Spirits",
    description: descriptionSpirit,
    fen: "4 0 w 0 0 5 0 0 13 n11/n11/n11/n11/n11/n11/n03xxMn02xxMn04/n11/n02xxMn01S0xn06/n11/n11",
  },
  {
    id: "spirit2",
    icon: "spirit",
    label: "Spirits II",
    description: descriptionSpirit2,
    fen: "4 1 w 0 0 0 0 0 19 n11/n11/n11/n11/n11/n11/n05xxMn05/n06D0xn04/n11/n06S0xn04/n11",
  },
  {
    id: "demon",
    icon: "demon",
    label: "Demons",
    description: descriptionDemon,
    fen: "4 0 w 0 0 0 0 0 15 y0xn10/n11/D0Mn03E0xn06/n11/n11/n11/n07xxMn03/n11/n11/n11/n11",
  },
  {
    id: "mystic",
    icon: "mystic",
    label: "Mystics",
    description: descriptionMystic,
    fen: "4 0 w 0 0 0 0 0 17 n11/n11/n11/n11/n11/n11/n11/n01D0xn06xxMn02/d0Mn03Y0xn06/n11/n11",
  },
  {
    id: "manab",
    icon: "manaB",
    label: "Stealing Mana",
    description: descriptionManaB,
    fen: "3 0 w 0 0 0 0 0 23 n11/n11/n11/n11/n11/n11/n03xxMn07/n09xxmn01/n08D0Mn02/n11/n11",
  },
  {
    id: "items",
    icon: "bombOrPotion",
    label: "Items",
    description: descriptionItems,
    fen: "4 0 w 0 0 0 0 0 13 n11/n11/n11/n11/n11/n11/n11/n02xxMn08/n11/n09xxMn01/n07Y0xn02xxQ",
  },
  {
    id: "bomb",
    icon: "bomb",
    label: "Bombs",
    description: descriptionBomb,
    fen: "4 0 w 0 0 0 0 0 21 n11/n01d0Mn09/n11/n11/n11/xxQn10/n04A0xn06/n06xxMn04/n11/n11/n11",
  },
  {
    id: "potion",
    icon: "potion",
    label: "Potions",
    description: descriptionPotion,
    fen: "4 0 w 0 0 0 0 0 7 n11/n11/n11/n11/n11/n10xxQ/n11/n08xxMn02/n07xxMn03/n07S0xn03/n11",
  },
  {
    id: "angel",
    icon: "angel",
    label: "Angels",
    description: descriptionAngel,
    fen: "4 0 w 0 0 0 1 0 15 n11/n11/n11/n11/n11/n11/n11/n05xxMn05/n11/n08Y0xxxMa0x/n10e0x",
  },
  {
    id: "supermana",
    icon: "supermana",
    label: "Super Mana",
    description: descriptionSuperMana,
    fen: "3 0 w 0 0 0 0 0 11 n11/n11/n11/n11/n11/n05xxUn05/n06D0xn04/n03xxMn07/n11/n06S0xn04/n11",
  },
  {
    id: "supermana2",
    icon: "supermana",
    label: "Super Mana II",
    description: descriptionSuperMana2,
    fen: "3 0 w 0 0 0 0 0 13 n11/n01d0Un09/n11/n03Y0xn07/n11/n05D0xn05/n05xxMn01xxMn03/n11/n11/n11/n11",
  },
];

export function getNextProblem(id: string): Problem | null {
  const completedSet = getCompletedProblemIds();
  const currentIndex = problems.findIndex((p) => p.id === id);
  if (currentIndex === -1) return null;

  if (completedSet.size === problems.length) {
    const nextIndex = currentIndex + 1;
    return nextIndex < problems.length ? problems[nextIndex] : null;
  }

  for (let i = currentIndex + 1; i < problems.length; i++) {
    const candidate = problems[i];
    if (!completedSet.has(candidate.id)) {
      return candidate;
    }
  }
  return null;
}

export function getCompletedProblemIds(): Set<string> {
  return new Set(storage.getCompletedProblemIds([]));
}

export function getTutorialCompleted(): boolean {
  return storage.getTutorialCompleted(false);
}

export function markProblemCompleted(id: string): void {
  const completed = getCompletedProblemIds();
  if (!completed.has(id)) {
    completed.add(id);
    const allCompleted = Array.from(completed);
    storage.setCompletedProblemIds(allCompleted);
    updatePersistedCompletedProblems(allCompleted);

    if (allCompleted.length === problems.length && !getTutorialCompleted()) {
      storage.setTutorialCompleted(true);
      updatePersistedTutorialCompleted(true);
    }
  }
}

export function syncTutorialProgress(
  remoteCompletedProblemIds: string[],
  remoteTutorialCompleted: boolean,
) {
  const localTutorialCompleted = getTutorialCompleted();
  const localCompleted = getCompletedProblemIds();

  if (
    localTutorialCompleted &&
    remoteTutorialCompleted &&
    localCompleted.size === problems.length &&
    remoteCompletedProblemIds.length === problems.length
  ) {
    return;
  }

  const merged = new Set([...localCompleted, ...remoteCompletedProblemIds]);

  const mergedArray = Array.from(merged);
  const newTutorialCompleted =
    localTutorialCompleted ||
    remoteTutorialCompleted ||
    merged.size === problems.length;

  storage.setCompletedProblemIds(mergedArray);
  storage.setTutorialCompleted(newTutorialCompleted);

  if (merged.size !== remoteCompletedProblemIds.length) {
    updatePersistedCompletedProblems(mergedArray);
  }
  if (newTutorialCompleted !== remoteTutorialCompleted) {
    updatePersistedTutorialCompleted(newTutorialCompleted);
  }
  notifyTutorialProgressSynced();
}
