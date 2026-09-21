import { basename, dirname } from "node:path";
import { chunkText, ParseDocumentError, type ParsedChunk, type ParsedDocument, type ParseOptions } from "./index.ts";

type Node = { t: string; c?: unknown };
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const node = (value: unknown): Node => value !== null && typeof value === "object" && "t" in value ? value as Node : { t: "" };

async function boundedRead(stream: ReadableStream<Uint8Array>, maxBytes: number, kill: () => void): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        kill();
        throw new ParseDocumentError("DOCX_OUTPUT_TOO_LARGE", `DOCX extraction exceeded the ${maxBytes} byte output limit.`);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** The only DOCX process entry point: no filters, media extraction, or resource fetching. */
export async function parseDocx(filePath: string, options: ParseOptions): Promise<ParsedDocument> {
  if (!options.pandocPath) throw new ParseDocumentError("DOCX_UNAVAILABLE", "Pandoc is not configured. Run setup to install the pinned Pandoc runtime for DOCX indexing.");
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([
      options.pandocPath, "--sandbox", "--from=docx", "--to=json", "--track-changes=accept", filePath,
    ], { cwd: dirname(filePath), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  } catch (error) {
    throw new ParseDocumentError("DOCX_UNAVAILABLE", `Could not start Pandoc: ${error instanceof Error ? error.message : String(error)}`);
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
  try {
    const maxOutput = Math.min(64 * 1024 * 1024, Math.max(options.maxFileBytes * 8, 1024 * 1024));
    const results = await Promise.allSettled([
      boundedRead(child.stdout as ReadableStream<Uint8Array>, maxOutput, () => child.kill()),
      boundedRead(child.stderr as ReadableStream<Uint8Array>, 64 * 1024, () => child.kill()),
      child.exited,
    ]);
    if (timedOut) throw new ParseDocumentError("DOCX_TIMEOUT", "DOCX extraction timed out after 30 seconds.");
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    const output = (results[0] as PromiseFulfilledResult<Uint8Array>).value;
    const stderr = new TextDecoder().decode((results[1] as PromiseFulfilledResult<Uint8Array>).value).trim();
    const exitCode = (results[2] as PromiseFulfilledResult<number>).value;
    if (exitCode !== 0) throw new ParseDocumentError("DOCX_FAILED", `DOCX extraction failed (${exitCode}): ${stderr || "The document may be malformed or encrypted."}`);
    let ast: unknown;
    try { ast = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output)); }
    catch { throw new ParseDocumentError("DOCX_INVALID_OUTPUT", "Pandoc returned invalid JSON or text encoding."); }
    return parseStructure(ast, basename(filePath), stderr ? [`Pandoc: ${stderr}`] : []);
  } finally {
    clearTimeout(timer);
  }
}

