import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexSandboxMode } from '../src/codex/index.ts';
import { ProjectManager } from '../src/runtime/index.ts';
import { defaultCodexCandidates, resolveExecutable } from '../src/server/diagnostics.ts';
import { startGuiServer } from '../src/server/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveDataDir(): string {
  if (process.env.HCOM_GUI_DATA_DIR?.trim()) return resolve(process.env.HCOM_GUI_DATA_DIR.trim());
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'hcom_gui');
}

function resolveSandboxMode(): CodexSandboxMode {
  const raw = process.env.HCOM_GUI_CODEX_SANDBOX?.trim();
  if (raw === 'read-only' || raw === 'workspace-write' || raw === 'danger-full-access') return raw;
  return 'danger-full-access';
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes('--no-build')) {
    const res = spawnSync(process.execPath, [join(root, 'scripts', 'build.ts')], {
      cwd: root,
      stdio: 'inherit',
    });
    if (res.status !== 0) process.exit(res.status ?? 1);
  }

  const staticDir = join(root, 'dist', 'web');
  if (!existsSync(join(staticDir, 'index.html'))) {
    throw new Error(`웹 정적 빌드 결과물이 없습니다: ${staticDir}`);
  }

  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  const codexCommand = resolveExecutable(process.env.HCOM_GUI_CODEX_PATH, 'codex', defaultCodexCandidates()) ?? 'codex';
  const portEnv = Number.parseInt(process.env.HCOM_GUI_PORT ?? '43120', 10);
  const preferredPort = Number.isSafeInteger(portEnv) && portEnv >= 0 ? portEnv : 43120;

  const manager = new ProjectManager({
    dataDir,
    codexCommand,
    model: process.env.HCOM_GUI_MODEL || undefined,
    codexEffort: process.env.HCOM_GUI_EFFORT || undefined,
    codexSandbox: resolveSandboxMode(),
  });

  let handle;
  try {
    handle = await startGuiServer({
      manager,
      appVersion: readVersion(),
      staticDir,
      port: preferredPort,
      token: process.env.HCOM_GUI_TOKEN || undefined,
      codexCommand,
    });
  } catch {
    handle = await startGuiServer({
      manager,
      appVersion: readVersion(),
      staticDir,
      port: 0,
      token: process.env.HCOM_GUI_TOKEN || undefined,
      codexCommand,
    });
  }

  const url = `${handle.baseUrl}/?token=${encodeURIComponent(handle.token)}`;
  console.log('');
  console.log('============================================================');
  console.log('  hcom_gui 웹 개발 서버 실행 중 (설치 없이 브라우저 검증)');
  console.log(`  접속 주소: ${url}`);
  console.log(`  데이터 경로: ${dataDir}`);
  console.log('  종료: Ctrl+C');
  console.log('============================================================');
  console.log('');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('[dev:web] 서버 연결을 정리합니다 (실행 중인 워커 세션은 유지)...');
    await handle.close().catch(() => {});
    await manager.detachAll().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

void main().catch(error => {
  console.error('[dev:web] 실행 실패:', error);
  process.exit(1);
});
