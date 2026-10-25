const ADMISSION_MAX_ATTEMPTS = 3;

type MaybePromise<T> = T | Promise<T>;

type TransportResult<T> =
  { succeeded: true; value: T } | { succeeded: false; error: unknown };

async function attemptTransport<T>(
  operation: () => Promise<T>,
): Promise<TransportResult<T>> {
  try {
    return { succeeded: true, value: await operation() };
  } catch (error) {
    return { succeeded: false, error };
  }
}

export async function runD1AdmissionAcquire<Write, Readback, Admission>({
  write,
  written,
  readback,
  confirmed,
  unconfirmed,
}: {
  write: () => Promise<Write>;
  written: (result: Write) => MaybePromise<Admission | null>;
  readback: () => Promise<Readback>;
  confirmed: (
    result: Readback,
    writeFailed: boolean,
  ) => MaybePromise<Admission | null>;
  unconfirmed: (cause: unknown) => Error;
}): Promise<Admission> {
  let failure: unknown;
  for (let attempt = 0; attempt < ADMISSION_MAX_ATTEMPTS; attempt++) {
    const writeResult = await attemptTransport(write);
    if (writeResult.succeeded) {
      const admission = await written(writeResult.value);
      if (admission !== null) return admission;
    } else {
      failure = writeResult.error;
    }
    const readbackResult = await attemptTransport(readback);
    if (readbackResult.succeeded) {
      const admission = await confirmed(
        readbackResult.value,
        !writeResult.succeeded,
      );
      if (admission !== null) return admission;
    } else {
      failure = readbackResult.error;
    }
  }
  throw unconfirmed(failure);
}

export async function runD1AdmissionRelease(
  release: () => Promise<unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < ADMISSION_MAX_ATTEMPTS; attempt++) {
    try {
      await release();
      return;
    } catch (error) {
      if (attempt === ADMISSION_MAX_ATTEMPTS - 1) throw error;
    }
  }
}
