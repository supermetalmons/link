# Shared browser and backend rules

`@mons/shared` is the canonical home for deterministic, side-effect-free rules
used by the React browser app, the Cloudflare API Worker, and portable backend
modules.

The package lives inside `cloud/runtime` alongside portable backend modules.
Its TypeScript source lives in `cloud/runtime/src/shared/`. The root app and
backend modules consume generated CommonJS and declarations through local
`file:` dependencies, while Worker source is compiled through the root
toolchain. Existing direct subpath imports remain unchanged.

Edit the TypeScript source, run `npm run generate:runtime` from the repository
root, and commit the generated `.js` and `.d.ts` files with the source. Do not
edit generated files directly. `npm run watch:runtime` regenerates them during
development. `npm run check:runtime` lints and typechecks the source and fails
when generated output is stale, missing, or orphaned.

Keep shared modules:

- checked TypeScript compiled to browser-safe CommonJS and declarations;
- free of DOM, storage, network, and process-specific behavior;
- split into direct subpath imports such as `@mons/shared/mining`;
- explicit about policy differences, such as local versus UTC mining dates or
  strict client versus tolerant server normalization.

React state, Worker bindings and queues, database transactions, persistence,
logging, and other I/O stay in their runtime adapters. When a rule is needed by
multiple runtimes, add it here first and make each runtime delegate to it.
