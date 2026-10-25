import type {
  EventEffect,
  EventMutation,
} from "../../../runtime/eventCommands.js";

type PersistenceMutation<Mutation> = Mutation extends { value: unknown }
  ? Omit<Mutation, "value"> & { value: unknown }
  : never;

export type EventPersistenceMutation = PersistenceMutation<EventMutation>;
export type EventPersistenceCommand =
  | EventPersistenceMutation
  | Exclude<
      EventEffect,
      {
        kind:
          | "invite"
          | "match-creation"
          | "match-timer-claim"
          | "match-terminal-timer";
      }
    >
  | PersistenceMutation<
      Extract<
        EventEffect,
        {
          kind:
            | "invite"
            | "match-creation"
            | "match-timer-claim"
            | "match-terminal-timer";
        }
      >
    >;
