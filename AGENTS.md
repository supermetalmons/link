Avoid code comments except for TODOs or essential context.

Use the routine release path in `scripts/deploy-cloudflare.md` by default. Prepare validation and candidate uploads first, then keep production promotion and live verification within a 60-second budget. Do not add fixed waits, write freezes, Queue pauses, or extended monitoring to ordinary code, UI, or prize-catalog releases. Use coordinated maintenance only for a concrete schema, state-compatibility, resource-lifecycle, or incident requirement, and explain that requirement before applying its controls.
