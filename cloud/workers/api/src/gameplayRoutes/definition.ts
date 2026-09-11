import { AuthApiFailure } from "../authErrors.ts";
import { readBoundedJson } from "../http.ts";
import type { GameplayRequestContext } from "./runtime.ts";

export type PreparedGameplayRoute = {
  body: Record<string, unknown>;
  execute(context: GameplayRequestContext): Promise<unknown>;
};

export type GameplayRoute = {
  path: string;
  readOnly: boolean;
  maxBodyBytes?: number;
  prepare(body: Record<string, unknown>): PreparedGameplayRoute;
};

export function defineGameplayRoute<
  Body extends Record<string, unknown>,
  Runtime,
>(definition: {
  path: string;
  readOnly: boolean;
  maxBodyBytes?: number;
  runtime(context: GameplayRequestContext): Runtime | Promise<Runtime>;
  parse(body: Record<string, unknown>): Body;
  handle(body: Body, runtime: Runtime): Promise<unknown>;
}): GameplayRoute {
  return {
    path: definition.path,
    readOnly: definition.readOnly,
    maxBodyBytes: definition.maxBodyBytes,
    prepare(value) {
      const body = definition.parse(value);
      return {
        body,
        async execute(context) {
          return definition.handle(body, await definition.runtime(context));
        },
      };
    },
  };
}

export function invalidRequest(): AuthApiFailure {
  return new AuthApiFailure(400, "invalid-argument", "invalid-request");
}

export function validateBody<Body>(
  body: Record<string, unknown>,
  validate: (value: unknown) => value is Body,
): Body & Record<string, unknown> {
  if (!validate(body)) throw invalidRequest();
  return body;
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function prepareGameplayRoute(
  request: Request,
  route: GameplayRoute,
): Promise<PreparedGameplayRoute> {
  let body: Record<string, unknown> | null;
  try {
    body = toRecord(await readBoundedJson(request, route.maxBodyBytes));
  } catch {
    throw invalidRequest();
  }
  if (!body) throw invalidRequest();
  return route.prepare(body);
}
