import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { AppError } from './types';
import { isExcludedDirectory, isSupportedFile } from './ingestion';

export type GitSettings = { url: string; branch: string; tagPattern?: string };
export type GitReadOptions = {
  dataDir: string; sourceId: string; gitPath: string; maxFileBytes: number; maxFiles: number; commit?: string;
};
export type GitSourceResult = {
  commit: string; files: Array<{ path: string; bytes: Uint8Array }>; warnings: string[];
  tags: Array<{ name: string; commit: string }>;
};

const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const busy = new Set<string>();

/** Accept cloud GitHub/Bitbucket repositories only; authentication belongs to GCM/SSH, never a URL. */
export function validateGitSettings(input: GitSettings): GitSettings {
  if (!input || typeof input.url !== 'string' || typeof input.branch !== 'string')
    throw new AppError('INVALID_GIT_SOURCE', 'Enter a Git repository URL and branch.');
  let address = input.url.trim();
  if (address.length > 1024 || /[\s\\\x00-\x1f\x7f]/.test(address))
    throw new AppError('INVALID_GIT_URL', 'Use a GitHub or Bitbucket HTTPS or SSH URL without spaces or control characters.');
  const scp = /^git@([^:]+):(.+)$/.exec(address);
  if (scp) address = `ssh://git@${scp[1]}/${scp[2]}`;
  let url: URL;
  try { url = new URL(address); } catch { throw new AppError('INVALID_GIT_URL', 'A GitHub or Bitbucket HTTPS or SSH repository URL is required.'); }
  const ssh = url.protocol === 'ssh:';
  if (!['https:', 'ssh:'].includes(url.protocol) || !['github.com', 'bitbucket.org'].includes(url.hostname) ||
      url.password || (ssh ? url.username !== 'git' : !!url.username) || url.search || url.hash ||
      (url.port && url.port !== (ssh ? '22' : '443')) ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname) ||
      url.pathname.split('/').some(part => part === '.' || part === '..'))
    throw new AppError('INVALID_GIT_URL', 'Use a repository URL from github.com or bitbucket.org. Configure Git Credential Manager or SSH keys instead of including an HTTPS username, password, or token in the URL.');
  const branch = input.branch.trim();
  if (!branch || branch === '@' || branch.length > 200 || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') ||
      branch.endsWith('.') || branch.includes('..') || branch.includes('@{') || branch.includes('//') ||
      /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')))
    throw new AppError('INVALID_GIT_BRANCH', 'Enter a branch name such as main or develop, rather than a commit expression.');
  const tagPattern = input.tagPattern ?? '*';
  if (typeof tagPattern !== 'string' || !tagPattern.length || tagPattern.length > 200 || /[\x00-\x1f\x7f]/.test(tagPattern))
    throw new AppError('INVALID_TAG_PATTERN', 'Tag patterns must be 1 to 200 characters and may use * and ? wildcards.');
  const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '') + '.git';
  return { url: `${ssh ? 'ssh://git@' : 'https://'}${url.hostname}${path}`, branch, tagPattern };
}

export function gitCachePath(dataDir: string, sourceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(sourceId)) throw new AppError('INVALID_SOURCE_ID', 'Invalid Git source ID.');
  return join(resolve(dataDir), 'git-cache', `${sourceId}.git`);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}

async function checkedDirectory(path: string, root: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, await realpath(path)))
    throw new AppError('GIT_CACHE_PATH', 'The Git cache path is not a regular folder. Check the data folder for symbolic links or junctions.', 409);
}

async function readOutput(stream: ReadableStream<Uint8Array>, max: number, kill: () => void): Promise<Uint8Array> {
  const reader = stream.getReader(); const pieces: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > max) { kill(); throw new AppError('GIT_OUTPUT_LIMIT', 'The Git response exceeds the processing limit. Narrow the repository or tag scope.', 413); }
      pieces.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length; }
  return bytes;
}

