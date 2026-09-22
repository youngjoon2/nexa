import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gitCachePath, readGitSource, validateGitSettings, type GitReadOptions, type GitSettings } from '../src/connectors';

const bundledGit = resolve(import.meta.dir, '../.runtime/git/cmd/git.exe');
const gitPath = process.env.NEXA_TEST_GIT || (existsSync(bundledGit) ? bundledGit : 'git');
const settings: GitSettings = { url: 'https://github.com/nexa-fixture/example.git', branch: 'main' };
let temporary: string; let working: string; let cache: string; let first: string; let second: string; let options: GitReadOptions;

async function git(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn([gitPath, ...args], { stdin: input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (input !== undefined) { (child.stdin as any).write(input); (child.stdin as any).end(); }
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error('Fixture Git command failed: ' + err);
  return out.trim();
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'nexa-git-connector-test-'));
  working = join(temporary, 'developers-workspace'); await mkdir(working);
  await git(['init', '--initial-branch=main', working]);
  await git(['-C', working, 'config', 'core.autocrlf', 'false']);
  await mkdir(join(working, 'src')); await mkdir(join(working, 'vendor'));
  await writeFile(join(working, 'README.md'), '# Firmware\nUART is 115200.\n');
  await writeFile(join(working, 'src', 'uart.c'), 'int uart_speed(void) { return 115200; }\n');
  await writeFile(join(working, 'big.md'), 'large '.repeat(200));
  await writeFile(join(working, 'vendor', 'hidden.md'), 'excluded dependency source');
  await writeFile(join(working, 'image.png'), new Uint8Array([0, 1, 2, 3]));
  await writeFile(join(working, 'manual.docx'), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 4321\n');
  await git(['-C', working, 'add', '.']);
  await git(['-C', working, '-c', 'user.name=Nexa Test', '-c', 'user.email=nexa@example.invalid', 'commit', '-m', 'Initial fixture']);
  first = await git(['-C', working, 'rev-parse', 'HEAD']);
  await git(['-C', working, 'branch', 'release', first]);
  await git(['-C', working, 'tag', 'v1.0.0']);
  await writeFile(join(working, 'src', 'uart.c'), 'int uart_speed(void) { return 921600; }\n');
  await git(['-C', working, 'add', 'src/uart.c']);
  const linkedBlob = await git(['-C', working, 'hash-object', '-w', '--stdin'], '../outside.md');
  await git(['-C', working, 'update-index', '--add', '--cacheinfo', `120000,${linkedBlob},linked.md`]);
  await git(['-C', working, 'update-index', '--add', '--cacheinfo', `160000,${first},external-sdk`]);
  await git(['-C', working, '-c', 'user.name=Nexa Test', '-c', 'user.email=nexa@example.invalid', 'commit', '-m', 'Second fixture']);
  second = await git(['-C', working, 'rev-parse', 'HEAD']);
  await git(['-C', working, '-c', 'user.name=Nexa Test', '-c', 'user.email=nexa@example.invalid', 'tag', '-a', 'v2.0.0', '-m', 'Release two']);
  const dataDir = join(temporary, 'data');
  cache = gitCachePath(dataDir, 'source-fixture'); await mkdir(join(dataDir, 'git-cache'), { recursive: true });
  await git(['clone', '--bare', '--no-hardlinks', working, cache]);
  await writeFile(join(cache, 'nexa-owner.json'), JSON.stringify({ version: 1, sourceId: 'source-fixture', url: settings.url }));
  options = { dataDir, sourceId: 'source-fixture', gitPath, maxFiles: 100, maxFileBytes: 1024 * 1024, commit: second };
}, 30_000);

afterAll(async () => {
  if (temporary && resolve(temporary).startsWith(resolve(tmpdir()) + sep + 'nexa-git-connector-test-'))
    await rm(temporary, { recursive: true, force: true });
});

describe('Git connector remote boundaries', () => {
  test('accepts credential-free GitHub and Bitbucket addresses and preserves branch paths', () => {
    expect(validateGitSettings({ url: 'git@github.com:team/repo', branch: 'release/2.0' }))
      .toEqual({ url: 'ssh://git@github.com/team/repo.git', branch: 'release/2.0', tagPattern: '*' });
    expect(validateGitSettings({ url: 'https://bitbucket.org/team/repo/', branch: 'main', tagPattern: 'v2.*' }).url)
      .toBe('https://bitbucket.org/team/repo.git');
  });

  test('rejects local paths, command transports, unapproved hosts and credentials without echoing tokens', async () => {
    for (const url of ['C:\\projects\\repo', 'file:///tmp/repo', 'ext::command', 'https://127.0.0.1/team/repo',
      'https://github.com.evil.invalid/team/repo', 'https://private-secret@github.com/team/repo',
      'https://name:private-secret@github.com/team/repo', 'https://github.com/team/repo?token=private-secret']) {
      let message = '';
      try { validateGitSettings({ url, branch: 'main' }); } catch (error: any) { message = error.message; }
      expect(message).toBeTruthy(); expect(message).not.toContain('private-secret');
    }
    await expect(readGitSource({ ...settings, branch: 'main:refs/heads/other' }, options)).rejects.toMatchObject({ code: 'INVALID_GIT_BRANCH' });
    await expect(readGitSource(settings, { ...options, sourceId: '../escape' })).rejects.toMatchObject({ code: 'INVALID_SOURCE_ID' });
    await expect(readGitSource(settings, { ...options, commit: 'HEAD~1' })).rejects.toMatchObject({ code: 'INVALID_GIT_COMMIT' });
  });
});

