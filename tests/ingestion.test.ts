import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chunkText, discoverFiles, isSupportedFile, parseDocument, ParseDocumentError, type ParseOptions } from "../src/ingestion/index.ts";

let temporaryDirectory: string;
const treeSitterDir = process.env.NEXA_TEST_TREE_SITTER_DIR || resolve(import.meta.dir, "../vendor/tree-sitter");
const pdfToTextPath = process.env.NEXA_TEST_PDFTOTEXT || resolve(import.meta.dir, "../.runtime/poppler/Library/bin/pdftotext.exe");
let options: ParseOptions;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "nexa-ingestion-test-"));
  options = { treeSitterDir: join(temporaryDirectory, "missing-parser"), pdfToTextPath: "", maxFileBytes: 1024 * 1024 };
});
afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function fixture(name: string, text: string | Uint8Array): Promise<string> {
  const path = join(temporaryDirectory, name);
  await writeFile(path, text);
  return path;
}

describe("line-aware chunking", () => {
  test("every source line remains searchable and references match the original lines", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `REG_${i.toString().padStart(3, "0")} = 0x${i.toString(16)}; // peripheral configuration`);
    const chunks = chunkText(lines.join("\n"));
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      const source = lines.slice(chunk.startLine! - 1, chunk.endLine!).join("\n");
      expect(chunk.text.replace(/\n$/, "")).toBe(source);
      expect(chunk.text.length).toBeLessThanOrEqual(1800);
    }
    for (const line of lines) expect(chunks.some((chunk) => chunk.text.includes(line))).toBe(true);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine! - 1);
  });

  test("long single lines split without losing characters or misreporting their line", () => {
    const source = `${"A".repeat(4500)}\nREGISTER_END\n`;
    const chunks = chunkText(source, 11);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(source);
    expect(chunks.every((chunk) => chunk.text.length <= 1800)).toBe(true);
    expect(chunks[0]!.startLine).toBe(11);
    expect(chunks[0]!.endLine).toBe(11);
    expect(chunks[chunks.length - 1]!.endLine).toBe(12);
  });

  test("Korean paragraphs use smaller chunks and never split surrogate pairs", () => {
    const source = "보드의 클럭과 레지스터를 확인합니다.😀".repeat(150);
    const chunks = chunkText(source);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(source);
    expect(chunks.every((chunk) => chunk.text.length <= 700)).toBe(true);
    for (const chunk of chunks) {
      expect(/[\uD800-\uDBFF]$/.test(chunk.text)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk.text)).toBe(false);
    }
    const multiline = Array.from({ length: 40 }, () => "클럭 주파수와 레지스터 설정을 확인합니다.".repeat(8)).join("\n");
    expect(chunkText(multiline).every((chunk) => chunk.text.length <= 700)).toBe(true);
  });
});

describe("text and source parsing", () => {
  test("BOM-marked UTF-8 and UTF-16 decode with stable line numbers", async () => {
    const expected = "첫 줄\n둘째 줄\n";
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(expected.replace(/\n/g, "\r\n"))]);
    const utf16le = new Uint8Array([0xff, 0xfe, ...Buffer.from(expected, "utf16le")]);
    const body = Buffer.from(expected, "utf16le");
    body.swap16();
    const utf16be = new Uint8Array([0xfe, 0xff, ...body]);
    for (const [name, bytes] of [["utf8.txt", utf8], ["utf16le.txt", utf16le], ["utf16be.txt", utf16be]] as const) {
      const parsed = await parseDocument(await fixture(name, bytes), options);
      expect(parsed.text).toBe(expected);
      expect(parsed.chunks[0]!.startLine).toBe(1);
      expect(parsed.chunks[0]!.endLine).toBe(2);
    }
  });

  test("invalid encoding, binary data, empty content and oversized inputs fail transparently", async () => {
    const cases: [string, string | Uint8Array, string][] = [
      ["invalid.txt", new Uint8Array([0xc3, 0x28]), "INVALID_ENCODING"],
      ["odd-utf16.txt", new Uint8Array([0xff, 0xfe, 0x41]), "INVALID_ENCODING"],
      ["binary.txt", new Uint8Array([65, 0, 66]), "BINARY_FILE"],
      ["empty.txt", " \n\t", "EMPTY_DOCUMENT"],
    ];
    for (const [name, bytes, code] of cases) {
      await expect(parseDocument(await fixture(name, bytes), options)).rejects.toMatchObject({ name: "ParseDocumentError", code });
    }
    await expect(parseDocument(await fixture("large.txt", "a".repeat(20)), { ...options, maxFileBytes: 10 })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(parseDocument(await fixture("firmware.bin", "binary"), options)).rejects.toBeInstanceOf(ParseDocumentError);
  });

  test("fallback preserves macros, structures, globals, and complete function source", async () => {
    const text = "#define UART_BASE 0x40000000\nstruct Config { int baud; };\nvolatile int UART_CR;\n\nint uart_init(void) {\n  UART_CR = 1;\n  return 0;\n}\n\nint AFTER_FUNCTION = 2;\n";
    const parsed = await parseDocument(await fixture("board.c", text), options);
    expect(parsed.warnings[0]).toContain("syntax parser unavailable");
    expect(parsed.text).toBe(text);
    expect(parsed.chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(parsed.chunks[0]!.startLine).toBe(1);
    expect(parsed.chunks[0]!.endLine).toBe(10);
  });

  test("Markdown title comes from a level-one heading", async () => {
    const parsed = await parseDocument(await fixture("board.md", "# Nexa Target Board\n\nUART uses 115200 baud."), options);
    expect(parsed.title).toBe("Nexa Target Board");
  });

  test.skipIf(!existsSync(join(treeSitterDir, "web-tree-sitter.js")))("real C/C++ syntax trees separate functions and retain declarations between them", async () => {
    const source = "#define UART_BASE 0x40000000\nstruct Config { int baud; };\nint first(void) {\n  return 1;\n}\nvolatile int GLOBAL_REGISTER;\nint second(void) { return GLOBAL_REGISTER; }\n#define TAIL 7\n";
    const parsed = await parseDocument(await fixture("ast.c", source), { ...options, treeSitterDir });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.chunks.map((chunk) => chunk.text).join("")).toBe(source);
    expect(parsed.chunks.find((chunk) => chunk.text.startsWith("int first"))).toMatchObject({ startLine: 3, endLine: 5 });
    expect(parsed.chunks.find((chunk) => chunk.text.includes("volatile int"))).toMatchObject({ startLine: 6, endLine: 6 });
    expect(parsed.chunks.some((chunk) => chunk.text.includes("#define TAIL 7"))).toBe(true);
    const invalid = await parseDocument(await fixture("broken.cpp", "int main( {\nINVALID\n"), { ...options, treeSitterDir });
    expect(invalid.warnings[0]).toContain("source could not be parsed");
    expect(invalid.chunks[0]!.text).toBe(invalid.text);
  });
});

