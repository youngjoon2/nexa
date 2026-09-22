import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createApplication } from "../src/app";
import { loadConfig } from "../src/config";
import { AppError } from "../src/types";

let temporaryDirectory: string;
let runtime: ReturnType<typeof createApplication>;
let config: ReturnType<typeof loadConfig>;

async function idle() {
  const deadline = Date.now() + 10_000;
  while (runtime.indexer.state().queued || runtime.indexer.state().running) {
    if (Date.now() > deadline) throw new Error("Indexing did not finish within the test deadline.");
    await Bun.sleep(5);
  }
  // Allow scheduled empty pumps and deletion cleanup to settle before closing SQLite.
  await Bun.sleep(5);
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "nexa-api-test-"));
  config = loadConfig({
    NEXA_DATA_DIR: join(temporaryDirectory, "data"),
    NEXA_MODE: "keyword",
    NEXA_API_KEY: crypto.randomUUID(),
    NEXA_ADMIN_KEY: crypto.randomUUID(),
    NEXA_ALLOWED_ORIGINS: "https://approved-client.test",
  }, resolve(import.meta.dir, ".."));
  runtime = createApplication(config, { resume: false });
});

afterEach(async () => {
  await idle();
  runtime.indexer.stop();
  runtime.store.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function request(path: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    "x-nexa-admin-key": config.adminKey,
    ...extraHeaders,
  };
  let content: BodyInit | undefined;
  if (body instanceof FormData) content = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; content = JSON.stringify(body); }
  return runtime.app.request(path, { method, headers, body: content });
}

async function registerFolder(path: string) {
  const response = await request("/api/v1/sources/folder", "POST", { path, name: "Nexa test board", board: "NX-A", revision: "A2" });
  expect(response.status).toBe(201);
  const result = await response.json();
  expect(result.job.status).toBe("queued");
  await idle();
  expect(runtime.store.jobs()[0]!.status).toBe("completed");
  return result.source as { id: string; path: string; kind: string };
}

async function searchQuery(query: string, filters: Record<string, string> = {}) {
  const response = await request("/api/v1/search", "POST", { query, ...filters });
  expect(response.status).toBe(200);
  return response.json();
}

