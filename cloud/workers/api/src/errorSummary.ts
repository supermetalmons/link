export type ErrorSummary = {
  name?: string;
  message?: string;
  code?: string | number | boolean | null;
  type?: string;
  cause?: ErrorSummary;
  errors?: ErrorSummary[];
  truncated?: true;
  cycle?: true;
};

const MAX_DEPTH = 4;
const MAX_NODES = 8;
const MAX_STRING_LENGTH = 256;

export function summarizeError(error: unknown): ErrorSummary {
  const ancestors = new Set<Error>();
  let nodes = 0;

  const visit = (value: unknown, depth: number): ErrorSummary => {
    nodes++;
    const summary: ErrorSummary = {};
    let tracked: Error | undefined;
    try {
      if (!(value instanceof Error)) {
        return { type: value === null ? "null" : typeof value };
      }
      if (ancestors.has(value)) return { cycle: true };
      ancestors.add(value);
      tracked = value;
      const read = (target: object, key: PropertyKey): unknown => {
        try {
          return Reflect.get(target, key);
        } catch {
          summary.truncated = true;
          return undefined;
        }
      };
      const text = (input: string): string => {
        if (input.length > MAX_STRING_LENGTH) summary.truncated = true;
        return input.slice(0, MAX_STRING_LENGTH);
      };
      const name = read(value, "name");
      const message = read(value, "message");
      summary.name = typeof name === "string" ? text(name) : "Error";
      summary.message = typeof message === "string" ? text(message) : "";
      const code = read(value, "code");
      if (typeof code === "string") summary.code = text(code);
      else if (
        code === null ||
        typeof code === "boolean" ||
        (typeof code === "number" && Number.isFinite(code))
      ) {
        summary.code = code;
      }
      const child = (input: unknown): ErrorSummary | undefined => {
        if (depth >= MAX_DEPTH || nodes >= MAX_NODES) {
          summary.truncated = true;
          return undefined;
        }
        return visit(input, depth + 1);
      };
      const cause = read(value, "cause");
      if (cause !== undefined) {
        const nested = child(cause);
        if (nested) summary.cause = nested;
      }
      if (value instanceof AggregateError) {
        const errors = read(value, "errors");
        if (Array.isArray(errors)) {
          const length = read(errors, "length");
          if (
            typeof length === "number" &&
            Number.isSafeInteger(length) &&
            length >= 0
          ) {
            summary.errors = [];
            for (let index = 0; index < length; index++) {
              if (depth >= MAX_DEPTH || nodes >= MAX_NODES) {
                summary.truncated = true;
                break;
              }
              summary.errors.push(visit(read(errors, index), depth + 1));
            }
          } else {
            summary.truncated = true;
          }
        } else {
          summary.truncated = true;
        }
      }
    } catch {
      summary.type ??= typeof value;
      summary.truncated = true;
    } finally {
      if (tracked) ancestors.delete(tracked);
    }
    return summary;
  };

  return visit(error, 1);
}
