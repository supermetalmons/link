# Shared browser, Worker, and Functions rules

`@mons/shared` is the canonical home for deterministic, side-effect-free rules
used by the React browser app, the Cloudflare API Worker, and Firebase
Functions.

The package lives inside `cloud/functions` so Firebase's existing source
boundary includes it automatically. The root app and Firebase Functions
consume it through local `file:` dependencies, while Worker source is compiled
through the root toolchain. No generated copy or publish step is required.

Keep shared modules:

- browser-safe CommonJS JavaScript with a matching `.d.ts` file;
- free of Firebase, DOM, storage, network, and process-specific behavior;
- split into direct subpath imports such as `@mons/shared/mining`;
- explicit about policy differences, such as local versus UTC mining dates or
  strict client versus tolerant server normalization.

React state, Worker bindings and queues, Firebase transactions, persistence,
logging, and other I/O stay in their runtime adapters. When a rule is needed by
multiple runtimes, add it here first and make each runtime delegate to it.
