import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {randomBytes} from 'node:crypto';

export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(env = process.env, root = resolve(import.meta.dir, '..')) {
  const dataDir = resolve(env.NEXA_DATA_DIR || join(root, 'data'));
  mkdirSync(dataDir, {recursive: true});
  const host = env.NEXA_HOST || '127.0.0.1';
  const apiKey = env.NEXA_API_KEY || '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && apiKey.length < 24)
    throw new Error('LAN 공개 시 NEXA_API_KEY에 24자 이상의 키를 설정하세요.');
  let adminKey = env.NEXA_ADMIN_KEY || '';
  const adminKeyPath = join(dataDir, 'admin-key.txt');
  if (!adminKey) {
    try { adminKey = readFileSync(adminKeyPath, 'utf8').trim(); } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      adminKey = randomBytes(32).toString('hex');
      writeFileSync(adminKeyPath, adminKey + '\n', {flag:'wx', mode:0o600});
    }
  }
  if (adminKey.length < 24) throw new Error('NEXA_ADMIN_KEY 또는 admin-key.txt에는 24자 이상의 키가 필요합니다.');
  function localURL(value: string) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname))
      throw new Error('모델/Qdrant 주소는 이 서버의 loopback 주소여야 합니다.');
    return value.replace(/\/$/, '');
  }
  const port = Number(env.NEXA_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('잘못된 NEXA_PORT');
  return {
    root, dataDir, host, port, apiKey, adminKey, adminKeyPath, mode: env.NEXA_MODE === 'keyword' ? 'keyword' : 'full',
    generationURL: localURL(env.NEXA_GENERATION_URL || 'http://127.0.0.1:18181'),
    embeddingURL: localURL(env.NEXA_EMBEDDING_URL || 'http://127.0.0.1:18182'),
    qdrantURL: localURL(env.NEXA_QDRANT_URL || 'http://127.0.0.1:16333'),
    allowedOrigins: (env.NEXA_ALLOWED_ORIGINS || '').split(',').map(x=>x.trim()).filter(Boolean),
    pdfToTextPath: join(root,'.runtime','poppler','Library','bin','pdftotext.exe'),
    treeSitterDir: join(root,'vendor','tree-sitter'),
    pandocPath: env.NEXA_PANDOC_PATH || join(root,'.runtime','pandoc','pandoc.exe'),
    gitPath: env.NEXA_GIT_PATH || join(root,'.runtime','git','cmd','git.exe'),
    syncIntervalMs: Math.max(1000, Number(env.NEXA_SYNC_INTERVAL_MS) || 300_000),
    debounceMs: Math.max(20, Number(env.NEXA_DEBOUNCE_MS) || 2000),
    maxFileBytes: 20 * 1024 * 1024,
    maxUploadBytes: 100 * 1024 * 1024,
    maxFiles: 100_000,
    collection: 'nexa_embeddinggemma_768_v1',
  };
}
