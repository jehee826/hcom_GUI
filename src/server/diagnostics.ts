import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CliCheck {
  readonly ok: boolean;
  readonly path: string | null;
  readonly version: string | null;
  readonly error?: string;
}

export interface CliDiagnostics {
  readonly codex: CliCheck;
  readonly hcom: CliCheck;
  readonly agy: CliCheck;
  readonly cachedAt?: string;
}

function findWhere(command: string): string | null {
  try {
    const out = execFileSync('where', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000, windowsHide: true });
    const first = out.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

async function findWhereAsync(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('where', [command], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const first = stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

export function resolveExecutable(explicitPath: string | undefined, command: string, fallbacks: string[]): string | null {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  const fromPath = findWhere(command);
  if (fromPath && existsSync(fromPath)) return fromPath;
  for (const candidate of fallbacks) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return explicitPath || null;
}

export async function resolveExecutableAsync(explicitPath: string | undefined, command: string, fallbacks: string[]): Promise<string | null> {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  const fromPath = await findWhereAsync(command);
  if (fromPath && existsSync(fromPath)) return fromPath;
  for (const candidate of fallbacks) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return explicitPath || null;
}

export function defaultCodexCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return [join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')];
}

export function defaultHcomCandidates(): string[] {
  return [join(homedir(), '.local', 'bin', 'hcom.exe')];
}

export function defaultAgyCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return [join(localAppData, 'agy', 'bin', 'agy.exe')];
}

async function probeBinaryAsync(path: string | null): Promise<CliCheck> {
  if (!path) return { ok: false, path: null, version: null, error: '실행 파일을 찾을 수 없습니다.' };
  try {
    const { stdout } = await execFileAsync(path, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    return { ok: true, path, version: stdout.trim().split(/\r?\n/)[0]?.trim() || 'ok' };
  } catch (error) {
    return {
      ok: false,
      path,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runCliDiagnosticsAsync(codexCommand?: string): Promise<CliDiagnostics> {
  const [codexPath, hcomPath, agyPath] = await Promise.all([
    resolveExecutableAsync(codexCommand, 'codex', defaultCodexCandidates()),
    resolveExecutableAsync(undefined, 'hcom', defaultHcomCandidates()),
    resolveExecutableAsync(undefined, 'agy', defaultAgyCandidates()),
  ]);
  const [codex, hcom, agy] = await Promise.all([
    probeBinaryAsync(codexPath),
    probeBinaryAsync(hcomPath),
    probeBinaryAsync(agyPath),
  ]);
  return { codex, hcom, agy, cachedAt: new Date().toISOString() };
}

export function createDiagnosticsLoader(codexCommand?: string, ttlMs = 60_000): (refresh?: boolean) => Promise<CliDiagnostics> {
  let cache: { data: CliDiagnostics; expiresAt: number } | undefined;
  let inflight: Promise<CliDiagnostics> | undefined;

  return async (refresh = false): Promise<CliDiagnostics> => {
    if (!refresh && cache && Date.now() < cache.expiresAt) return cache.data;
    if (!inflight) {
      inflight = runCliDiagnosticsAsync(codexCommand)
        .then(data => {
          cache = { data, expiresAt: Date.now() + ttlMs };
          return data;
        })
        .finally(() => { inflight = undefined; });
    }
    return inflight;
  };
}
