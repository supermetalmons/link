import { handleRequest } from "./router.ts";

export {
  extractIdFromJsonUri,
  PRIMARY_COLLECTION_ID,
  SPECIALS_COLLECTION_ID,
} from "./helius.ts";
export type { ProviderFetch } from "./provider.ts";
export { handleRequest };

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
