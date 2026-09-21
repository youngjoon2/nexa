import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { isExcludedDirectory, isSupportedFile, parseDocument, parseDocumentBytes, PARSER_PROFILE, type ParseOptions } from "../src/ingestion/index.ts";

const pandocPath = process.env.NEXA_TEST_PANDOC || resolve(import.meta.dir, "../.runtime/pandoc/pandoc.exe");
const treeSitterDir = resolve(import.meta.dir, "../vendor/tree-sitter");
const options: ParseOptions = { pdfToTextPath: "", treeSitterDir, pandocPath, maxFileBytes: 4 * 1024 * 1024 };
let temporaryDirectory: string;
beforeAll(async () => { temporaryDirectory = await mkdtemp(join(tmpdir(), "nexa-docx-test-")); });
afterAll(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Small real OOXML fixtures, including tracked changes that Markdown writers cannot express. */
function zip(entries: Record<string, string>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(text);
    const compressed = deflateRawSync(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(bytes), 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.reduce((total, part) => total + part.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text: string) => `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
const paragraph = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${run(text)}</w:p>`;
function docx(body: string): Uint8Array {
  return zip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    "word/styles.xml": `<w:styles xmlns:w="${ns}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`,
    "word/numbering.xml": `<w:numbering xmlns:w="${ns}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    "word/_rels/document.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://invalid.example/nexa-docx-no-fetch" TargetMode="External"/></Relationships>',
  });
}

describe("captured document bytes", () => {
  test("text parsing uses passed bytes and rejects size/type errors", async () => {
    const bytes = new TextEncoder().encode("# Captured revision\nUART_CR = 1;");
    const pending = parseDocumentBytes("missing/live/source.md", bytes, options);
    bytes.fill(0);
    expect((await pending).text).toContain("UART_CR = 1;");
    expect((await pending).title).toBe("Captured revision");
    await expect(parseDocumentBytes("bad.txt", new Uint8Array(20), { ...options, maxFileBytes: 10 })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(parseDocumentBytes("legacy.doc", new Uint8Array(20), options)).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
    expect(isSupportedFile("설계.DOCX")).toBe(true);
    expect(isExcludedDirectory("NODE_MODULES")).toBe(true);
    expect(PARSER_PROFILE).toContain("pandoc-3.11");
  });

  test("missing Pandoc has an actionable diagnostic and removes its temporary copy", async () => {
    const root = join(temporaryDirectory, "missing-tool");
    await expect(parseDocumentBytes("missing.docx", docx(paragraph("text")), { ...options, pandocPath: "" }, root)).rejects.toMatchObject({ code: "DOCX_UNAVAILABLE" });
    expect(await readdir(root)).toEqual([]);
  });

  test.skipIf(!existsSync(join(treeSitterDir, "web-tree-sitter.js")))("C and C++ chunks carry the matching function symbol", async () => {
    const c = await parseDocumentBytes("captured.c", new TextEncoder().encode("int uart_init(void) { return 0; }\n"), options);
    expect(c.chunks[0]).toMatchObject({ symbol: "uart_init", startLine: 1, endLine: 1 });
    const cpp = await parseDocumentBytes("captured.cpp", new TextEncoder().encode("namespace board { int uart_init() { return 0; } }\n"), options);
    expect(cpp.chunks[0]!.symbol).toBe("uart_init");
  });
});

describe.skipIf(!existsSync(pandocPath))("real Pandoc DOCX extraction", () => {
  test("Korean headings, paragraphs, lists and table cells have structural citations without invented pages", async () => {
    const row = (cells: string[], header = false) => `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${paragraph(cell)}</w:tc>`).join("")}</w:tr>`;
    const bytes = docx([
      paragraph("보드 설계", "Heading1"), paragraph("기본 설정은 한국어로 설명합니다."),
      paragraph("클럭 설정", "Heading2"), paragraph("입력 클럭은 24 MHz입니다."),
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run("UART 초기화 순서")}</w:p>`,
      `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${row(["레지스터", "설정값"], true)}${row(["UART_CR", "115200"])}${row(["SPI_CLK", "10 MHz"])}</w:tbl>`,
      paragraph("전원 설정", "Heading2"), paragraph("전원은 3.3 V입니다."),
      '<w:p><w:hyperlink r:id="rId3">' + run("외부 링크 표시문자") + '</w:hyperlink></w:p>',
    ].join(""));
    const root = join(temporaryDirectory, "structure");
    const parsed = await parseDocumentBytes("board.docx", bytes, options, root);
    expect(parsed.title).toBe("보드 설계");
    expect(parsed.text).toContain("기본 설정은 한국어");
    expect(parsed.text).toContain("UART 초기화 순서");
    expect(parsed.text).toContain("외부 링크 표시문자");
    expect(parsed.text).not.toContain("invalid.example");
    expect(parsed.chunks.find((chunk) => chunk.text.includes("24 MHz"))!.headingPath).toEqual(["보드 설계", "클럭 설정"]);
    expect(parsed.chunks.find((chunk) => chunk.text.includes("3.3 V"))!.headingPath).toEqual(["보드 설계", "전원 설정"]);
    const uart = parsed.chunks.find((chunk) => chunk.text.includes("UART_CR"))!;
    expect(uart).toMatchObject({ table: 1, headingPath: ["보드 설계", "클럭 설정"] });
    expect(uart.text).toContain("115200");
    expect(uart.blockId).toContain("row");
    expect(parsed.chunks.every((chunk) => chunk.blockId && chunk.page === undefined && chunk.startLine === undefined && chunk.endLine === undefined)).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  test("accepted tracked changes exclude deletions and include insertions", async () => {
    const bytes = docx(`<w:p>${run("Baud: ")}<w:del w:id="1" w:author="Test" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>9600_OLD</w:delText></w:r></w:del><w:ins w:id="2" w:author="Test" w:date="2026-01-01T00:00:00Z">${run("115200_NEW")}</w:ins></w:p>`);
    const parsed = await parseDocumentBytes("tracked.docx", bytes, options, join(temporaryDirectory, "tracked"));
    expect(parsed.text).toContain("115200_NEW");
    expect(parsed.text).not.toContain("9600_OLD");
  });

  test("binary parsing captures bytes before awaiting, keeps the source title, and leaves source files untouched", async () => {
    const root = join(temporaryDirectory, "immutable");
    await mkdir(root);
    const path = join(root, "working.docx");
    const bytes = docx(paragraph("CAPTURED_ORIGINAL"));
    await writeFile(path, bytes);
    const pending = parseDocumentBytes(path, bytes, options, root);
    bytes.fill(0);
    await writeFile(path, docx(paragraph("NEW_LIVE_REVISION")));
    const parsed = await pending;
    expect(parsed.title).toBe("working.docx");
    expect(parsed.text).toContain("CAPTURED_ORIGINAL");
    expect(parsed.text).not.toContain("NEW_LIVE_REVISION");
    expect((await parseDocument(path, options)).text).toContain("NEW_LIVE_REVISION");
    expect((await readFile(path)).length).toBeGreaterThan(0);
    expect(await readdir(root)).toEqual(["working.docx"]);
  });

  test("malformed, empty and excessively expanded documents fail with specific diagnostics and cleanup", async () => {
    const root = join(temporaryDirectory, "failures");
    await expect(parseDocumentBytes("broken.docx", new TextEncoder().encode("not a docx archive"), options, root)).rejects.toMatchObject({ code: "DOCX_FAILED" });
    await expect(parseDocumentBytes("empty.docx", docx(paragraph("")), options, root)).rejects.toMatchObject({ code: "EMPTY_DOCUMENT" });
    const expanded = docx(paragraph("A".repeat(1_200_000)));
    expect(expanded.length).toBeLessThan(32 * 1024);
    await expect(parseDocumentBytes("expanded.docx", expanded, { ...options, maxFileBytes: 32 * 1024 }, root)).rejects.toMatchObject({ code: "DOCX_OUTPUT_TOO_LARGE" });
    expect(await readdir(root)).toEqual([]);
  }, 30_000);
});
