import type { InviteMetadataSnapshot } from "@mons/shared/invite-metadata";
import {
  parseRematchIndices,
  type RematchSeries,
  rematchSeriesEnded,
} from "@mons/shared/rematches";

function extendsRematches(
  next: RematchSeries,
  previous: RematchSeries,
): boolean {
  const nextIndices = parseRematchIndices(next);
  const previousIndices = parseRematchIndices(previous);
  return previousIndices.every(
    (index, position) => nextIndices[position] === index,
  );
}

export class InviteMetadataState {
  private value: InviteMetadataSnapshot;

  constructor(snapshot: InviteMetadataSnapshot) {
    this.value = structuredClone(snapshot);
  }

  get snapshot(): InviteMetadataSnapshot {
    return structuredClone(this.value);
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
      if (previous.hostRematches.state === "ended")
        hostRematches = { ...hostRematches, state: "ended" };
      else guestRematches = { ...guestRematches, state: "ended" };
    }
    this.value = structuredClone({
      ...snapshot,
      guestId: previous.guestId ?? snapshot.guestId,
      hostRematches,
      guestRematches,
    });
    return true;
  }

  confirmRematches(actorUid: string, rematches: RematchSeries): void {
    const field =
      actorUid === this.value.hostId
        ? "hostRematches"
        : actorUid === this.value.guestId
          ? "guestRematches"
          : null;
    if (!field) return;
    this.accept({ ...this.value, [field]: rematches });
    if (rematches.state === "ended" && !rematchSeriesEnded(this.value)) {
      this.value = {
        ...this.value,
        [field]: { ...this.value[field], state: "ended" },
      };
    }
  }
}

export function rematchSeriesEqual(
  left: RematchSeries,
  right: RematchSeries,
): boolean {
  return (
    left.state === right.state &&
    left.indices.length === right.indices.length &&
    left.indices.every((index, position) => index === right.indices[position])
  );
}