describe('immutable Git object ingestion', () => {
  test('initializes an owned bare cache and fetches the selected branch with noninteractive Git', async () => {
    const original = Bun.spawn.bind(Bun);
    let remoteCalls = 0;
    const spawn = spyOn(Bun, 'spawn');
    spawn.mockImplementation(((command: string[], processOptions: any) => {
      if (Array.isArray(command) && command.includes('fetch')) {
        remoteCalls++;
        expect(command).toContain('+refs/heads/release:refs/remotes/origin/tracked');
        expect(command).toContain('--no-recurse-submodules');
        expect(processOptions.env.GIT_TERMINAL_PROMPT).toBe('0');
        expect(processOptions.env.GCM_INTERACTIVE).toBe('never');
        expect(processOptions.env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
        // Only the test transport is replaced. All production arguments, bare-cache creation,
        // fetching, tag peeling and blob reads still execute in the real bundled Git.
        const fixtureCommand = command.map(value => value === settings.url ? working : value);
        fixtureCommand.splice(1, 0, '-c', 'protocol.file.allow=always');
        return original(fixtureCommand, processOptions);
      }
      return original(command, processOptions);
    }) as any);
    try {
      const result = await readGitSource({ ...settings, branch: 'release' }, { ...options, sourceId: 'fresh-cache', commit: undefined });
      expect(result.commit).toBe(first);
      expect(remoteCalls).toBe(1);
      expect(new TextDecoder().decode(result.files.find(file => file.path === 'src/uart.c')!.bytes)).toContain('115200');
      expect(await git(['-C', working, 'rev-parse', 'HEAD'])).toBe(second);
    } finally { spawn.mockRestore(); }
  });

  test('reads a historical commit and tags without changing the developer branch, working files or index', async () => {
    const before = await git(['-C', working, 'status', '--porcelain=v1']);
    const contents = await readFile(join(working, 'src', 'uart.c'), 'utf8');
    const result = await readGitSource(settings, { ...options, commit: first });
    expect(result.commit).toBe(first);
    expect(new TextDecoder().decode(result.files.find(file => file.path === 'src/uart.c')!.bytes)).toContain('115200');
    expect(result.files.some(file => file.path.startsWith('vendor/'))).toBe(false);
    expect(result.files.some(file => file.path.endsWith('.png'))).toBe(false);
    expect(result.files.some(file => file.path.endsWith('.docx'))).toBe(false);
    expect(result.warnings.some(warning => warning.includes('Git LFS'))).toBe(true);
    expect(result.tags).toEqual([{ name: 'v1.0.0', commit: first }, { name: 'v2.0.0', commit: second }]);
    expect(await git(['-C', working, 'rev-parse', 'HEAD'])).toBe(second);
    expect(await git(['-C', working, 'status', '--porcelain=v1'])).toBe(before);
    expect(await readFile(join(working, 'src', 'uart.c'), 'utf8')).toBe(contents);
    expect(await git(['--git-dir', cache, 'rev-parse', `refs/nexa/snapshots/${first}`])).toBe(first);
  });

  test('skips submodules and symlinks and resolves annotated tag commits using a simple tag glob', async () => {
    const result = await readGitSource({ ...settings, tagPattern: 'v?.0.0' }, options);
    expect(new TextDecoder().decode(result.files.find(file => file.path === 'src/uart.c')!.bytes)).toContain('921600');
    expect(result.warnings.some(warning => warning.includes('submodule'))).toBe(true);
    expect(result.warnings.some(warning => warning.includes('symbolic link'))).toBe(true);
    expect(result.files.some(file => file.path === 'linked.md' || file.path === 'external-sdk')).toBe(false);
    expect(result.tags.length).toBe(2);
    const filtered = await readGitSource({ ...settings, tagPattern: 'v1.*' }, options);
    expect(filtered.tags).toEqual([{ name: 'v1.0.0', commit: first }]);
  });

  test('reports file count and byte limits rather than silently truncating input', async () => {
    const byteLimited = await readGitSource(settings, { ...options, maxFileBytes: 256 });
    expect(byteLimited.files.some(file => file.path === 'big.md')).toBe(false);
    expect(byteLimited.warnings.some(warning => warning.includes('size limit'))).toBe(true);
    const fileLimited = await readGitSource(settings, { ...options, maxFiles: 1 });
    expect(fileLimited.files.length).toBe(1);
    expect(fileLimited.warnings.some(warning => warning.includes('file limit of 1'))).toBe(true);
  });

  test('refuses an unrelated cache and returns actionable errors for missing commits', async () => {
    await expect(readGitSource({ ...settings, url: 'https://github.com/someone/else.git' }, options)).rejects.toMatchObject({ code: 'GIT_CACHE_OWNER' });
    await expect(readGitSource(settings, { ...options, commit: '0'.repeat(40) })).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(readGitSource(settings, { ...options, gitPath: join(temporary, 'missing-git.exe') })).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' });
    expect(await git(['--git-dir', cache, 'rev-parse', '--is-bare-repository'])).toBe('true');
  });
});
