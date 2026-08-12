import { ProviderFailure } from "./provider.ts";

export async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  createLimitError: () => Error,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw createLimitError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
}

export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

export async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await cancelResponseBody(response);
      throw new ProviderFailure("unavailable");
    }
  }
  if (!response.body) {
    throw new ProviderFailure("unavailable");
  }
  return JSON.parse(
    await readBoundedText(
      response.body,
      maxBytes,
      () => new ProviderFailure("unavailable"),
    ),
  ) as unknown;
}
