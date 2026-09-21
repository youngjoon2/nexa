import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocx } from "./docx.ts";

export type ParsedChunk = {
  text: string; startLine?: number; endLine?: number; page?: number;
  headingPath?: string[]; blockId?: string; table?: number; symbol?: string;
};
export type ParsedDocument = { title: string; text: string; chunks: ParsedChunk[]; warnings: string[] };
export type ParseOptions = { pdfToTextPath: string; treeSitterDir: string; maxFileBytes: number; pandocPath?: string };

/** Bump when decoding, AST interpretation, or chunking changes so unchanged bytes are reprocessed. */
export const PARSER_PROFILE = "nexa-parser-v2:text-bom-v1:chunk-cjk-v1:c-cpp-symbol-v1:pdf-v1:pandoc-3.11-docx-v1";

export class ParseDocumentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ParseDocumentError";
  }
}

const extensions = new Set([
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".py", ".js", ".jsx", ".ts", ".tsx",
  ".rs", ".go", ".java", ".cs", ".dts", ".dtsi", ".md", ".markdown", ".txt", ".rst", ".log",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".html", ".htm", ".sh",
  ".ps1", ".bat", ".cmake", ".pdf", ".docx",
]);
const excludedDirectories = new Set([
  ".git", "node_modules", "build", "dist", ".runtime", ".models", "vendor", ".venv", "venv",
]);

export function isExcludedDirectory(name: string): boolean {
  return excludedDirectories.has(name.toLowerCase());
}

export function isSupportedFile(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  return name === "makefile" || name === "cmakelists.txt" || extensions.has(extname(name));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../"));
}