async function runGit(gitPath: string, cache: string, args: string[], options: { input?: string; max?: number; timeout?: number; action?: string } = {}): Promise<Uint8Array> {
  if (!gitPath) throw new AppError('GIT_UNAVAILABLE', 'Git was not found. Install MinGit with scripts/setup.cmd or scripts/setup.ps1.', 503);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('GIT_') && !key.toUpperCase().startsWith('GCM_')) env[key] = value;
  }
  const bundledSsh = join(dirname(dirname(resolve(gitPath))), 'usr', 'bin', process.platform === 'win32' ? 'ssh.exe' : 'ssh');
  let ssh = 'ssh';
  try { if ((await lstat(bundledSsh)).isFile()) ssh = "'" + bundledSsh.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'"; } catch { /* OS SSH remains available. */ }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_SSH_COMMAND: `${ssh} -oBatchMode=yes -oStrictHostKeyChecking=yes`, GIT_SSH_VARIANT: 'ssh',
  });
  const fixed = ['-c', `core.hooksPath=${join(cache, 'nexa-disabled-hooks')}`, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
    '-c', 'http.sslVerify=true', '-c', 'http.followRedirects=false', '-c', 'credential.interactive=false'];
  if (process.platform === 'win32') fixed.push('-c', 'credential.helper=manager');
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([gitPath, ...fixed, '--git-dir', cache, ...args], {
      env, stdin: options.input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
  } catch { throw new AppError('GIT_UNAVAILABLE', 'Git could not be started. Check the MinGit installation with scripts/setup.cmd or scripts/setup.ps1.', 503); }
  let termination: Promise<void> | undefined;
  const stop = (): Promise<void> => termination ??= (async () => {
    // Git may own ssh/remote-https children that keep pipes open. End only this spawned process tree.
    if (process.platform === 'win32' && child.exitCode === null) {
      try {
        const killer = Bun.spawn([join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), '/PID', String(child.pid), '/T', '/F'],
          { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true });
        await killer.exited;
      } catch { /* Terminate the direct process if taskkill is unavailable. */ }
    }
    if (child.exitCode === null) child.kill();
  })();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void stop(); }, options.timeout ?? 30_000);
  try {
    if (options.input !== undefined) {
      const sink = child.stdin as { write(value: string): unknown; end(): unknown };
      sink.write(options.input); sink.end();
    }
    const results = await Promise.allSettled([
      readOutput(child.stdout as ReadableStream<Uint8Array>, options.max ?? 4 * 1024 * 1024, () => { void stop(); }),
      readOutput(child.stderr as ReadableStream<Uint8Array>, 256 * 1024, () => { void stop(); }), child.exited,
    ]);
    if (timedOut) throw new AppError('GIT_TIMEOUT', 'The Git operation timed out. Check the network and authentication, then sync again.', 503);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    const code = (results[2] as PromiseFulfilledResult<number>).value;
    // Git stderr can contain remotes, helper output and credentials. Return only an actionable fixed message.
    if (code !== 0) throw new AppError('GIT_FAILED', `${options.action ?? 'Reading Git sources'} failed. Check the repository, branch, commit, and network. For private repositories, configure Git Credential Manager or SSH keys and known_hosts for the server account.`, 503);
    return (results[0] as PromiseFulfilledResult<Uint8Array>).value;
  } finally { clearTimeout(timer); if (termination) await termination; }
}

async function prepareCache(settings: GitSettings, options: GitReadOptions): Promise<string> {
  await mkdir(resolve(options.dataDir), { recursive: true });
  const dataRoot = await realpath(resolve(options.dataDir));
  const cacheRoot = join(dataRoot, 'git-cache');
  await mkdir(cacheRoot, { recursive: true }); await checkedDirectory(cacheRoot, dataRoot);
  const cache = gitCachePath(dataRoot, options.sourceId);
  let created = false;
  try { await mkdir(cache); created = true; } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  await checkedDirectory(cache, dataRoot);
  const receipt = join(cache, 'nexa-owner.json');
  if (created) {
    await writeFile(receipt, JSON.stringify({ version: 1, sourceId: options.sourceId, url: settings.url }), { flag: 'wx' });
  } else {
    try {
      if ((await lstat(receipt)).isSymbolicLink()) throw new Error('Linked owner record.');
      const owner = JSON.parse(await readFile(receipt, 'utf8'));
      if (owner.version !== 1 || owner.sourceId !== options.sourceId || owner.url !== settings.url) throw new Error('Different owner.');
    } catch { throw new AppError('GIT_CACHE_OWNER', 'The Git cache ownership or repository URL does not match. Connect a separate Git source instead of using an existing working folder as the cache.', 409); }
  }
  let hasHead = false;
  try { hasHead = (await lstat(join(cache, 'HEAD'))).isFile(); } catch { /* interrupted cache initialization */ }
  if (!hasHead) {
    if (options.commit) throw new AppError('GIT_COMMIT_UNAVAILABLE', 'This commit is not in the Git cache. Sync the repository first.', 409);
    await runGit(options.gitPath, cache, ['init', '--bare', '--template=', cache], { action: 'Creating the Git cache' });
  }
  const bare = decoder.decode(await runGit(options.gitPath, cache, ['rev-parse', '--is-bare-repository'])).trim();
  if (bare !== 'true') throw new AppError('GIT_CACHE_OWNER', 'The Git cache must be a bare repository. Working trees cannot be used.', 409);
  return cache;
}

