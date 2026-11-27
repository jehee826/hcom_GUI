import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export function resolveExecutable(explicitPath: string | undefined, command: string, fallbacks: string[]): string | null {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  const fromPath = findWhere(command);
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

function probeBinary(path: string | null): CliCheck {
  if (!path) return { ok: false, path: null, version: null, error: '실행 파일을 찾을 수 없습니다.' };
  try {
    const stdout = execFileSync(path, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 4000,
      windowsHide: true,
    }).trim();
    return { ok: true, path, version: stdout.split(/\r?\n/)[0]?.trim() || 'ok' };
  } catch (error) {
    return {
      ok: false,
      path,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function runCliDiagnostics(codexCommand?: string): CliDiagnostics {
  return {
    codex: probeBinary(resolveExecutable(codexCommand, 'codex', defaultCodexCandidates())),
    hcom: probeBinary(resolveExecutable(undefined, 'hcom', defaultHcomCandidates())),
    agy: probeBinary(resolveExecutable(undefined, 'agy', defaultAgyCandidates())),
  };
}
