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
    throw new AppError('INVALID_GIT_SOURCE', 'Git 저장소 URL과 브랜치를 입력하세요.');
  let address = input.url.trim();
  if (address.length > 1024 || /[\s\\\x00-\x1f\x7f]/.test(address))
    throw new AppError('INVALID_GIT_URL', '공백이나 제어 문자가 없는 GitHub/Bitbucket HTTPS 또는 SSH URL을 사용하세요.');
  const scp = /^git@([^:]+):(.+)$/.exec(address);
  if (scp) address = `ssh://git@${scp[1]}/${scp[2]}`;
  let url: URL;
  try { url = new URL(address); } catch { throw new AppError('INVALID_GIT_URL', 'GitHub/Bitbucket HTTPS 또는 SSH 저장소 URL이 필요합니다.'); }
  const ssh = url.protocol === 'ssh:';
  if (!['https:', 'ssh:'].includes(url.protocol) || !['github.com', 'bitbucket.org'].includes(url.hostname) ||
      url.password || (ssh ? url.username !== 'git' : !!url.username) || url.search || url.hash ||
      (url.port && url.port !== (ssh ? '22' : '443')) ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname) ||
      url.pathname.split('/').some(part => part === '.' || part === '..'))
    throw new AppError('INVALID_GIT_URL', 'github.com 또는 bitbucket.org의 저장소 URL을 사용하세요. HTTPS 사용자명·비밀번호·토큰을 URL에 넣지 말고 Git Credential Manager 또는 SSH 키를 설정하세요.');
  const branch = input.branch.trim();
  if (!branch || branch === '@' || branch.length > 200 || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') ||
      branch.endsWith('.') || branch.includes('..') || branch.includes('@{') || branch.includes('//') ||
      /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')))
    throw new AppError('INVALID_GIT_BRANCH', '브랜치 이름을 확인하세요. 커밋 표현식 대신 main, develop 등의 브랜치 이름을 입력하세요.');
  const tagPattern = input.tagPattern ?? '*';
  if (typeof tagPattern !== 'string' || !tagPattern.length || tagPattern.length > 200 || /[\x00-\x1f\x7f]/.test(tagPattern))
    throw new AppError('INVALID_TAG_PATTERN', '태그 패턴은 1~200자이며 *와 ? 와일드카드를 사용할 수 있습니다.');
  const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '') + '.git';
  return { url: `${ssh ? 'ssh://git@' : 'https://'}${url.hostname}${path}`, branch, tagPattern };
}

export function gitCachePath(dataDir: string, sourceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(sourceId)) throw new AppError('INVALID_SOURCE_ID', '잘못된 Git 소스 ID입니다.');
  return join(resolve(dataDir), 'git-cache', `${sourceId}.git`);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}

async function checkedDirectory(path: string, root: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, await realpath(path)))
    throw new AppError('GIT_CACHE_PATH', 'Git 캐시 경로가 일반 폴더가 아닙니다. 데이터 폴더의 링크·junction을 확인하세요.', 409);
}

async function readOutput(stream: ReadableStream<Uint8Array>, max: number, kill: () => void): Promise<Uint8Array> {
  const reader = stream.getReader(); const pieces: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > max) { kill(); throw new AppError('GIT_OUTPUT_LIMIT', 'Git 응답이 처리 한도를 초과했습니다. 저장소 또는 태그 범위를 줄이세요.', 413); }
      pieces.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length; }
  return bytes;
}