/** Enumerate supported regular files without following symbolic links or Windows junctions. */
export async function discoverFiles(
  root: string,
  options: { maxFiles?: number } = {},
): Promise<{ files: string[]; warnings: string[] }> {
  const maxFiles = options.maxFiles ?? 50_000;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("maxFiles must be a positive integer.");
  const absoluteRoot = resolve(root);
  const rootStat = await lstat(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Source root must be a regular directory, not a symbolic link or junction.");
  }
  const canonicalRoot = await realpath(absoluteRoot);
  const files: string[] = [];
  const warnings: string[] = [];
  const pending = [absoluteRoot];
  while (pending.length) {
    const directory = pending.pop()!;
    try {
      // Check again before descent so a changed directory cannot redirect traversal outside the source.
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !isInside(canonicalRoot, await realpath(directory))) {
        warnings.push(`Skipped symbolic link, junction, or path outside source: ${directory}`);
        continue;
      }
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const filePath = join(directory, entry.name);
        try {
          const stat = await lstat(filePath);
          if (stat.isSymbolicLink()) {
            warnings.push(`Skipped symbolic link or junction: ${filePath}`);
          } else if (stat.isDirectory()) {
            if (!isExcludedDirectory(entry.name)) pending.push(filePath);
          } else if (stat.isFile() && isSupportedFile(filePath)) {
            if (!isInside(canonicalRoot, await realpath(filePath))) {
              warnings.push(`Skipped path outside source: ${filePath}`);
              continue;
            }
            if (files.length >= maxFiles) {
              warnings.push(`File discovery stopped at the ${maxFiles} file limit. Additional supported files were not indexed; increase the limit or narrow the source directory.`);
              return { files: files.sort(), warnings };
            }
            files.push(filePath);
          }
        } catch (error) {
          warnings.push(`Could not inspect ${filePath}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      warnings.push(`Could not read directory ${directory}: ${errorMessage(error)}`);
    }
  }
  return { files: files.sort(), warnings };
}

type LineUnit = { text: string; line: number };
const MAX_CHUNK_CHARS = 1800;

/** Keep contiguous source text and exact 1-based line references, even for oversized single lines. */
export function chunkText(text: string, firstLine = 1): ParsedChunk[] {
  const sample = text.slice(0, 16_384);
  const nonAscii = (sample.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const target = nonAscii / Math.max(sample.length, 1) >= 0.15 ? 600 : 1400;
  const chunkLimit = target === 600 ? 700 : MAX_CHUNK_CHARS;
  const units: LineUnit[] = [];
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (let i = 0; i < lines.length; i++) {
    let rest = lines[i]!;
    while (rest.length > target) {
      let end = target;
      // Do not split UTF-16 surrogate pairs (e.g. a non-BMP identifier or emoji).
      if (/[\uD800-\uDBFF]/.test(rest[end - 1]!)) end--;
      units.push({ text: rest.slice(0, end), line: firstLine + i });
      rest = rest.slice(end);
    }
    if (rest) units.push({ text: rest, line: firstLine + i });
  }
  const chunks: ParsedChunk[] = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let length = 0;
    while (end < units.length) {
      const nextLength = units[end]!.text.length;
      if (end > start && (length + nextLength > chunkLimit || length >= target)) break;
      length += nextLength;
      end++;
    }
    const chunk = units.slice(start, end).map((unit) => unit.text).join("");
    if (chunk.trim()) {
      chunks.push({ text: chunk, startLine: units[start]!.line, endLine: units[end - 1]!.line });
    }
    if (end === units.length) break;
    // Retain the last two whole lines when overlap fits alongside fresh content and makes progress.
    const lastLine = units[end - 1]!.line;
    let overlap = end;
    while (overlap > start && units[overlap - 1]!.line >= lastLine - 1) overlap--;
    const overlapLength = units.slice(overlap, end).reduce((total, unit) => total + unit.text.length, 0);
    const startsWholeLine = overlap === 0 || units[overlap - 1]!.line !== units[overlap]!.line;
    const endsWholeLine = units[end - 1]!.line !== units[end]!.line;
    start = overlap > start && startsWholeLine && endsWholeLine && overlapLength < target &&
      overlapLength + units[end]!.text.length <= chunkLimit ? overlap : end;
  }
  return chunks;
}

function decodeText(bytes: Uint8Array): string {
  let encoding = "utf-8";
  let data = bytes;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    data = bytes.subarray(2);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    data = bytes.subarray(2);
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    data = bytes.subarray(3);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder(encoding, { fatal: true }).decode(data);
  } catch {
    throw new ParseDocumentError("INVALID_ENCODING", "Invalid text encoding. Save this file as UTF-8 or BOM-marked UTF-16 before indexing.");
  }
  const controlLimit = Math.max(2, decoded.length * 0.01);
  let controls = 0;
  for (let i = 0; i < decoded.length; i++) {
    const value = decoded.charCodeAt(i);
    if ((value >= 1 && value <= 8) || value === 11 || (value >= 14 && value <= 31) || value === 127) controls++;
    if (value === 0 || controls > controlLimit) {
      throw new ParseDocumentError("BINARY_FILE", "File contains binary data or unsupported control characters.");
    }
  }
  return decoded.replace(/\r\n?/g, "\n");
}

type SyntaxNode = {
  type: string; hasError: boolean; startPosition: { row: number }; endPosition: { row: number; column: number };
  namedChildren: SyntaxNode[]; text: string; childForFieldName(name: string): SyntaxNode | null;
};
type SyntaxTree = { rootNode: SyntaxNode; delete(): void };
type ParserInstance = { setLanguage(language: unknown): void; parse(text: string): SyntaxTree | null; delete(): void };
type ParserConstructor = { new(): ParserInstance; init(options: { locateFile(name: string): string }): Promise<void> };
type ParserModule = { Parser: ParserConstructor; Language: { load(path: string): Promise<unknown> } };
const parserModules = new Map<string, Promise<ParserModule>>();
const languages = new Map<string, Promise<unknown>>();

function functionSymbol(node: SyntaxNode): string | undefined {
  let declarator = node.childForFieldName("declarator");
  while (declarator) {
    if (["identifier", "field_identifier", "qualified_identifier", "operator_name", "destructor_name"].includes(declarator.type)) return declarator.text;
    declarator = declarator.childForFieldName("declarator");
  }
  return undefined;
}

async function astChunks(text: string, extension: string, directory: string): Promise<ParsedChunk[]> {
  const parserDir = resolve(directory);
  let modulePromise = parserModules.get(parserDir);
  if (!modulePromise) {
    modulePromise = (async () => {
      const module = await import(pathToFileURL(join(parserDir, "web-tree-sitter.js")).href) as ParserModule;
      await module.Parser.init({ locateFile: (name: string) => join(parserDir, name) });
      return module;
    })();
    parserModules.set(parserDir, modulePromise);
    modulePromise.catch(() => parserModules.delete(parserDir));
  }
  const module = await modulePromise;
  const grammar = [".cpp", ".hpp", ".cc", ".cxx", ".hxx"].includes(extension) ? "cpp" : "c";
  const grammarPath = join(parserDir, `tree-sitter-${grammar}.wasm`);
  let language = languages.get(grammarPath);
  if (!language) {
    language = module.Language.load(grammarPath);
    languages.set(grammarPath, language);
    language.catch(() => languages.delete(grammarPath));
  }
  const parser = new module.Parser();
  let tree: SyntaxTree | null = null;
  try {
    parser.setLanguage(await language);
    tree = parser.parse(text);
    if (!tree || tree.rootNode.hasError) throw new Error("Source has incomplete or unsupported C/C++ syntax.");
    const ranges: { start: number; end: number; symbol?: string }[] = [];
    const stack = [tree.rootNode];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === "function_definition") {
        ranges.push({ start: node.startPosition.row, end: node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0), symbol: functionSymbol(node) });
      } else {
        stack.push(...node.namedChildren);
      }
    }
    if (!ranges.length) return chunkText(text);
    ranges.sort((a, b) => a.start - b.start);
    const merged: typeof ranges = [];
    for (const range of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && range.start < previous.end) {
        previous.end = Math.max(previous.end, range.end);
        previous.symbol = undefined;
      }
      else merged.push({ ...range });
    }
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const chunks: ParsedChunk[] = [];
    let cursor = 0;
    for (const range of merged) {
      if (range.start > cursor) chunks.push(...chunkText(lines.slice(cursor, range.start).join(""), cursor + 1));
      chunks.push(...chunkText(lines.slice(range.start, range.end).join(""), range.start + 1)
        .map((chunk) => range.symbol ? { ...chunk, symbol: range.symbol } : chunk));
      cursor = range.end;
    }
    if (cursor < lines.length) chunks.push(...chunkText(lines.slice(cursor).join(""), cursor + 1));
    return chunks;
  } finally {
    tree?.delete();
    parser.delete();
  }
}

async function boundedRead(stream: ReadableStream<Uint8Array>, maxBytes: number, overflow: () => void): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        overflow();
        throw new ParseDocumentError("PDF_OUTPUT_TOO_LARGE", `PDF extraction exceeded the ${maxBytes} byte output limit.`);
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

async function parsePdf(filePath: string, options: ParseOptions): Promise<ParsedDocument> {
  if (!options.pdfToTextPath) throw new ParseDocumentError("PDF_UNAVAILABLE", "Poppler pdftotext is not configured. Install the GitHub runtime bundle to index text PDFs.");
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([options.pdfToTextPath, "-layout", "-enc", "UTF-8", filePath, "-"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  } catch (error) {
    throw new ParseDocumentError("PDF_UNAVAILABLE", `Could not start Poppler pdftotext: ${errorMessage(error)}`);
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
  try {
    const maxOutput = Math.min(64 * 1024 * 1024, Math.max(options.maxFileBytes * 4, 1024 * 1024));
    const results = await Promise.allSettled([
      boundedRead(child.stdout as ReadableStream<Uint8Array>, maxOutput, () => child.kill()),
      boundedRead(child.stderr as ReadableStream<Uint8Array>, 64 * 1024, () => child.kill()),
      child.exited,
    ]);
    if (timedOut) throw new ParseDocumentError("PDF_TIMEOUT", "PDF extraction timed out after 30 seconds.");
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    const output = (results[0] as PromiseFulfilledResult<Uint8Array>).value;
    const stderr = new TextDecoder().decode((results[1] as PromiseFulfilledResult<Uint8Array>).value).trim();
    const exitCode = (results[2] as PromiseFulfilledResult<number>).value;
    if (exitCode !== 0) throw new ParseDocumentError("PDF_FAILED", `PDF extraction failed (${exitCode}): ${stderr || "The PDF may be malformed or encrypted."}`);
    const extracted = decodeText(output);
    const pages = extracted.split("\f");
    if (pages.length > 1 && !pages[pages.length - 1]!.trim()) pages.pop();
    if (!pages.some((page) => page.trim())) throw new ParseDocumentError("EMPTY_DOCUMENT", "No extractable text found in this PDF. Scanned or image-only PDFs need OCR, which Nexa does not support in this version.");
    const chunks = pages.flatMap((page, index) => chunkText(page).map((chunk) => ({ text: chunk.text, page: index + 1 })));
    const warnings = stderr ? [`Poppler: ${stderr}`] : [];
    const emptyPages = pages.flatMap((page, index) => page.trim() ? [] : [index + 1]);
    if (emptyPages.length) warnings.push(`No text was extracted from PDF pages ${emptyPages.join(", ")}; images and scanned content require OCR.`);
    return { title: basename(filePath), text: pages.join("\n\f\n"), chunks, warnings };
  } finally {
    clearTimeout(timer);
  }
}

export async function parseDocument(filePath: string, options: ParseOptions): Promise<ParsedDocument> {
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1) throw new Error("maxFileBytes must be a positive integer.");
  const absolutePath = resolve(filePath);
  if (!isSupportedFile(absolutePath)) throw new ParseDocumentError("UNSUPPORTED_FILE", `Unsupported file type: ${basename(filePath)}`);
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new ParseDocumentError("UNSUPPORTED_FILE", "Only regular files may be indexed; symbolic links and junctions are excluded.");
  if (info.size > options.maxFileBytes) throw new ParseDocumentError("FILE_TOO_LARGE", `File exceeds the ${options.maxFileBytes} byte limit.`);
  // A bounded read also catches a file growing after the initial stat.
  const handle = await open(absolutePath, "r");
  let bytes: Uint8Array;
  try {
    const pieces: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const buffer = new Uint8Array(Math.min(64 * 1024, options.maxFileBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > options.maxFileBytes) throw new ParseDocumentError("FILE_TOO_LARGE", `File exceeds the ${options.maxFileBytes} byte limit.`);
      pieces.push(buffer.subarray(0, bytesRead));
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length; }
  } finally {
    await handle.close();
  }
  return parseDocumentBytes(basename(absolutePath), bytes, options);
}

/** Parse the captured content, never reopen a live source path while a parser is running. */
export async function parseDocumentBytes(
  name: string,
  bytes: Uint8Array,
  options: ParseOptions,
  tempRoot?: string,
): Promise<ParsedDocument> {
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1) throw new Error("maxFileBytes must be a positive integer.");
  if (!isSupportedFile(name)) throw new ParseDocumentError("UNSUPPORTED_FILE", `Unsupported file type: ${basename(name)}`);
  if (bytes.byteLength > options.maxFileBytes) throw new ParseDocumentError("FILE_TOO_LARGE", `File exceeds the ${options.maxFileBytes} byte limit.`);
  const extension = extname(name).toLowerCase();
  // Capture before the first await: later caller mutations cannot change the parsed revision.
  const captured = Uint8Array.from(bytes);
  if (extension === ".pdf" || extension === ".docx") {
    const root = resolve(tempRoot || tmpdir());
    await mkdir(root, { recursive: true });
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) {
      throw new ParseDocumentError("TEMP_DIRECTORY_INVALID", "Parser temporary root must be a regular directory.");
    }
    const directory = await mkdtemp(join(root, "nexa-parse-"));
    try {
      const input = join(directory, `input${extension}`);
      await writeFile(input, captured, { flag: "wx", mode: 0o600 });
      const parsed = extension === ".pdf" ? await parsePdf(input, options) : await parseDocx(input, options);
      // Extractors see only an internal filename. Keep the source's display title.
      if (parsed.title === basename(input)) parsed.title = basename(name);
      return parsed;
    } finally {
      // Only remove the direct child allocated by mkdtemp, never a supplied source path.
      if (relative(root, directory) !== basename(directory) || !basename(directory).startsWith("nexa-parse-")) {
        throw new ParseDocumentError("TEMP_DIRECTORY_INVALID", "Parser temporary cleanup path is outside its managed root.");
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  const text = decodeText(captured);
  if (!text.trim()) throw new ParseDocumentError("EMPTY_DOCUMENT", "File contains no searchable text.");
  const warnings: string[] = [];
  let chunks: ParsedChunk[];
  if ([".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx"].includes(extension)) {
    try {
      chunks = await astChunks(text, extension, options.treeSitterDir);
    } catch (error) {
      warnings.push(`C/C++ syntax parser unavailable or source could not be parsed; indexed all text with line references instead. ${errorMessage(error)}`);
      chunks = chunkText(text);
    }
  } else chunks = chunkText(text);
  const heading = [".md", ".markdown"].includes(extension) ? text.match(/^#\s+(.+)$/m)?.[1]?.trim() : undefined;
  return { title: heading || basename(name), text, chunks, warnings };
}