describe("file discovery", () => {
  test("includes supported source names and excludes dependency/build directories", async () => {
    const root = join(temporaryDirectory, "discovery");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "src", "board.dtsi"), "board {};");
    await writeFile(join(root, "Makefile"), "all: build");
    await writeFile(join(root, "firmware.bin"), "excluded");
    await writeFile(join(root, "node_modules", "ignored.js"), "excluded");
    await writeFile(join(root, ".git", "ignored.txt"), "excluded");
    const result = await discoverFiles(root);
    expect(result.files).toEqual([join(root, "Makefile"), join(root, "src", "board.dtsi")].sort());
    expect(result.warnings).toEqual([]);
    expect(isSupportedFile("CMakeLists.txt")).toBe(true);
    expect(isSupportedFile("FIRMWARE.CPP")).toBe(true);
    expect(isSupportedFile("firmware.exe")).toBe(false);
  });

  test("hitting the file cap produces an explicit incomplete-discovery warning", async () => {
    const root = join(temporaryDirectory, "capped");
    await mkdir(root);
    await writeFile(join(root, "a.txt"), "A");
    await writeFile(join(root, "b.txt"), "B");
    const result = await discoverFiles(root, { maxFiles: 1 });
    expect(result.files).toHaveLength(1);
    expect(result.warnings[0]).toContain("Additional supported files were not indexed");
    expect((await discoverFiles(root, { maxFiles: 2 })).warnings).toEqual([]);
  });

  test("does not follow symbolic directories or Windows junctions outside the root", async () => {
    const root = join(temporaryDirectory, "links");
    const outside = join(temporaryDirectory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "must not index");
    await symlink(outside, join(root, "redirect"), process.platform === "win32" ? "junction" : "dir");
    const result = await discoverFiles(root);
    expect(result.files).toEqual([]);
    expect(result.warnings[0]).toContain("symbolic link or junction");
    await expect(discoverFiles(join(root, "redirect"))).rejects.toThrow("regular directory");
  });
});

function pdfFixture(pageContents: string[]): Uint8Array {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const pageReferences: string[] = [];
  for (const content of pageContents) {
    const pageId = objects.length + 1;
    const streamId = pageId + 1;
    pageReferences.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${streamId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pageContents.length} /Kids [${pageReferences.join(" ")}] >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe("text PDF extraction", () => {
  test("missing Poppler has an actionable diagnostic", async () => {
    const path = await fixture("missing-poppler.pdf", pdfFixture([""]));
    await expect(parseDocument(path, options)).rejects.toMatchObject({ code: "PDF_UNAVAILABLE" });
  });

  test.skipIf(!pdfToTextPath || !existsSync(pdfToTextPath))("real Poppler preserves page numbers and rejects PDFs requiring OCR", async () => {
    const path = await fixture("pages.pdf", pdfFixture([
      "BT /F1 16 Tf 30 350 Td (UART baud is 115200.) Tj ET",
      "BT /F1 16 Tf 30 350 Td (SPI frequency is 10 MHz.) Tj ET",
    ]));
    const parsed = await parseDocument(path, { ...options, pdfToTextPath });
    expect(parsed.chunks).toHaveLength(2);
    expect(parsed.chunks[0]).toMatchObject({ page: 1 });
    expect(parsed.chunks[0]!.text).toContain("115200");
    expect(parsed.chunks[1]).toMatchObject({ page: 2 });
    expect(parsed.chunks[1]!.text).toContain("10 MHz");
    expect(parsed.chunks[0]!.startLine).toBeUndefined();
    const empty = await fixture("scanned.pdf", pdfFixture([""]));
    await expect(parseDocument(empty, { ...options, pdfToTextPath })).rejects.toThrow("need OCR");
    const malformed = await fixture("broken.pdf", "%PDF-1.4\nnot an actual PDF");
    await expect(parseDocument(malformed, { ...options, pdfToTextPath })).rejects.toMatchObject({ code: "PDF_FAILED" });
  });
});
