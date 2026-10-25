import type {
  ApiPathRequest,
  ApiPathResponse,
  GameplayPath,
} from "@mons/shared/api-contracts";
import { AuthApiFailure } from "../authErrors.ts";
import { readBoundedJson } from "../http.ts";
import type { GameplayRequestContext } from "./runtime.ts";
export type PreparedGameplayRoute<
  Body = ApiPathRequest<"POST", GameplayPath>,
  Result = ApiPathResponse<"POST", GameplayPath>,
> = {
  body: Body;
  execute(): Promise<Result>;
};

export type BoundGameplayRoute<
  Body = ApiPathRequest<"POST", GameplayPath>,
  Result = ApiPathResponse<"POST", GameplayPath>,
> = {
  maxBodyBytes?: number;
  beforeBody?: () => Promise<void>;
  prepare(body: Record<string, unknown>): PreparedGameplayRoute<Body, Result>;
};

type GameplayPostObserver = (
  env: Env,
  next: (env: Env) => Promise<Response>,
) => Promise<Response>;

export type GameplayRoute<Path extends GameplayPath = GameplayPath> = {
  path: Path;
  readOnly: boolean;
  observePost?: GameplayPostObserver;
  bindRequest(
    context: GameplayRequestContext,
  ): BoundGameplayRoute<
    ApiPathRequest<"POST", Path>,
    ApiPathResponse<"POST", Path>
  >;
};

type GameplayRequestRuntime<Runtime> = {
  beforeBody?: () => Promise<void>;
  runtime(): Runtime | Promise<Runtime>;
};

type GameplayRuntimeDefinition<Runtime> =
  | {
      runtime(context: GameplayRequestContext): Runtime | Promise<Runtime>;
      prepareRequest?: never;
    }
  | {
      runtime?: never;
      prepareRequest(
        context: GameplayRequestContext,
      ): GameplayRequestRuntime<Runtime>;
    };

export function defineGameplayRoute<
  const Path extends GameplayPath,
  Body extends Record<string, unknown> & ApiPathRequest<"POST", NoInfer<Path>>,
  Runtime,
>(
  definition: {
    path: Path;
    readOnly: boolean;
    maxBodyBytes?: number;
    observePost?: GameplayPostObserver;
    parse(body: Record<string, unknown>): Body;
    handle(
      body: Body,
      runtime: Runtime,
    ): Promise<ApiPathResponse<"POST", NoInfer<Path>>>;
  } & GameplayRuntimeDefinition<Runtime>,
): GameplayRoute<Path> {
  return {
    path: definition.path,
    readOnly: definition.readOnly,
    observePost: definition.observePost,
    bindRequest(context) {
      let preparedRequest: GameplayRequestRuntime<Runtime>;
      if (definition.prepareRequest) {
        preparedRequest = definition.prepareRequest(context);
      } else {
        const runtime = definition.runtime;
        preparedRequest = { runtime: () => runtime(context) };
      }
      return {
        maxBodyBytes: definition.maxBodyBytes,
        beforeBody: preparedRequest.beforeBody,
        prepare(value) {
          const body = definition.parse(value);
          return {
            body,
            async execute() {
              return definition.handle(body, await preparedRequest.runtime());
            },
          };
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
  route: BoundGameplayRoute,
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
