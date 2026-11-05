import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  build,
  createServer,
  preview,
  type ViteDevServer,
  type PreviewServer,
} from "vite";
import { boardShellHtml } from "./board-shell-html.ts";
import {
  eventSocialMetadata,
  withEventSocialImages,
} from "./event-social-metadata.ts";

const rootHtml = await readFile(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const assertEventImages = (html: string) => {
  assert.match(html, /https:\/\/mons\.link\/event-og-card-v1\.jpg/);
  assert.match(html, /https:\/\/mons\.link\/event-twitter-card-v1\.jpg/);
  assert.match(html, /property="og:image:type" content="image\/jpeg"/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.equal((html.match(/property="og:image"/g) ?? []).length, 1);
  assert.equal((html.match(/name="twitter:image"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /https:\/\/mons\.link\/(?:og|twitter)-card\.png/);
};

test("event metadata replaces only images and supplies accessible JPEG metadata", () => {
  const eventHtml = withEventSocialImages(rootHtml);
  assertEventImages(eventHtml);
  assert.match(
    eventHtml,
    /property="og:image:alt" content="Blue Mons character/,
  );
  assert.match(
    eventHtml,
    /name="twitter:image:alt" content="Blue Mons character/,
  );
  const withoutImageTags = (html: string) =>
    html
      .replace(/<meta\b[^>]*(?:og:image|twitter:image)[^>]*>/g, "")
      .replace(/\s+/g, " ");
  assert.equal(withoutImageTags(eventHtml), withoutImageTags(rootHtml));
  assert.throws(
    () => withEventSocialImages("<html><head></head><body></body></html>"),
    /missing social image metadata/,
  );
});

test(
  "built, development, and preview event pages preserve the app and other routes",
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "mons-event-social-"));
    let development: ViteDevServer | undefined,
      productionPreview: PreviewServer | undefined;
    t.after(async () => {
      for (const server of [
        development?.httpServer,
        productionPreview?.httpServer,
      ]) {
        if (server && "closeAllConnections" in server)
          server.closeAllConnections();
      }
      await Promise.all([development?.close(), productionPreview?.close()]);
      await rm(directory, { recursive: true, force: true });
    });
    await mkdir(join(directory, "public"));
    await writeFile(
      join(directory, "index.html"),
      rootHtml
        .replace("%VITE_APP_TITLE%", "Mons metadata fixture")
        .replace("/src/bootstrap.ts", "/main.js"),
    );
    await writeFile(
      join(directory, "main.js"),
      "document.getElementById('root').textContent = 'Mons fixture';",
    );
    const redirects = await readFile(
      new URL("../public/_redirects", import.meta.url),
      "utf8",
    );
    await writeFile(join(directory, "public", "_redirects"), redirects);
    const configuration = {
      root: directory,
      configFile: false as const,
      logLevel: "silent" as const,
      plugins: [boardShellHtml(), eventSocialMetadata()],
      build: { outDir: "build" },
    };
    await build(configuration);
    const builtRoot = await readFile(
      join(directory, "build/index.html"),
      "utf8",
    );
    const builtEvent = await readFile(
      join(directory, "build/_social/event.html"),
      "utf8",
    );
    assertEventImages(builtEvent);
    assert.match(builtRoot, /<svg id="board-backdrop"/);
    assert.match(builtRoot, /https:\/\/mons\.link\/og-card\.png/);
    assert.match(builtEvent, /src="\/assets\/[^" ]+\.js"/);
    assert.equal(builtEvent, withEventSocialImages(builtRoot));
    assert.equal(
      await readFile(join(directory, "build/_redirects"), "utf8"),
      "/event/* /_social/event 200\n",
    );

    development = await createServer({
      ...configuration,
      server: { port: 0, host: "127.0.0.1" },
    });
    await development.listen();
    productionPreview = await preview({
      ...configuration,
      preview: { port: 0, host: "127.0.0.1" },
    });
    for (const server of [development, productionPreview]) {
      const origin = server.resolvedUrls?.local[0];
      assert.ok(origin);
      for (const path of [
        "event/test-id",
        "event/test-id?source=shared",
        "event/test-id/",
        "event/encoded%2Fid",
        "",
        "event",
        "exact-match?event=test-id",
        "watch?event=test-id",
        "snapshot/test-id?event=test-id",
      ]) {
        const response: Response = await fetch(new URL(path, origin), {
          redirect: "manual",
          signal: t.signal,
        });
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get("location"), null, path);
        const html = await response.text();
        assert.match(html, /<svg id="board-backdrop"/);
        if (path.startsWith("event/")) {
          assertEventImages(html);
        } else {
          assert.match(html, /https:\/\/mons\.link\/og-card\.png/);
          assert.doesNotMatch(html, /event-og-card-v1/);
        }
      }
    }
  },
);