async function runGit(gitPath: string, cache: string, args: string[], options: { input?: string; max?: number; timeout?: number; action?: string } = {}): Promise<Uint8Array> {
  if (!gitPath) throw new AppError('GIT_UNAVAILABLE', 'Git 실행 파일이 없습니다. scripts/setup.cmd 또는 scripts/setup.ps1로 MinGit를 설치하세요.', 503);
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
  } catch { throw new AppError('GIT_UNAVAILABLE', 'Git 실행 파일을 시작하지 못했습니다. scripts/setup.cmd 또는 scripts/setup.ps1로 MinGit 설치를 확인하세요.', 503); }
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
    if (timedOut) throw new AppError('GIT_TIMEOUT', 'Git 작업 시간이 초과되었습니다. 네트워크·인증 상태를 확인하고 다시 동기화하세요.', 503);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    const code = (results[2] as PromiseFulfilledResult<number>).value;
    // Git stderr can contain remotes, helper output and credentials. Return only an actionable fixed message.
    if (code !== 0) throw new AppError('GIT_FAILED', `${options.action ?? 'Git 자료 읽기'}에 실패했습니다. 저장소·브랜치·커밋과 네트워크를 확인하세요. 비공개 저장소는 서버 계정의 Git Credential Manager 또는 SSH 키/known_hosts를 먼저 설정하세요.`, 503);
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
    } catch { throw new AppError('GIT_CACHE_OWNER', 'Git 캐시의 소유권 또는 저장소 URL이 다릅니다. 기존 작업 폴더를 캐시로 사용하지 말고 별도 Git 소스를 등록하세요.', 409); }
  }
  let hasHead = false;
  try { hasHead = (await lstat(join(cache, 'HEAD'))).isFile(); } catch { /* interrupted cache initialization */ }
  if (!hasHead) {
    if (options.commit) throw new AppError('GIT_COMMIT_UNAVAILABLE', '이 커밋의 Git 캐시가 없습니다. 저장소를 먼저 동기화하세요.', 409);
    await runGit(options.gitPath, cache, ['init', '--bare', '--template=', cache], { action: 'Git 캐시 생성' });
  }
  const bare = decoder.decode(await runGit(options.gitPath, cache, ['rev-parse', '--is-bare-repository'])).trim();
  if (bare !== 'true') throw new AppError('GIT_CACHE_OWNER', 'Git 캐시가 bare 저장소가 아닙니다. 사용자의 작업 트리를 사용하지 않습니다.', 409);
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
    if (tags.length >= 1000) { warnings.push('태그가 1,000개를 초과했습니다. tagPattern을 좁혀서 다시 동기화하세요.'); break; }
    let commit = type === 'commit' ? object : peeledType === 'commit' ? peeled : '';
    if (type === 'tag' && peeledType === 'tag') {
      try { commit = decoder.decode(await runGit(options.gitPath, cache, ['rev-parse', '--verify', `refs/tags/${name}^{commit}`])).trim(); }
      catch { warnings.push(`커밋을 가리키지 않는 태그를 제외했습니다: ${name}`); continue; }
    }
    if (commit && OID.test(commit)) tags.push({ name, commit });
    else warnings.push(`커밋을 가리키지 않는 태그를 제외했습니다: ${name}`);
  }
  return tags;
}