describe("HTTP API access control", () => {
  test("requires the API key and requires a separate administrator key for source mutations", async () => {
    const missing = await runtime.app.request("/api/v1/sources");
    expect(missing.status).toBe(401);
    expect((await missing.json()).error.code).toBe("UNAUTHORIZED");
    const wrong = await request("/api/v1/sources", "GET", undefined, { authorization: "Bearer incorrect" });
    expect(wrong.status).toBe(401);
    const read = await request("/api/v1/sources", "GET", undefined, { "x-nexa-admin-key": "" });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ sources: [] });
    const mutation = await request("/api/v1/sources/folder", "POST", { path: temporaryDirectory }, { "x-nexa-admin-key": "" });
    expect(mutation.status).toBe(403);
    expect((await mutation.json()).error.code).toBe("ADMIN_REQUIRED");
    const health = await request("/api/v1/health");
    expect(health.status).toBe(200);
    const status = await health.json();
    expect(status.mode).toBe("keyword");
    expect(status.status).toBe("degraded");
    expect(status.services.generation.ok).toBe(false);
  });

  test("rejects unapproved web origins while supporting allowed authenticated clients and preflight", async () => {
    const denied = await request("/api/v1/sources", "GET", undefined, { origin: "https://unapproved-client.test" });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("ORIGIN_DENIED");
    const allowed = await request("/api/v1/sources", "GET", undefined, { origin: "https://approved-client.test" });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://approved-client.test");
    const sameOrigin = await request("/api/v1/meta", "GET", undefined, { origin: "http://localhost" });
    expect(sameOrigin.status).toBe(200);
    const preflight = await runtime.app.request("/api/v1/sources", { method: "OPTIONS", headers: { origin: "https://approved-client.test", "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Nexa-Admin-Key");
  });

  test("reports malformed JSON, unsupported media types and oversized requests as client errors", async () => {
    const missingType = await runtime.app.request("/api/v1/search", {
      method: "POST", headers: { authorization: `Bearer ${config.apiKey}` }, body: "query=UART_CR",
    });
    expect(missingType.status).toBe(415);
    const invalid = await runtime.app.request("/api/v1/search", {
      method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: "{broken",
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("INVALID_JSON");
    const large = await request("/api/v1/search", "POST", { query: "x".repeat(70_000) });
    expect(large.status).toBe(413);
    expect((await large.json()).error.code).toBe("BODY_TOO_LARGE");
  });

  test("requires a JSON object and recognizes the exact JSON media type", async () => {
    for (const body of [null, [], "settings", 123, true]) {
      const response = await request("/api/v1/projects/default/versions", "POST", body);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_BODY");
    }
    for (const contentType of ["application/json-invalid", "text/plain; application/json"]) {
      const response = await runtime.app.request("/api/v1/search", {
        method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": contentType }, body: '{"query":"UART"}',
      });
      expect(response.status).toBe(415);
    }
    const response = await runtime.app.request("/api/v1/search", {
      method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "Application/JSON; charset=utf-8" }, body: '{"query":"UART"}',
    });
    expect(response.status).toBe(200);
  });
});

describe("folder indexing through the API", () => {
  test("registers and queues files, refreshes changed content, prunes deleted files, and leaves original files on source deletion", async () => {
    const folder = join(temporaryDirectory, "firmware");
    await mkdir(folder);
    const mainFile = join(folder, "uart.c");
    const deletedFile = join(folder, "legacy.txt");
    await writeFile(mainFile, "#define ORIGINAL_UART_CR 115200\nint uart_init(void) { return ORIGINAL_UART_CR; }\n");
    await writeFile(deletedFile, "LEGACY_PERIPHERAL clock is 12 MHz.\n");
    const source = await registerFolder(folder);
    const initial = await searchQuery("ORIGINAL_UART_CR", { board: "NX-A", revision: "A2" });
    expect(initial.mode).toBe("keyword");
    expect(initial.hits.length).toBeGreaterThan(0);
    expect(initial.hits[0].path).toBe("uart.c");
    expect(initial.hits[0].startLine).toBeGreaterThan(0);
    expect((await searchQuery("ORIGINAL_UART_CR", { revision: "A1" })).hits).toEqual([]);
    const oldChunkIds = initial.hits.map((hit: { id: string }) => hit.id);
    const documentId = initial.hits[0].documentId;
    const documentResponse = await request(`/api/v1/documents/${documentId}`);
    expect(documentResponse.status).toBe(200);
    const documentBody = await documentResponse.json();
    expect(documentBody.text).toContain("115200");
    expect(documentBody.hash).toBeUndefined();
    expect(documentBody.embedded).toBeUndefined();
    await writeFile(mainFile, "#define UPDATED_UART_CR 921600\nint uart_init(void) { return UPDATED_UART_CR; }\n");
    await rm(deletedFile);
    const reindex = await request(`/api/v1/sources/${source.id}/reindex`, "POST");
    expect(reindex.status).toBe(202);
    await idle();
    expect((await searchQuery("ORIGINAL_UART_CR")).hits).toEqual([]);
    expect((await searchQuery("LEGACY_PERIPHERAL")).hits).toEqual([]);
    expect((await searchQuery("UPDATED_UART_CR")).hits.length).toBeGreaterThan(0);
    expect(runtime.store.hydrate(oldChunkIds, { query: "old" })).toEqual([]);
    expect(runtime.store.counts().documents).toBe(1);
    const unanswered = await request("/api/v1/ask", "POST", { query: "ORIGINAL_UART_CR" });
    expect(unanswered.status).toBe(200);
    expect(await unanswered.json()).toMatchObject({ answerable: false, citations: [], answer: "The available sources do not answer this question." });
    // A valid current hit cannot produce a made-up successful AI answer in keyword mode.
    const disabledAnswer = await request("/api/v1/ask", "POST", { query: "UPDATED_UART_CR" });
    expect(disabledAnswer.status).toBe(503);
    expect((await disabledAnswer.json()).error.code).toBe("KEYWORD_MODE");
    const deletion = await request(`/api/v1/sources/${source.id}`, "DELETE");
    expect(deletion.status).toBe(200);
    expect(existsSync(folder)).toBe(true);
    expect(existsSync(mainFile)).toBe(true);
    expect((await searchQuery("UPDATED_UART_CR")).hits).toEqual([]);
    expect((await request(`/api/v1/documents/${documentId}`)).status).toBe(404);
  });

  test("removes old searchable content when a changed file becomes malformed", async () => {
    const folder = join(temporaryDirectory, "malformed-source");
    await mkdir(folder);
    const file = join(folder, "board.txt");
    await writeFile(file, "VALID_REGISTER = 42\n");
    const source = await registerFolder(folder);
    expect((await searchQuery("VALID_REGISTER")).hits).toHaveLength(1);
    await writeFile(file, new Uint8Array([0xc3, 0x28]));
    expect((await request(`/api/v1/sources/${source.id}/reindex`, "POST")).status).toBe(202);
    await idle();
    expect((await searchQuery("VALID_REGISTER")).hits).toEqual([]);
    expect(runtime.store.source(source.id)?.status).toBe("warning");
    expect(runtime.store.jobs()[0]!.errors.some((error) => error.includes("Invalid text encoding"))).toBe(true);
  });

  test("a missing source directory cannot keep serving stale indexed answers", async () => {
    const folder = join(temporaryDirectory, "removed-directory");
    await mkdir(folder);
    const file = join(folder, "registers.txt");
    await writeFile(file, "REMOVED_FOLDER_REGISTER = 42\n");
    const source = await registerFolder(folder);
    expect((await searchQuery("REMOVED_FOLDER_REGISTER")).hits).toHaveLength(1);
    await rm(file);
    await rm(folder, { recursive: true });
    expect((await request(`/api/v1/sources/${source.id}/reindex`, "POST")).status).toBe(202);
    await idle();
    expect((await searchQuery("REMOVED_FOLDER_REGISTER")).hits).toEqual([]);
  });

  test("rejects relative, protected and duplicate folder registrations", async () => {
    const relativePath = await request("/api/v1/sources/folder", "POST", { path: "../firmware" });
    expect(relativePath.status).toBe(400);
    expect((await relativePath.json()).error.code).toBe("INVALID_PATH");
    const protectedPath = await request("/api/v1/sources/folder", "POST", { path: config.dataDir });
    expect(protectedPath.status).toBe(400);
    expect((await protectedPath.json()).error.code).toBe("PROTECTED_PATH");
    const folder = join(temporaryDirectory, "duplicate");
    await mkdir(folder);
    await writeFile(join(folder, "readme.md"), "# Target Board\n");
    await registerFolder(folder);
    const duplicate = await request("/api/v1/sources/folder", "POST", { path: folder });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe("DUPLICATE_SOURCE");
    expect(runtime.store.sources()).toHaveLength(1);
  });
});

describe("managed uploads", () => {
  test("failed enqueue rolls back a new source, its settings and uploaded files", async () => {
    const enqueue = runtime.indexer.enqueue;
    runtime.indexer.enqueue = () => { throw new AppError("INDEX_QUEUE_FULL", "Queue filled during upload.", 429); };
    try {
      const form = new FormData();
      form.append("files", new File(["UART_CR = 115200\n"], "manual.txt"));
      const upload = await request("/api/v1/sources/upload", "POST", form);
      expect(upload.status).toBe(429);
      expect((await upload.json()).error.code).toBe("INDEX_QUEUE_FULL");
      expect(await readdir(join(config.dataDir, "uploads"))).toEqual([]);
      const folder = join(temporaryDirectory, "rejected-folder");
      await mkdir(folder);
      const registration = await request("/api/v1/sources/folder", "POST", { path: folder });
      expect(registration.status).toBe(429);
      expect(runtime.store.counts()).toEqual({ sources: 0, documents: 0, chunks: 0 });
      expect(runtime.store.jobs()).toEqual([]);
      expect(runtime.store.db.query("SELECT sourceId FROM kb_connections").all()).toEqual([]);
    } finally { runtime.indexer.enqueue = enqueue; }
  });

  test("uses the filename when an optional source name contains only spaces", async () => {
    const form = new FormData();
    form.append("files", new File(["UART_CR = 115200\n"], "manual.txt"));
    form.append("name", "   ");
    const response = await request("/api/v1/sources/upload", "POST", form);
    expect(response.status).toBe(201);
    expect((await response.json()).source.name).toBe("manual.txt");
  });

  test("indexes same-name uploads independently and deletes their owned directory with the source", async () => {
    const form = new FormData();
    form.append("files", new File(["# Uploaded Board\nUPLOAD_UART uses 115200 baud.\n"], "manual.md", { type: "text/markdown" }));
    form.append("files", new File(["# Uploaded Registers\nUPLOAD_SPI uses 10 MHz.\n"], "manual.md", { type: "text/markdown" }));
    form.append("name", "Uploaded specifications");
    form.append("board", "NX-U");
    form.append("revision", "B1");
    const response = await request("/api/v1/sources/upload", "POST", form);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.source.kind).toBe("upload");
    expect(relative(join(config.dataDir, "uploads"), body.source.path)).toBe(body.source.id);
    await idle();
    expect((await readdir(body.source.path)).sort()).toEqual(["001-manual.md", "002-manual.md"]);
    const result = await searchQuery("UPLOAD_UART", { board: "NX-U", revision: "B1" });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].path).toBe("001-manual.md");
    expect((await searchQuery("UPLOAD_SPI")).hits).toHaveLength(1);
    expect(runtime.store.counts().documents).toBe(2);
    const deletion = await request(`/api/v1/sources/${body.source.id}`, "DELETE");
    expect(deletion.status).toBe(200);
    expect(existsSync(body.source.path)).toBe(false);
    expect(runtime.store.counts()).toEqual({ sources: 0, documents: 0, chunks: 0 });
  });

  test("rejects Windows reserved names, path-like filenames, unsupported files, and empty files before creating a source", async () => {
    for (const name of ["CON.txt", "folder\\escape.txt", "stream:payload.txt", "NUL.md"]) {
      const form = new FormData();
      form.append("files", new File(["UART_CR = 1"], name));
      const response = await request("/api/v1/sources/upload", "POST", form);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_FILENAME");
    }
    for (const [name, content] of [["firmware.exe", "not supported"], ["empty.txt", ""]]) {
      const form = new FormData();
      form.append("files", new File([content!], name));
      const response = await request("/api/v1/sources/upload", "POST", form);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("UNSUPPORTED_FILE");
    }
    expect(runtime.store.counts()).toEqual({ sources: 0, documents: 0, chunks: 0 });
    expect(existsSync(join(config.dataDir, "uploads"))).toBe(false);
  });
});
