import { registerHooks } from "node:module";

/** @type {import("node:module").ResolveHookSync} */
const resolveTypeScriptImport = (specifier, context, nextResolve) => {
  const parent = context.parentURL ? new URL(context.parentURL) : null;
  if (
    parent?.pathname.endsWith(".ts") &&
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.[^/]+$/.test(specifier)
  ) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
};

/** @param {import("node:module").RegisterHooksOptions} [options] */
export function registerTypeScriptTestHooks({ resolve, load } = {}) {
  return registerHooks({
    load,
    resolve(specifier, context, nextResolve) {
      if (!resolve) {
        return resolveTypeScriptImport(specifier, context, nextResolve);
      }
      return resolve(specifier, context, (nextSpecifier, nextContext) =>
        resolveTypeScriptImport(
          nextSpecifier,
          { ...context, ...nextContext },
          nextResolve,
        ),
      );
    },
  });
}
