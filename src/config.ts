import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {randomBytes} from 'node:crypto';

export type LlmProvider = 'local' | 'openai' | 'anthropic' | 'github-copilot';

export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(env = process.env, root = resolve(import.meta.dir, '..')) {
  const dataDir = resolve(env.NEXA_DATA_DIR || join(root, 'data'));
  mkdirSync(dataDir, {recursive: true});
  const host = env.NEXA_HOST || '127.0.0.1';
  const apiKey = env.NEXA_API_KEY || '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && apiKey.length < 24)
    throw new Error('Set NEXA_API_KEY to at least 24 characters before enabling LAN access.');
  let adminKey = env.NEXA_ADMIN_KEY || '';
  const adminKeyPath = join(dataDir, 'admin-key.txt');
  if (!adminKey) {
    try { adminKey = readFileSync(adminKeyPath, 'utf8').trim(); } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      adminKey = randomBytes(32).toString('hex');
      writeFileSync(adminKeyPath, adminKey + '\n', {flag:'wx', mode:0o600});
    }
  }
  if (adminKey.length < 24) throw new Error('NEXA_ADMIN_KEY or admin-key.txt requires a key of at least 24 characters.');
  function localURL(value: string) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname))
      throw new Error('Model and Qdrant URLs must use a loopback address on this server.');
    return value.replace(/\/$/, '');
  }
  function providerURL(value: string) {
    const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol === 'http:' && !loopback))
      throw new Error('External LLM base URLs must use HTTPS (or HTTP on a loopback address).');
    return value.replace(/\/$/, '');
  }
  const llmProvider = (env.NEXA_LLM_PROVIDER || 'local').trim().toLowerCase() as LlmProvider;
  if (!['local', 'openai', 'anthropic', 'github-copilot'].includes(llmProvider))
    throw new Error('NEXA_LLM_PROVIDER must be local, openai, anthropic, or github-copilot.');
  const providerKey = llmProvider === 'openai'
    ? env.OPENAI_API_KEY
    : llmProvider === 'anthropic'
      ? env.ANTHROPIC_API_KEY
      : llmProvider === 'github-copilot'
        ? (env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN)
        : '';
  const llmApiKey = (env.NEXA_LLM_API_KEY || providerKey || '').trim();
  if (llmProvider !== 'local' && !llmApiKey) throw new Error(`Set an API key for the ${llmProvider} LLM provider before starting Nexa.`);
  const defaultModels: Record<Exclude<LlmProvider, 'local'>, string> = {
    openai: 'gpt-5-mini',
    anthropic: 'claude-sonnet-4-5-20250929',
    'github-copilot': 'gpt-5.4',
  };
  const llmModel = (env.NEXA_LLM_MODEL || (llmProvider === 'local' ? 'qwen35-4b' : defaultModels[llmProvider as Exclude<LlmProvider, 'local'>])).trim();
  if (!llmModel || llmModel.length > 200) throw new Error('NEXA_LLM_MODEL must be between 1 and 200 characters.');
  const llmBaseURL = llmProvider === 'openai'
    ? providerURL(env.NEXA_LLM_BASE_URL || 'https://api.openai.com/v1')
    : llmProvider === 'anthropic'
      ? providerURL(env.NEXA_LLM_BASE_URL || 'https://api.anthropic.com')
      : '';
  const llmTimeoutMs = Number(env.NEXA_LLM_TIMEOUT_MS || 120_000);
  if (!Number.isInteger(llmTimeoutMs) || llmTimeoutMs < 5_000 || llmTimeoutMs > 600_000) throw new Error('NEXA_LLM_TIMEOUT_MS must be between 5000 and 600000.');
  const port = Number(env.NEXA_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid NEXA_PORT');
  return {
    root, dataDir, host, port, apiKey, adminKey, adminKeyPath, mode: env.NEXA_MODE === 'keyword' ? 'keyword' : 'full',
    llmProvider, llmApiKey, llmModel, llmBaseURL, llmTimeoutMs,
    copilotCliPath: env.COPILOT_CLI_PATH || '',
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