function tagMatches(name: string, pattern: string): boolean {
  // A small wildcard matcher avoids exponential regular-expression backtracking for repeated * patterns.
  let n = 0; let p = 0; let star = -1; let retry = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) { n++; p++; }
    else if (pattern[p] === '*') { star = p++; retry = n; }
    else if (star >= 0) { p = star + 1; n = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

async function listTags(settings: GitSettings, options: GitReadOptions, cache: string, warnings: string[]): Promise<GitSourceResult['tags']> {
  const output = decoder.decode(await runGit(options.gitPath, cache,
    ['for-each-ref', '--format=%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)', 'refs/tags']));
  const tags: GitSourceResult['tags'] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [name, type, object, peeledType, peeled] = line.replace(/\r$/, '').split('\0');
    if (!name || !tagMatches(name, settings.tagPattern ?? '*')) continue;
    if (tags.length >= 1000) { warnings.push('There are more than 1,000 tags. Narrow tagPattern and sync again.'); break; }
    let commit = type === 'commit' ? object : peeledType === 'commit' ? peeled : '';
    if (type === 'tag' && peeledType === 'tag') {
      try { commit = decoder.decode(await runGit(options.gitPath, cache, ['rev-parse', '--verify', `refs/tags/${name}^{commit}`])).trim(); }
      catch { warnings.push(`Skipped a tag that does not point to a commit: ${name}`); continue; }
    }
    if (commit && OID.test(commit)) tags.push({ name, commit });
    else warnings.push(`Skipped a tag that does not point to a commit: ${name}`);
  }
  return tags;
}