/** Reads immutable Git objects from an application-owned bare cache. It never checks out or changes a user's workspace. */
export async function readGitSource(input: GitSettings, options: GitReadOptions): Promise<GitSourceResult> {
  const settings = validateGitSettings(input);
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1 || !Number.isSafeInteger(options.maxFiles) || options.maxFiles < 1)
    throw new AppError('INVALID_GIT_LIMIT', 'Git 파일 수·크기 제한은 양의 정수여야 합니다.');
  if (options.commit && !OID.test(options.commit)) throw new AppError('INVALID_GIT_COMMIT', '전체 Git commit SHA를 사용하세요.');
  const key = gitCachePath(options.dataDir, options.sourceId);
  if (busy.has(key)) throw new AppError('SOURCE_BUSY', '이 Git 소스는 이미 동기화 중입니다.', 409);
  busy.add(key);
  try {
    const cache = await prepareCache(settings, options); const warnings: string[] = [];
    if (!options.commit) {
      await runGit(options.gitPath, cache, ['fetch', '--no-recurse-submodules', '--no-tags', '--no-write-fetch-head', settings.url,
        `+refs/heads/${settings.branch}:refs/remotes/origin/tracked`, '+refs/tags/*:refs/tags/*'], { timeout: 120_000, action: 'Git 원격 동기화' });
    }
    const commit = decoder.decode(await runGit(options.gitPath, cache,
      ['rev-parse', '--verify', `${options.commit ?? 'refs/remotes/origin/tracked'}^{commit}`], { action: 'Git 커밋 확인' })).trim();
    if (!OID.test(commit)) throw new AppError('GIT_RESPONSE', 'Git commit 응답 형식이 잘못되었습니다.', 502);
    await runGit(options.gitPath, cache, ['update-ref', `refs/nexa/snapshots/${commit}`, commit], { action: 'Git 커밋 보존' });
    const tags = await listTags(settings, options, cache, warnings);
    const listing = decoder.decode(await runGit(options.gitPath, cache, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], { max: 64 * 1024 * 1024 }));
    const entries: Array<{ path: string; oid: string; size: number }> = []; let total = 0; let matched = 0;
    for (const line of listing.split('\0')) {
      if (!line) continue;
      const parsed = /^(\d+) (\w+) ([a-f0-9]+) +([\d-]+)\t([\s\S]+)$/.exec(line);
      if (!parsed) throw new AppError('GIT_RESPONSE', 'Git 파일 목록을 해석하지 못했습니다.', 502);
      const [, mode, type, oid, rawSize, path] = parsed as unknown as [string, string, string, string, string, string];
      const parts = path.split('/');
      if (parts.slice(0, -1).some(isExcludedDirectory)) continue;
      if (mode === '160000') { warnings.push(`Git submodule은 별도 소스로 등록하세요: ${path}`); continue; }
      if (mode === '120000') { warnings.push(`Git 심볼릭 링크를 제외했습니다: ${path}`); continue; }
      if (!isSupportedFile(path)) continue;
      if (parts.some(part => !part || part === '.' || part === '..') || /[\\:\x00-\x1f\x7f]/.test(path)) {
        warnings.push(`지원하지 않는 Git 파일 경로를 제외했습니다: ${path.replace(/[\x00-\x1f\x7f]/g, '?')}`); continue;
      }
      if (type !== 'blob' || !['100644', '100755'].includes(mode) || !OID.test(oid)) continue;
      matched++;
      if (matched > options.maxFiles) { warnings.push(`Git 파일 ${options.maxFiles}개 한도에 도달했습니다. 일부 자료가 제외되었습니다.`); break; }
      const size = Number(rawSize);
      if (!Number.isSafeInteger(size) || size < 0) throw new AppError('GIT_RESPONSE', '잘못된 Git 파일 크기입니다.', 502);
      if (size > options.maxFileBytes) { warnings.push(`파일 크기 제한을 초과했습니다: ${path}`); continue; }
      if (total + size > MAX_SOURCE_BYTES) { warnings.push('한 번의 Git 수집은 256 MiB까지 지원합니다. 일부 자료가 제외되었습니다.'); break; }
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
          throw new AppError('GIT_RESPONSE', 'Git blob 응답 크기 또는 ID가 일치하지 않습니다.', 502);
        const content = bytes.subarray(end + 1, end + 1 + entry.size); offset = end + 2 + entry.size;
        if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(new TextDecoder().decode(content.subarray(0, 256)))) {
          warnings.push(`Git LFS 원문을 읽지 못했습니다. 실제 파일이 있는 폴더 소스를 등록하세요: ${entry.path}`); continue;
        }
        files.push({ path: entry.path, bytes: content });
      }
      if (offset !== bytes.length) throw new AppError('GIT_RESPONSE', 'Git blob 응답에 예상하지 않은 데이터가 있습니다.', 502);
    }
    return { commit, files, warnings: warnings.slice(0, 200).concat(warnings.length > 200 ? [`추가 진단 ${warnings.length - 200}개 생략`] : []), tags };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('GIT_READ_FAILED', 'Git 캐시를 읽지 못했습니다. 데이터 폴더 접근 권한·디스크 공간을 확인하고 다시 동기화하세요.', 503);
  } finally { busy.delete(key); }
}
