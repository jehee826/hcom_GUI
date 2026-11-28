import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { CodexSession } from '../codex/index.ts';
import { defaultAgyCandidates, defaultCodexCandidates, resolveExecutable } from './diagnostics.ts';

const execFileAsync = promisify(execFile);

export interface ModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly efforts: string[];
  readonly defaultEffort: string | null;
  readonly isDefault: boolean;
}

export interface ModelCatalog {
  readonly codex: ModelOption[];
  readonly agy: ModelOption[];
  readonly codexLive?: boolean;
  readonly agyLive?: boolean;
  readonly cachedAt: string;
}

const DEFAULT_CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DEFAULT_CODEX_FALLBACK: ModelOption[] = [
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: DEFAULT_CODEX_EFFORTS, defaultEffort: 'medium', isDefault: true },
  { id: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', efforts: DEFAULT_CODEX_EFFORTS, defaultEffort: 'low', isDefault: false },
];

const DEFAULT_AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_AGY_FALLBACK: ModelOption[] = [
  { id: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)', efforts: DEFAULT_AGY_EFFORTS, defaultEffort: 'high', isDefault: true },
  { id: 'gemini-4-neon-medium', displayName: 'Gemini 4 Neon (Medium)', efforts: DEFAULT_AGY_EFFORTS, defaultEffort: 'medium', isDefault: false },
  { id: 'gemini-4-carbon-high', displayName: 'Gemini 4 Carbon (High)', efforts: DEFAULT_AGY_EFFORTS, defaultEffort: 'high', isDefault: false },
  { id: 'claude-sonnet-5-5-high', displayName: 'Claude Sonnet 5.5 (High)', efforts: DEFAULT_AGY_EFFORTS, defaultEffort: 'high', isDefault: false },
  { id: 'claude-opus-5-5-high', displayName: 'Claude Opus 5.5 (High)', efforts: DEFAULT_AGY_EFFORTS, defaultEffort: 'high', isDefault: false },
];

export function parseAgyModelsOutput(stdout: string): ModelOption[] {
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^fetching/i.test(line)) continue;
    const match = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._:-]+)\s+(.+)$/);
    if (!match) continue;
    const id = match[1]!;
    const displayName = match[2]!.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const effortMatch = id.match(/-(low|medium|high|xhigh|max)$/i);
    models.push({
      id,
      displayName,
      efforts: DEFAULT_AGY_EFFORTS,
      defaultEffort: effortMatch ? effortMatch[1]!.toLowerCase() : null,
      isDefault: models.length === 0,
    });
  }
  return models;
}

export function parseCodexModelList(result: Record<string, unknown>): ModelOption[] {
  const raw = Array.isArray(result.data) ? result.data : [];
  const models: ModelOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (obj.hidden === true) continue;
    const id = typeof obj.model === 'string' ? obj.model : (typeof obj.id === 'string' ? obj.id : '');
    if (!id) continue;
    const displayName = typeof obj.displayName === 'string' && obj.displayName.trim() ? obj.displayName.trim() : id;
    const rawEfforts = Array.isArray(obj.supportedReasoningEfforts) ? obj.supportedReasoningEfforts : [];
    const efforts = rawEfforts
      .map(entry => (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).reasoningEffort === 'string')
        ? String((entry as Record<string, unknown>).reasoningEffort)
        : '')
      .filter(Boolean);
    const defaultEffort = typeof obj.defaultReasoningEffort === 'string' ? obj.defaultReasoningEffort : (efforts[0] ?? null);
    models.push({
      id,
      displayName,
      efforts: efforts.length > 0 ? efforts : DEFAULT_CODEX_EFFORTS,
      defaultEffort,
      isDefault: obj.isDefault === true,
    });
  }
  return models;
}

