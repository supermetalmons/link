export type RecoveryKeyObservation = {
  keyBytes: Uint8Array;
  keyType: "text" | "blob";
};

export type RecoveryFieldObservation = {
  storageType: "null" | "integer" | "real" | "text" | "blob";
  bytes: Uint8Array | null;
  realValue: number | null;
};

export type RecoveryRowObservation = RecoveryKeyObservation & {
  revisionHex: string;
  fields: RecoveryFieldObservation[];
};

export type RecoveryKeyRow = {
  recovery_key_bytes: unknown;
  recovery_key_type: unknown;
};

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (
    !Array.isArray(value) ||
    !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    throw new Error("recovery-observation-invalid");
  }
  return Uint8Array.from(value as number[]);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export function parseRecoveryKey(row: RecoveryKeyRow): RecoveryKeyObservation {
  if (row.recovery_key_type !== "text" && row.recovery_key_type !== "blob") {
    throw new Error("recovery-observation-invalid");
  }
  return {
    keyBytes: bytes(row.recovery_key_bytes),
    keyType: row.recovery_key_type,
  };
}

export function recoveryObservationColumns(
  expressions: readonly string[],
  revisionIndex: number,
): string {
  return [
    ...expressions.flatMap((expression, index) => [
      `typeof(${expression}) AS recovery_type_${index}`,
      `CAST(${expression} AS BLOB) AS recovery_bytes_${index}`,
      `CASE WHEN typeof(${expression}) = 'real' THEN ${expression} END AS recovery_real_${index}`,
    ]),
    `CASE WHEN typeof(${expressions[revisionIndex]}) = 'real'
     THEN CAST(CAST(${expressions[revisionIndex]} AS TEXT) AS BLOB) END AS recovery_revision_bytes`,
  ].join(", ");
}

export function parseRecoveryObservation(
  row: Record<string, unknown>,
  fieldNames: readonly string[],
  revisionIndex: number,
): { observation: RecoveryRowObservation; value: Record<string, unknown> } {
  const fields = fieldNames.map((_, index): RecoveryFieldObservation => {
    const storageType = row[`recovery_type_${index}`];
    if (storageType === "null") {
      return { storageType, bytes: null, realValue: null };
    }
    if (storageType === "real") {
      const realValue = row[`recovery_real_${index}`];
      const raw = bytes(row[`recovery_bytes_${index}`]);
      if (typeof realValue === "number" && Number.isFinite(realValue)) {
        return { storageType, bytes: raw, realValue };
      }
      const encoded = new TextDecoder().decode(raw);
      if (encoded !== "Inf" && encoded !== "-Inf") {
        throw new Error("recovery-observation-invalid");
      }
      return { storageType, bytes: raw, realValue: null };
    }
    if (
      storageType !== "integer" &&
      storageType !== "text" &&
      storageType !== "blob"
    ) {
      throw new Error("recovery-observation-invalid");
    }
    return {
      storageType,
      bytes: bytes(row[`recovery_bytes_${index}`]),
      realValue: null,
    };
  });
  const key = fields[0];
  const revision = fields[revisionIndex];
  if (
    !key?.bytes ||
    (key.storageType !== "text" && key.storageType !== "blob") ||
    !revision
  ) {
    throw new Error("recovery-observation-invalid");
  }
  const revisionBytes =
    revision.storageType === "real"
      ? bytes(row.recovery_revision_bytes)
      : revision.bytes;
  if (!revisionBytes) throw new Error("recovery-observation-invalid");
  const value = Object.fromEntries(
    fieldNames.map((name, index) => {
      const field = fields[index]!;
      const value =
        field.storageType === "null"
          ? null
          : field.storageType === "real"
            ? (field.realValue ??
              (new TextDecoder().decode(field.bytes!) === "Inf"
                ? Infinity
                : -Infinity))
            : field.storageType === "blob"
              ? field.bytes
              : field.storageType === "integer"
                ? Number(new TextDecoder().decode(field.bytes!))
                : new TextDecoder("utf-8", { ignoreBOM: true }).decode(
                    field.bytes!,
                  );
      return [name, value];
    }),
  );
  return {
    observation: {
      keyBytes: key.bytes,
      keyType: key.storageType,
      revisionHex: hex(revisionBytes),
      fields,
    },
    value,
  };
}

export function recoveryObservationGuard(
  expressions: readonly string[],
  observation: RecoveryRowObservation,
): { sql: string; bindings: Array<string | number | Uint8Array | null> } {
  if (expressions.length !== observation.fields.length) {
    throw new Error("recovery-observation-invalid");
  }
  return {
    sql: expressions
      .map(
        (expression, index) =>
          `typeof(${expression}) = ? AND ${observation.fields[index]!.storageType === "real" && observation.fields[index]!.realValue !== null ? expression : `CAST(${expression} AS BLOB)`} IS ?`,
      )
      .join(" AND "),
    bindings: observation.fields.flatMap((field) => [
      field.storageType,
      field.storageType === "real" && field.realValue !== null
        ? field.realValue
        : field.bytes,
    ]),
  };
}

export function recoveryKeyMatches(
  observation: RecoveryKeyObservation,
  key: unknown,
): key is string {
  if (typeof key !== "string" || observation.keyType !== "text") return false;
  const encoded = new TextEncoder().encode(key);
  return (
    encoded.length === observation.keyBytes.length &&
    encoded.every((byte, index) => byte === observation.keyBytes[index])
  );
}

export function recoveryKeyHex(observation: RecoveryKeyObservation): string {
  return hex(observation.keyBytes).toLowerCase();
}
