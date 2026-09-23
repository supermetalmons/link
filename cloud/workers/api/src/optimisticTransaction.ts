type OptimisticDecision<T> =
  { commit: false; decision?: string } | { value: T; decision?: string };

type OptimisticResult<T> = {
  committed: boolean;
  decision?: string;
  value: T;
};

export async function runOptimisticTransaction<
  Snapshot,
  Value,
  Proposed,
>(input: {
  maxAttempts: number;
  signal?: AbortSignal;
  read: () => Promise<Snapshot>;
  getValue: (snapshot: Snapshot) => Value;
  decide: (current: Value) => OptimisticDecision<Proposed>;
  write: (
    current: Snapshot,
    value: Proposed,
  ) => Promise<{ applied: boolean; value: Value }>;
  conflictError: () => Error;
}): Promise<OptimisticResult<Value>> {
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    input.signal?.throwIfAborted();
    const current = await input.read();
    input.signal?.throwIfAborted();
    const value = input.getValue(current);
    const decision = input.decide(value);
    if ("commit" in decision) {
      return {
        committed: false,
        decision: decision.decision,
        value,
      };
    }
    const written = await input.write(current, decision.value);
    if (written.applied) {
      return {
        committed: true,
        decision: decision.decision,
        value: written.value,
      };
    }
  }
  throw input.conflictError();
}
