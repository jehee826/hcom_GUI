import { execFile } from 'node:child_process';
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
  readonly cachedAt: string;
}

const DEFAULT_CODEX_FALLBACK: ModelOption[] = [
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', isDefault: true },
  { id: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low', isDefault: false },
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
      efforts: efforts.length > 0 ? efforts : ['low', 'medium', 'high'],
      defaultEffort,
      isDefault: obj.isDefault === true,
    });
  }
  return models;
}

async function fetchCodexModels(codexCommand?: string): Promise<ModelOption[]> {
  const bin = resolveExecutable(codexCommand, 'codex', defaultCodexCandidates());
  if (!bin) return DEFAULT_CODEX_FALLBACK;
  let session: CodexSession | undefined;
  try {
    session = await CodexSession.connect({
      command: bin,
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 8000,
    });
    const result = await session.listModels();
    const parsed = parseCodexModelList(result);
    return parsed.length > 0 ? parsed : DEFAULT_CODEX_FALLBACK;
  } catch {
    return DEFAULT_CODEX_FALLBACK;
  } finally {
    await session?.close().catch(() => {});
  }
}

async function fetchAgyModels(): Promise<ModelOption[]> {
  const bin = resolveExecutable(undefined, 'agy', defaultAgyCandidates());
  if (!bin) return DEFAULT_AGY_FALLBACK;
  try {
    const { stdout } = await execFileAsync(bin, ['models'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    const parsed = parseAgyModelsOutput(stdout);
    return parsed.length > 0 ? parsed : DEFAULT_AGY_FALLBACK;
  } catch {
    return DEFAULT_AGY_FALLBACK;
  }
}

export function createModelCatalogLoader(codexCommand?: string, ttlMs = 5 * 60_000) {
  let cache: { catalog: ModelCatalog; expiresAt: number } | undefined;
  let inflight: Promise<ModelCatalog> | undefined;

  return async (refresh = false): Promise<ModelCatalog> => {
    if (!refresh && cache && Date.now() < cache.expiresAt) return cache.catalog;
    if (!inflight) {
      inflight = Promise.all([fetchCodexModels(codexCommand), fetchAgyModels()])
        .then(([codex, agy]) => {
          const catalog: ModelCatalog = { codex, agy, cachedAt: new Date().toISOString() };
          cache = { catalog, expiresAt: Date.now() + ttlMs };
          return catalog;
        })
        .finally(() => { inflight = undefined; });
    }
    return inflight;
  };
}
