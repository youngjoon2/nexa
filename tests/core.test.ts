import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, lexicalQuery } from "../src/storage";
import { SerialGate, Providers } from "../src/providers";
import type { Config } from "../src/config";
import { search, validateAnswer, validateSearch } from "../src/retrieval";
import type { Chunk, Document, Hit, Source } from "../src/types";

let directory: string;
let store: Store;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nexa-core-test-"));
  store = new Store(join(directory, "index.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function source(id: string, board = "NX-A", revision = "A1"): Source {
  const value: Source = { id, name: id, kind: "folder", path: join(directory, id), board, revision, status: "ready" };
  store.addSource(value);
  return value;
}

function document(owner: Source, id: string, texts: string[], version = "v1"): { doc: Document; chunks: Chunk[] } {
  const path = join(owner.path, `${id}.c`);
  const doc: Document = { id, sourceId: owner.id, path, title: `${id}.c`, text: texts.join("\n"), hash: version, embedded: 1, board: owner.board, revision: owner.revision };
  const chunks: Chunk[] = texts.map((text, index) => ({
    id: `${id}-${version}-${index}`, documentId: id, sourceId: owner.id, path, title: doc.title,
    text, board: owner.board, revision: owner.revision, startLine: index + 1, endLine: index + 1,
  }));
  store.replaceDocument(doc, chunks);
  return { doc, chunks };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("SQLite source index", () => {
  test("FTS preserves underscores in exact register/function identifiers and safely handles query syntax", () => {
    const owner = source("firmware");
    const exact = document(owner, "uart", ["UART_CR = 0x40000000; uart_configure_clock(48000000);"]);
    document(owner, "separate", ["UART status uses CR flags. uart configure clock are separate words."]);
    expect(store.lexical({ query: "UART_CR" }).map((hit) => hit.id)).toEqual([exact.chunks[0]!.id]);
    expect(store.lexical({ query: "uart_configure_clock" }).map((hit) => hit.id)).toEqual([exact.chunks[0]!.id]);
    expect(() => store.lexical({ query: '"UART_CR") OR * --' })).not.toThrow();
    expect(store.lexical({ query: '" * () : -' })).toEqual([]);
    expect(lexicalQuery("UART_CR UART_CR")).toBe('"UART_CR"*');
  });

  test("board and revision filters apply to both keyword and hydrated vector hits", () => {
    const a1 = document(source("board-a1", "NX-A", "A1"), "a1", ["UART_CR baud 115200"]);
    const a2 = document(source("board-a2", "NX-A", "A2"), "a2", ["UART_CR baud 921600"]);
    const b1 = document(source("board-b1", "NX-B", "A1"), "b1", ["UART_CR baud 9600"]);
    expect(store.lexical({ query: "UART_CR" })).toHaveLength(3);
    expect(store.lexical({ query: "UART_CR", board: "NX-A" })).toHaveLength(2);
    const filtered = store.lexical({ query: "UART_CR", board: "NX-A", revision: "A2" });
    expect(filtered.map((hit) => hit.id)).toEqual([a2.chunks[0]!.id]);
    const ids = [...a1.chunks, ...a2.chunks, ...b1.chunks].map((chunk) => chunk.id);
    expect(store.hydrate(ids, { query: "anything", board: "NX-B", revision: "A1" }).map((chunk) => chunk.id)).toEqual([b1.chunks[0]!.id]);
    expect(store.hydrate(ids, { query: "anything", revision: "missing" })).toEqual([]);
    expect(store.hydrate([], { query: "anything" })).toEqual([]);
  });

  test("replacement removes stale FTS text and queues obsolete vectors without deleting retried current vectors", () => {
    const owner = source("replace");
    const old = document(owner, "driver", ["OLD_REGISTER = 1;", "OLD_CLOCK = 12;"], "old");
    const current = document(owner, "driver", ["NEW_REGISTER = 2;"], "new");
    expect(store.counts()).toEqual({ sources: 1, documents: 1, chunks: 1 });
    expect(store.lexical({ query: "OLD_REGISTER" })).toEqual([]);
    expect(store.lexical({ query: "NEW_REGISTER" }).map((hit) => hit.id)).toEqual([current.chunks[0]!.id]);
    expect(store.hydrate(old.chunks.map((chunk) => chunk.id), { query: "old" })).toEqual([]);
    expect(new Set(store.pendingDeletes().map((value) => value.id))).toEqual(new Set(old.chunks.map((chunk) => chunk.id)));
    store.replaceDocument(current.doc, current.chunks);
    expect(store.pendingDeletes().some((value) => value.id === current.chunks[0]!.id)).toBe(false);
    expect(store.lexical({ query: "NEW_REGISTER" })).toHaveLength(1);
    store.acknowledgeDeletes(old.chunks.map((chunk) => chunk.id));
    expect(store.pendingDeletes()).toEqual([]);
  });

  test("a failed replacement rolls back document deletion, FTS changes, and vector tombstones", () => {
    const initial = document(source("rollback"), "driver", ["UNCHANGED_REGISTER = 1;"]);
    const broken = { ...initial.doc, hash: "broken", text: "BAD_REGISTER" };
    const replacement = { ...initial.chunks[0]!, text: "BAD_REGISTER" };
    expect(() => store.replaceDocument(broken, [replacement, replacement])).toThrow();
    expect(store.document(initial.doc.id)?.hash).toBe(initial.doc.hash);
    expect(store.lexical({ query: "UNCHANGED_REGISTER" })).toHaveLength(1);
    expect(store.lexical({ query: "BAD_REGISTER" })).toEqual([]);
    expect(store.pendingDeletes()).toEqual([]);
  });

  test("source deletion cascades documents, chunks, FTS and jobs while retaining vector cleanup", () => {
    const owner = source("delete-me");
    const removed = document(owner, "driver", ["REMOVE_REGISTER = 1;", "REMOVE_CLOCK = 2;"]);
    const retained = document(source("keep-me"), "keep", ["KEEP_REGISTER = 3;"]);
    store.saveJob({ id: "job", sourceId: owner.id, status: "queued", processed: 0, total: 1, message: "queued", errors: [], createdAt: new Date().toISOString() });
    store.removeSource(owner.id);
    expect(store.source(owner.id)).toBeNull();
    expect(store.document(removed.doc.id)).toBeNull();
    expect(store.chunks(removed.doc.id)).toEqual([]);
    expect(store.lexical({ query: "REMOVE_REGISTER" })).toEqual([]);
    expect(store.jobs()).toEqual([]);
    expect(store.pendingJobs()).toEqual([]);
    expect(store.counts()).toEqual({ sources: 1, documents: 1, chunks: 1 });
    expect(store.lexical({ query: "KEEP_REGISTER" })[0]!.id).toBe(retained.chunks[0]!.id);
    expect(new Set(store.pendingDeletes().map((value) => value.id))).toEqual(new Set(removed.chunks.map((chunk) => chunk.id)));
  });
});

describe("retrieval and answer validation", () => {
  test("hybrid retrieval cannot revive deleted or out-of-filter vectors", async () => {
    const active = document(source("current", "NX-A", "A2"), "active", ["UART_CR = 7;"]);
    const unrelated = document(source("unrelated", "NX-B", "A1"), "unrelated", ["UART_CR = 8;"]);
    const obsolete = document(store.source("current")!, "obsolete", ["UART_CR = 9;"]);
    store.removeDocument(obsolete.doc.id);
    const fakeProviders = {
      embed: async () => [1],
      vectorSearch: async () => [
        { id: obsolete.chunks[0]!.id, score: 1 },
        { id: unrelated.chunks[0]!.id, score: 0.99 },
        { id: active.chunks[0]!.id, score: 0.95 },
      ],
    } as unknown as Providers;
    const result = await search(store, fakeProviders, { query: "UART_CR", board: "NX-A", revision: "A2" });
    expect(result.mode).toBe("hybrid");
    expect(result.hits.map((hit) => hit.id)).toEqual([active.chunks[0]!.id]);
    expect(result.hits[0]!.channels).toEqual(["keyword", "vector"]);
  });

  test("unavailable vector services still return keyword results with an explicit warning", async () => {
    document(source("keyword-only"), "driver", ["UART_CR = 4;"]);
    const fakeProviders = { embed: async () => { throw new Error("service unavailable"); } } as unknown as Providers;
    const result = await search(store, fakeProviders, { query: "UART_CR" });
    expect(result.mode).toBe("keyword");
    expect(result.hits).toHaveLength(1);
    expect(result.warnings[0]).toContain("키워드 검색만");
  });

  test("unknown or malformed citations are rejected before an answer is returned", () => {
    const hit = { id: "actual-chunk", text: "UART_CR = 1;", path: "board.c", startLine: 8, endLine: 8 } as Hit;
    const context = new Map([["D1", hit]]);
    for (const value of [
      { answerable: true, answer: "answer", citations: ["D2"] },
      { answerable: true, answer: "answer", citations: [1] },
      { answerable: true, answer: "answer", citations: "D1" },
      { answerable: "true", answer: "answer", citations: ["D1"] },
      null,
    ]) expect(() => validateAnswer(value, context)).toThrow();
    const valid = validateAnswer({ answerable: true, answer: " UART_CR는 1입니다. ", citations: ["D1", "D1"] }, context);
    expect(valid).toEqual({ answerable: true, answer: "UART_CR는 1입니다.", citations: [hit] });
  });

  test("unanswerable, empty, or unsupported answers become the standard no-evidence response", () => {
    const context = new Map([["D1", { id: "current" } as Hit]]);
    for (const value of [
      { answerable: false, answer: "invented claim", citations: [] },
      { answerable: false, answer: "invented claim", citations: ["D1"] },
      { answerable: true, answer: "invented claim", citations: [] },
      { answerable: true, answer: " \n", citations: ["D1"] },
    ]) expect(validateAnswer(value, context)).toEqual({ answerable: false, answer: "자료에서 확인할 수 없습니다.", citations: [] });
  });

  test("search validation rejects malformed boundaries and preserves explicit filters", () => {
    expect(validateSearch({ query: " UART_CR ", board: "NX-A", revision: "A1", limit: 4 })).toEqual({ query: "UART_CR", board: "NX-A", revision: "A1", limit: 4 });
    for (const body of [null, {}, { query: " " }, { query: "x".repeat(1201) }, { query: "ok", limit: 0 }, { query: "ok", limit: 31 }, { query: "ok", limit: 1.5 }, { query: "ok", board: 4 }]) {
      expect(() => validateSearch(body)).toThrow();
    }
  });
});

describe("bounded model queue", () => {
  test("enforces its limit and runs accepted work in arrival order", async () => {
    const gate = new SerialGate(2);
    const unblock = deferred<void>();
    const started = deferred<void>();
    const events: string[] = [];
    const first = gate.run(async () => { events.push("first-start"); started.resolve(); await unblock.promise; events.push("first-end"); return 1; });
    await started.promise;
    const second = gate.run(async () => { events.push("second"); return 2; });
    expect(gate.running).toBe(1);
    expect(gate.waiting).toBe(1);
    await expect(gate.run(async () => 3)).rejects.toMatchObject({ code: "QUEUE_FULL", status: 429 });
    expect(events).toEqual(["first-start"]);
    unblock.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
    expect(gate.running).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  test("failure releases the next waiter and leaves the queue reusable", async () => {
    const gate = new SerialGate(2);
    const unblock = deferred<void>();
    const started = deferred<void>();
    const first = gate.run(async () => { started.resolve(); await unblock.promise; throw new Error("model failed"); });
    const failure = first.then(() => null, (error: unknown) => error);
    await started.promise;
    const next = gate.run(async () => "recovered");
    unblock.resolve();
    expect(await failure).toMatchObject({ message: "model failed" });
    expect(await next).toBe("recovered");
    expect(gate.running).toBe(0);
    expect(gate.waiting).toBe(0);
    expect(await gate.run(async () => "still works")).toBe("still works");
  });
});

describe("local provider response validation", () => {
  test("an inconsistent tokenizer fails promptly and releases embedding capacity", async () => {
    const providers = new Providers({ mode: "full" } as Config);
    let requests = 0;
    providers.request = async () => { requests++; return { tokens: Array(2000).fill(1) }; };
    await expect(providers.embed("x")).rejects.toMatchObject({ code: "MODEL_RESPONSE", status: 502 });
    expect(requests).toBe(1);
    expect(providers.embeddingGate.running).toBe(0);
    expect(providers.embeddingGate.waiting).toBe(0);
    providers.request = async (_base, path) => path === "/tokenize" ? { tokens: [1] } : { data: [{ embedding: Array(768).fill(0.1) }] };
    expect(await providers.embed("working input")).toHaveLength(768);
  });

  test("malformed tokenizer and embedding responses are reported as provider errors", async () => {
    const providers = new Providers({ mode: "full" } as Config);
    providers.request = async () => null;
    await expect(providers.tokens("query", "generation")).rejects.toMatchObject({ code: "MODEL_RESPONSE", status: 502 });
    providers.request = async (_base, path) => path === "/tokenize" ? { tokens: [1] } : null;
    await expect(providers.embed("query")).rejects.toMatchObject({ code: "EMBEDDING_DIMENSION", status: 502 });
  });

  test("invalid vector responses cannot be mistaken for a successful empty search", async () => {
    const providers = new Providers({ mode: "full", collection: "test" } as Config);
    for (const response of [null, {}, { result: {} }, { result: { points: {} } }, { result: { points: [null] } }, { result: { points: [{ id: "chunk", score: "0.9" }] } }]) {
      providers.request = async () => response;
      await expect(providers.vectorSearch([1], { query: "UART" })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", status: 502 });
    }
    providers.request = async () => ({ result: { points: [] } });
    expect(await providers.vectorSearch([1], { query: "UART" })).toEqual([]);
    providers.request = async () => ({ result: { points: [{ id: 42, score: 0.9 }] } });
    expect(await providers.vectorSearch([1], { query: "UART" })).toEqual([{ id: "42", score: 0.9 }]);
  });
});
