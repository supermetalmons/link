import type { Agent } from "undici";

type Transport = {
  agent: Agent;
  fetch: typeof import("undici").fetch;
};

export function createMigrationTransport() {
  const NativeResponse = Response;
  let transport: Promise<Transport> | undefined;
  const connect = () =>
    (transport ||= import("undici").then(({ Agent, fetch }) => ({
      agent: new Agent({ allowH2: false, connections: 16, pipelining: 1 }),
      fetch,
    })));
  return {
    async fetch(
      input: string | URL,
      init: RequestInit = {},
    ): Promise<Response> {
      if (init.body != null && typeof init.body !== "string")
        throw new TypeError(
          "migration transport requires a string request body",
        );
      const { agent, fetch } = await connect();
      const response = await fetch(String(input), {
        ...init,
        body: init.body,
        headers: Array.from(new Headers(init.headers)),
        dispatcher: agent,
      });
      return new NativeResponse(
        response.body as ReadableStream<Uint8Array> | null,
        {
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(response.headers),
        },
      );
    },
    async close(): Promise<void> {
      if (transport) await (await transport).agent.close();
    },
  };
}

const transport = createMigrationTransport();

export const migrationFetch = transport.fetch;
