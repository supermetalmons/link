export type StateRecord = {
  read(): Promise<unknown>;
  transaction(
    updater: (current: unknown) => unknown,
  ): Promise<{ committed: boolean; value: unknown }>;
};

export type EventStateRepository = {
  read(path: string): Promise<unknown>;
  set(path: string, value: unknown): Promise<void>;
  remove(path: string): Promise<void>;
  update(path: string, updates: Record<string, unknown>): Promise<void>;
  transaction(
    path: string,
    updater: (current: unknown) => unknown,
  ): Promise<{ committed: boolean; value: unknown }>;
};
