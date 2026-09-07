import type { InviteMetadataSnapshot } from "@mons/shared/invite-metadata";
import {
  parseRematchIndices,
  rematchSeriesEnded,
} from "@mons/shared/rematches";

function extendsRematches(next: string, previous: string): boolean {
  const nextIndices = parseRematchIndices(next);
  const previousIndices = parseRematchIndices(previous);
  return previousIndices.every(
    (index, position) => nextIndices[position] === index,
  );
}

export class InviteMetadataState {
  private value: InviteMetadataSnapshot;

  constructor(snapshot: InviteMetadataSnapshot) {
    this.value = { ...snapshot };
  }

  get snapshot(): InviteMetadataSnapshot {
    return { ...this.value };
  }

  accept(snapshot: InviteMetadataSnapshot): boolean {
    const previous = this.value;
    if (
      snapshot.inviteId !== previous.inviteId ||
      snapshot.hostId !== previous.hostId ||
      snapshot.revision < previous.revision
    ) {
      return false;
    }
    let hostRematches = extendsRematches(
      snapshot.hostRematches,
      previous.hostRematches,
    )
      ? snapshot.hostRematches
      : previous.hostRematches;
    let guestRematches = extendsRematches(
      snapshot.guestRematches,
      previous.guestRematches,
    )
      ? snapshot.guestRematches
      : previous.guestRematches;
    if (
      rematchSeriesEnded(previous) &&
      !rematchSeriesEnded({ hostRematches, guestRematches })
    ) {
      if (previous.hostRematches.endsWith("x")) hostRematches += "x";
      else guestRematches += "x";
    }
    this.value = {
      ...snapshot,
      guestId: previous.guestId ?? snapshot.guestId,
      hostRematches,
      guestRematches,
    };
    return true;
  }

  confirmRematches(actorUid: string, rematches: string): void {
    const field =
      actorUid === this.value.hostId
        ? "hostRematches"
        : actorUid === this.value.guestId
          ? "guestRematches"
          : null;
    if (!field) return;
    this.accept({ ...this.value, [field]: rematches });
    if (rematches.endsWith("x") && !rematchSeriesEnded(this.value)) {
      this.value = { ...this.value, [field]: `${this.value[field]}x` };
    }
  }
}