async function fetchCodexModels(codexCommand?: string): Promise<{ models: ModelOption[]; live: boolean }> {
  const bin = resolveExecutable(codexCommand, 'codex', defaultCodexCandidates());
  if (!bin) return { models: DEFAULT_CODEX_FALLBACK, live: false };
  let session: CodexSession | undefined;
  try {
    session = await CodexSession.connect({
      command: bin,
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 20_000,
    });
    const result = await session.listModels();
    const parsed = parseCodexModelList(result);
    return parsed.length > 0
      ? { models: parsed, live: true }
      : { models: DEFAULT_CODEX_FALLBACK, live: false };
  } catch {
    return { models: DEFAULT_CODEX_FALLBACK, live: false };
  } finally {
    await session?.close().catch(() => {});
  }
}

async function fetchAgyModels(): Promise<{ models: ModelOption[]; live: boolean }> {
  const bin = resolveExecutable(undefined, 'agy', defaultAgyCandidates());
  if (!bin) return { models: DEFAULT_AGY_FALLBACK, live: false };
  try {
    const { stdout } = await execFileAsync(bin, ['models'], {
      encoding: 'utf8',
      timeout: 25_000,
      windowsHide: true,
    });
    const parsed = parseAgyModelsOutput(stdout);
    return parsed.length > 0
      ? { models: parsed, live: true }
      : { models: DEFAULT_AGY_FALLBACK, live: false };
  } catch {
    return { models: DEFAULT_AGY_FALLBACK, live: false };
  }
}

function readDiskCache(cacheFilePath?: string): ModelCatalog | undefined {
  if (!cacheFilePath || !existsSync(cacheFilePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(cacheFilePath, 'utf8')) as Partial<ModelCatalog>;
    if (Array.isArray(parsed.codex) && parsed.codex.length > 0 && Array.isArray(parsed.agy) && parsed.agy.length > 0) {
      return {
        codex: parsed.codex,
        agy: parsed.agy,
        codexLive: Boolean(parsed.codexLive),
        agyLive: Boolean(parsed.agyLive),
        cachedAt: typeof parsed.cachedAt === 'string' ? parsed.cachedAt : new Date().toISOString(),
      };
    }
  } catch {}
  return undefined;
}

function writeDiskCache(cacheFilePath: string | undefined, catalog: ModelCatalog): void {
  if (!cacheFilePath) return;
  try {
    writeFileSync(cacheFilePath, JSON.stringify(catalog), 'utf8');
  } catch {}
}

export function createModelCatalogLoader(codexCommand?: string, ttlMs = 5 * 60_000, cacheFilePath?: string) {
  let cache: { catalog: ModelCatalog; expiresAt: number } | undefined;
  const diskSeed = readDiskCache(cacheFilePath);
  if (diskSeed && diskSeed.codexLive && diskSeed.agyLive) {
    // 디스크 캐시는 CLI 조회 실패 시 안전망으로 보관하되, 앱 시작 시 항상 최신 CLI 모델 목록을 백그라운드로 재조회한다.
    cache = { catalog: diskSeed, expiresAt: 0 };
  }
  let inflight: Promise<ModelCatalog> | undefined;

  return async (refresh = false): Promise<ModelCatalog> => {
    if (!refresh && cache && Date.now() < cache.expiresAt) return cache.catalog;
    if (!inflight) {
      inflight = Promise.all([fetchCodexModels(codexCommand), fetchAgyModels()])
        .then(([codexRes, agyRes]) => {
          const prev = cache?.catalog ?? diskSeed;
          const codex = codexRes.live ? codexRes.models : (prev?.codexLive ? prev.codex : codexRes.models);
          const agy = agyRes.live ? agyRes.models : (prev?.agyLive ? prev.agy : agyRes.models);
          const codexLive = codexRes.live || Boolean(prev?.codexLive);
          const agyLive = agyRes.live || Boolean(prev?.agyLive);
          const catalog: ModelCatalog = {
            codex,
            agy,
            codexLive,
            agyLive,
            cachedAt: new Date().toISOString(),
          };
          // 실패한 폴백은 5분 캐시하지 않고 5초 뒤 재시도한다.
          const nextTtl = codexLive && agyLive ? ttlMs : 5_000;
          cache = { catalog, expiresAt: Date.now() + nextTtl };
          if (codexRes.live || agyRes.live) {
            writeDiskCache(cacheFilePath, catalog);
          }
          return catalog;
        })
        .finally(() => { inflight = undefined; });
    }
    return inflight;
  };
}