/** Pandoc's typed JSON has block positions, not Word layout page numbers. */
function parseStructure(ast: unknown, fallbackTitle: string, warnings: string[]): ParsedDocument {
  if (!ast || typeof ast !== "object" || !("blocks" in ast) || !Array.isArray(ast.blocks)) {
    throw new ParseDocumentError("DOCX_INVALID_OUTPUT", "Pandoc output does not contain a document block list.");
  }
  const chunks: ParsedChunk[] = [];
  const texts: string[] = [];
  const headings: { level: number; text: string }[] = [];
  const skipped = new Set<string>();
  let imageSeen = false;
  let tableCount = 0;
  let title = "";
  let visits = 0;
  function guard(depth: number): void {
    if (depth > 64 || ++visits > 500_000) throw new ParseDocumentError("DOCX_STRUCTURE_TOO_LARGE", "DOCX structure exceeds the nesting or element limit.");
  }
  function inlineText(values: unknown, depth = 0): string {
    guard(depth);
    return array(values).map((value) => {
      const current = node(value);
      const c = array(current.c);
      switch (current.t) {
        case "Str": return typeof current.c === "string" ? current.c : "";
        case "Space": case "SoftBreak": return " ";
        case "LineBreak": return "\n";
        case "Code": case "Math": return typeof c[1] === "string" ? c[1] : "";
        case "Emph": case "Underline": case "Strong": case "Strikeout":
        case "Superscript": case "Subscript": case "SmallCaps": return inlineText(current.c, depth + 1);
        case "Quoted": case "Cite": case "Span": case "Link": return inlineText(c[1], depth + 1);
        case "Image": imageSeen = true; return inlineText(c[1], depth + 1);
        case "Note": return ` [${blockText(current.c, depth + 1)}]`;
        default: if (current.t) skipped.add(current.t); return "";
      }
    }).join("");
  }
  function tableRows(contents: unknown[]): { head: unknown[]; body: unknown[] } {
    const head = array(array(contents[3])[1]);
    const body = array(contents[4]).flatMap((item) => {
      const section = array(item);
      return [...array(section[2]), ...array(section[3])];
    });
    body.push(...array(array(contents[5])[1]));
    return { head, body };
  }
  function rowText(row: unknown, depth: number): string {
    return array(array(row)[1]).map((cell) => blockText(array(cell)[4], depth + 1).trim()).join(" | ");
  }
  function blockText(values: unknown, depth = 0): string {
    guard(depth);
    return array(values).map((value) => {
      const current = node(value);
      const c = array(current.c);
      switch (current.t) {
        case "Para": case "Plain": return inlineText(current.c, depth + 1);
        case "Header": return inlineText(c[2], depth + 1);
        case "LineBlock": return c.map((line) => inlineText(line, depth + 1)).join("\n");
        case "CodeBlock": return typeof c[1] === "string" ? c[1] : "";
        case "BlockQuote": return blockText(current.c, depth + 1);
        case "Div": return blockText(c[1], depth + 1);
        case "BulletList": return c.map((item) => `- ${blockText(item, depth + 1)}`).join("\n");
        case "OrderedList": return array(c[1]).map((item, i) => `${Number(array(c[0])[0] || 1) + i}. ${blockText(item, depth + 1)}`).join("\n");
        case "DefinitionList": return c.map((item) => `${inlineText(array(item)[0], depth + 1)}: ${array(array(item)[1]).map((definition) => blockText(definition, depth + 1)).join("; ")}`).join("\n");
        case "Figure": return [blockText(array(c[1])[1], depth + 1), blockText(c[2], depth + 1)].filter(Boolean).join("\n");
        case "Table": {
          const rows = tableRows(c);
          return [blockText(array(c[1])[1], depth + 1), ...rows.head.map((row) => rowText(row, depth + 1)), ...rows.body.map((row) => rowText(row, depth + 1))].filter(Boolean).join("\n");
        }
        case "HorizontalRule": return "";
        default: if (current.t) skipped.add(current.t); return "";
      }
    }).filter(Boolean).join("\n");
  }
  function emit(text: string, blockId: string, table?: number): void {
    if (!text.trim()) return;
    texts.push(text);
    for (const chunk of chunkText(text)) {
      chunks.push({ text: chunk.text, headingPath: headings.map((heading) => heading.text), blockId, ...(table ? { table } : {}) });
    }
  }
  function walk(values: unknown, prefix = "b", depth = 0): void {
    guard(depth);
    for (const [index, value] of array(values).entries()) {
      const current = node(value);
      const c = array(current.c);
      const id = `${prefix}${index + 1}`;
      switch (current.t) {
        case "Header": {
          const text = inlineText(c[2], depth + 1).trim();
          const level = typeof c[0] === "number" ? c[0] : 1;
          while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
          if (text) headings.push({ level, text });
          if (!title && level === 1) title = text;
          emit(text, id);
          break;
        }
        case "Div": walk(c[1], `${id}.`, depth + 1); break;
        case "BlockQuote": walk(current.c, `${id}.`, depth + 1); break;
        case "BulletList": case "OrderedList": {
          const items = current.t === "BulletList" ? c : array(c[1]);
          for (const [itemIndex, item] of items.entries()) {
            const marker = current.t === "BulletList" ? "-" : `${Number(array(c[0])[0] || 1) + itemIndex}.`;
            emit(`${marker} ${blockText(item, depth + 1)}`, `${id}.item${itemIndex + 1}`);
          }
          break;
        }
        case "Table": {
          const table = ++tableCount;
          emit(blockText(array(c[1])[1], depth + 1), `${id}.caption`, table);
          const rows = tableRows(c);
          const header = rows.head.map((row) => rowText(row, depth + 1)).join("\n");
          if (header) emit(header, `${id}.header`, table);
          for (const [rowIndex, row] of rows.body.entries()) {
            const text = rowText(row, depth + 1);
            emit(header ? `${header}\n${text}` : text, `${id}.row${rowIndex + 1}`, table);
          }
          break;
        }
        default: emit(blockText([current], depth + 1), id);
      }
    }
  }
  const meta = "meta" in ast && ast.meta && typeof ast.meta === "object" ? ast.meta as Record<string, unknown> : {};
  const metaTitle = node(meta.title);
  if (metaTitle.t === "MetaString" && typeof metaTitle.c === "string") title = metaTitle.c.trim();
  else if (metaTitle.t === "MetaInlines") title = inlineText(metaTitle.c).trim();
  else if (metaTitle.t === "MetaBlocks") title = blockText(metaTitle.c).trim();
  walk(ast.blocks);
  if (!chunks.length) throw new ParseDocumentError("EMPTY_DOCUMENT", "DOCX contains no searchable text. Images and scanned content require OCR, which Nexa does not support.");
  if (imageSeen) warnings.push("DOCX images were not read; only their available alternative text was indexed. Image content requires OCR.");
  if (skipped.size) warnings.push(`Unsupported DOCX content was skipped: ${[...skipped].sort().join(", ")}.`);
  return { title: title || fallbackTitle, text: texts.join("\n\n"), chunks, warnings };
}
