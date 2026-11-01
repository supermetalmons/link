import {
  ApplicationDataUnavailable,
  parseApplicationWriteContext,
} from "./applicationDataControl.ts";
import type { ApplicationAdmission } from "./applicationAdmissions.ts";

export const APPLICATION_ADMISSION_HEADER = "X-Mons-Internal-Admission";
export const APPLICATION_ROOM_RPC_ARITY = {
  readMetadata: 1,
  readWagers: 1,
  readMatches: 3,
  readCanonicalMatchRecord: 1,
  readCanonicalMatchRecords: 1,
  readCanonicalMatchPair: 1,
  createCanonicalMatch: 1,
  submitCanonicalMove: 1,
  surrenderCanonicalMatch: 1,
  startCanonicalMatchTimer: 1,
  claimCanonicalMatchTimer: 1,
  applyCanonicalMatchEventEffects: 2,
  notifyMatchesChanged: 2,
  notifyMetadataChanged: 1,
  notifySessionCommitted: 1,
  notifyWagersChanged: 1,
  publish: 2,
  registerPresentationSeeds: 2,
  getRegisteredPresentationSnapshot: 1,
  getFrozenPresentationSnapshot: 1,
  freezeRegisteredPresentations: 2,
  updatePresentation: 3,
} as const;

export function readApplicationRpcAdmission(
  value: unknown,
): ApplicationAdmission {
  const context = parseApplicationWriteContext(value);
  if (context.kind !== "business") throw new ApplicationDataUnavailable();
  return context;
}

export function readApplicationAdmissionHeader(
  request: Request,
): ApplicationAdmission {
  const value = request.headers.get(APPLICATION_ADMISSION_HEADER);
  if (!value || value.length > 1024) throw new ApplicationDataUnavailable();
  try {
    const parsed: unknown = JSON.parse(value);
    return readApplicationRpcAdmission(parsed);
  } catch {
    throw new ApplicationDataUnavailable();
  }
}

function isRoomMethod(
  property: PropertyKey,
): property is keyof typeof APPLICATION_ROOM_RPC_ARITY {
  return (
    typeof property === "string" &&
    Object.hasOwn(APPLICATION_ROOM_RPC_ARITY, property)
  );
}

export function propagateApplicationRoomAdmission(
  namespace: Env["INVITE_REACTIONS"],
  admission: () => ApplicationAdmission,
): Env["INVITE_REACTIONS"] {
  const wrapStub = (stub: ReturnType<Env["INVITE_REACTIONS"]["get"]>) =>
    new Proxy(stub, {
      get(target, property) {
        if (property === "fetch")
          return (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            request.headers.set(
              APPLICATION_ADMISSION_HEADER,
              JSON.stringify(admission()),
            );
            return target.fetch(request);
          };
        const method: unknown = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        if (isRoomMethod(property))
          return (...args: unknown[]): unknown => {
            const arity = APPLICATION_ROOM_RPC_ARITY[property];
            if (args.length > arity) throw new ApplicationDataUnavailable();
            const parameters = [...args];
            while (parameters.length < arity) parameters.push(undefined);
            const result: unknown = Reflect.apply(method, target, [
              ...parameters,
              admission(),
            ]);
            return result;
          };
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(method, target, args);
          return result;
        };
      },
    });
  return new Proxy(namespace, {
    get(target, property) {
      if (property === "get")
        return (
          id: DurableObjectId,
          options?: DurableObjectNamespaceGetDurableObjectOptions,
        ) => wrapStub(target.get(id, options));
      if (property === "getByName")
        return (
          name: string,
          options?: DurableObjectNamespaceGetDurableObjectOptions,
        ) => wrapStub(target.getByName(name, options));
      if (property === "jurisdiction")
        return (jurisdiction: DurableObjectJurisdiction) =>
          propagateApplicationRoomAdmission(
            target.jurisdiction(jurisdiction),
            admission,
          );
      const method: unknown = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(method, target, args);
        return result;
      };
    },
  });
}