/** Reads immutable Git objects from an application-owned bare cache. It never checks out or changes a user's workspace. */
export async function readGitSource(input: GitSettings, options: GitReadOptions): Promise<GitSourceResult> {
  const settings = validateGitSettings(input);
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1 || !Number.isSafeInteger(options.maxFiles) || options.maxFiles < 1)
    throw new AppError('INVALID_GIT_LIMIT', 'Git file count and size limits must be positive integers.');
  if (options.commit && !OID.test(options.commit)) throw new AppError('INVALID_GIT_COMMIT', 'Use the full Git commit SHA.');
  const key = gitCachePath(options.dataDir, options.sourceId);
  if (busy.has(key)) throw new AppError('SOURCE_BUSY', 'This Git source is already syncing.', 409);
  busy.add(key);
  try {
    const cache = await prepareCache(settings, options); const warnings: string[] = [];
    if (!options.commit) {
      await runGit(options.gitPath, cache, ['fetch', '--no-recurse-submodules', '--no-tags', '--no-write-fetch-head', settings.url,
        `+refs/heads/${settings.branch}:refs/remotes/origin/tracked`, '+refs/tags/*:refs/tags/*'], { timeout: 120_000, action: 'Syncing the Git remote' });
    }
    const commit = decoder.decode(await runGit(options.gitPath, cache,
      ['rev-parse', '--verify', `${options.commit ?? 'refs/remotes/origin/tracked'}^{commit}`], { action: 'Resolving the Git commit' })).trim();
    if (!OID.test(commit)) throw new AppError('GIT_RESPONSE', 'Git returned an invalid commit response.', 502);
    await runGit(options.gitPath, cache, ['update-ref', `refs/nexa/snapshots/${commit}`, commit], { action: 'Preserving the Git commit' });
    const tags = await listTags(settings, options, cache, warnings);
    const listing = decoder.decode(await runGit(options.gitPath, cache, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], { max: 64 * 1024 * 1024 }));
    const entries: Array<{ path: string; oid: string; size: number }> = []; let total = 0; let matched = 0;
    for (const line of listing.split('\0')) {
      if (!line) continue;
      const parsed = /^(\d+) (\w+) ([a-f0-9]+) +([\d-]+)\t([\s\S]+)$/.exec(line);
      if (!parsed) throw new AppError('GIT_RESPONSE', 'The Git file list could not be parsed.', 502);
      const [, mode, type, oid, rawSize, path] = parsed as unknown as [string, string, string, string, string, string];
      const parts = path.split('/');
      if (parts.slice(0, -1).some(isExcludedDirectory)) continue;
      if (mode === '160000') { warnings.push(`Connect this Git submodule as a separate source: ${path}`); continue; }
      if (mode === '120000') { warnings.push(`Skipped a Git symbolic link: ${path}`); continue; }
      if (!isSupportedFile(path)) continue;
      if (parts.some(part => !part || part === '.' || part === '..') || /[\\:\x00-\x1f\x7f]/.test(path)) {
        warnings.push(`Skipped an unsupported Git file path: ${path.replace(/[\x00-\x1f\x7f]/g, '?')}`); continue;
      }
      if (type !== 'blob' || !['100644', '100755'].includes(mode) || !OID.test(oid)) continue;
      matched++;
      if (matched > options.maxFiles) { warnings.push(`The Git file limit of ${options.maxFiles} was reached. Some sources were excluded.`); break; }
      const size = Number(rawSize);
      if (!Number.isSafeInteger(size) || size < 0) throw new AppError('GIT_RESPONSE', 'Invalid Git file size.', 502);
      if (size > options.maxFileBytes) { warnings.push(`File size limit exceeded: ${path}`); continue; }
      if (total + size > MAX_SOURCE_BYTES) { warnings.push('The 256 MiB limit for one Git sync was reached. Some sources were excluded.'); break; }
      entries.push({ path, oid, size }); total += size;
    }
    const files: GitSourceResult['files'] = [];
    for (let start = 0; start < entries.length;) {
      const batch: typeof entries = []; let size = 0;
      while (start < entries.length && batch.length < 16 && (!batch.length || size + entries[start]!.size <= 32 * 1024 * 1024)) {
        const entry = entries[start++]!; batch.push(entry); size += entry.size;
      }
      const bytes = await runGit(options.gitPath, cache, ['cat-file', '--batch'], {
        input: batch.map(entry => entry.oid).join('\n') + '\n', max: size + batch.length * 128,
      });
      let offset = 0;
      for (const entry of batch) {
        const end = bytes.indexOf(10, offset);
        if (end < 0 || decoder.decode(bytes.subarray(offset, end)) !== `${entry.oid} blob ${entry.size}` || bytes[end + 1 + entry.size] !== 10)
          throw new AppError('GIT_RESPONSE', 'The Git blob response size or ID does not match.', 502);
        const content = bytes.subarray(end + 1, end + 1 + entry.size); offset = end + 2 + entry.size;
        if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(new TextDecoder().decode(content.subarray(0, 256)))) {
          warnings.push(`The Git LFS file could not be read. Connect a folder containing the actual file: ${entry.path}`); continue;
        }
        files.push({ path: entry.path, bytes: content });
      }
      if (offset !== bytes.length) throw new AppError('GIT_RESPONSE', 'The Git blob response contains unexpected data.', 502);
    }
    return { commit, files, warnings: warnings.slice(0, 200).concat(warnings.length > 200 ? [`${warnings.length - 200} additional diagnostics omitted`] : []), tags };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('GIT_READ_FAILED', 'The Git cache could not be read. Check data folder permissions and disk space, then sync again.', 503);
  } finally { busy.delete(key); }
}
