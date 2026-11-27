import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface RuntimeInfo {
  baseUrl: string;
  token: string;
  version: string;
  dataDir: string;
  pid: number;
}

interface ProjectSnapshot {
  project: { projectId: string; name: string; rootPath: string; hcomDir: string };
  codex: { cwd: string; threadId: string | null; hcomName: string | null; status: string };
  workers: Array<{ workerId: string; name: string; hcomName: string | null; conversationId: string | null; status: string; cwd: string }>;
  handoff: { branchStatus: string; lastWorkerReport: string | null; lastCodexReview: string | null };
}

interface SseEvent {
  seq: number;
  projectId: string;
  kind: string;
  payload: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function createRepo(root: string, branch: string, marker: string): string {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-b', branch]);
  git(root, ['config', 'user.email', 'verify@hcom-gui.local']);
  git(root, ['config', 'user.name', 'hcom-gui-verify']);
  writeFileSync(join(root, 'PROJECT_MARKER.txt'), `${marker}\n`, 'utf8');
  git(root, ['add', 'PROJECT_MARKER.txt']);
  git(root, ['commit', '-m', `init ${marker}`]);
  return root;
}

async function waitForFile<T>(filePath: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf8').trim();
      if (raw) {
        try {
          return JSON.parse(raw) as T;
        } catch {}
      }
    }
    await sleep(300);
  }
  throw new Error(`런타임 정보 파일 대기 시간 초과: ${filePath}`);
}

async function api<T>(info: RuntimeInfo, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${info.baseUrl}${path}`, {
    ...init,
    headers: {
      'x-hcom-token': info.token,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`API 실패 ${res.status} ${path}: ${JSON.stringify(data)}`);
  }
  return data as T;
}

function openSse(info: RuntimeInfo, projectId: string): { events: SseEvent[]; close: () => void } {
  const events: SseEvent[] = [];
  const controller = new AbortController();
  const url = `${info.baseUrl}/api/projects/${encodeURIComponent(projectId)}/events?token=${encodeURIComponent(info.token)}&afterSeq=0`;
  void (async () => {
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf('\n\n');
        while (idx >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split(/\r?\n/)) {
            if (line.startsWith('data: ')) {
              try {
                events.push(JSON.parse(line.slice(6)) as SseEvent);
              } catch {}
            }
          }
          idx = buf.indexOf('\n\n');
        }
      }
    } catch {}
  })();
  return { events, close: () => controller.abort() };
}

async function waitForRequestDone(info: RuntimeInfo, projectId: string, requestId: string, timeoutMs = 240_000): Promise<{
  request: { status: string; finalText: string | null; error: string | null };
  delegations: Array<{ replyText: string | null; requestEventId: number | null; replyEventId: number | null }>;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await api<{
      request: { status: string; finalText: string | null; error: string | null };
      delegations: Array<{ replyText: string | null; requestEventId: number | null; replyEventId: number | null }>;
    }>(info, `/api/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}`);
    if (data.request.status === 'completed' || data.request.status === 'failed' || data.request.status === 'interrupted') {
      return data;
    }
    await sleep(1500);
  }
  throw new Error(`요청 완료 대기 시간 초과: ${projectId}/${requestId}`);
}

async function captureViaCdp(port: number, outPngPath: string, jsBeforeCapture?: string): Promise<Record<string, unknown>> {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error('CDP page 대상을 찾지 못했습니다.');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolveReady, rejectReady) => {
    ws.addEventListener('open', () => resolveReady(), { once: true });
    ws.addEventListener('error', err => rejectReady(err), { once: true });
  });

  let nextId = 1;
  const sendCdp = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((res, rej) => {
      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
        if (msg.id !== id) return;
        ws.removeEventListener('message', onMessage);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result ?? {});
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  try {
    await sendCdp('Page.enable');
    await sendCdp('Runtime.enable');
    if (jsBeforeCapture) {
      await sendCdp('Page.reload', { ignoreCache: true });
      await sleep(1600);
      await sendCdp('Runtime.evaluate', { expression: jsBeforeCapture, awaitPromise: true });
      await sleep(700);
    }
    const evalRes = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        const bodyColor = getComputedStyle(document.body).color;
        const sidebarBg = getComputedStyle(document.getElementById('leftSidebar')).backgroundColor;
        const headerProject = document.getElementById('headerProjectName')?.textContent ?? '';
        const hcomCount = document.getElementById('hcomLogCount')?.textContent ?? '';
        const projectItems = [...document.querySelectorAll('.project-item-name')].map(n => n.textContent);
        return { bodyBg, bodyColor, sidebarBg, headerProject, hcomCount, projectItems };
      })()`,
      returnByValue: true,
    });
    const shot = await sendCdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(outPngPath, Buffer.from(String(shot.data), 'base64'));
    return ((evalRes.result as { value?: Record<string, unknown> } | undefined)?.value) ?? {};
  } finally {
    ws.close();
  }
}

async function main(): Promise<void> {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const installedExe = process.env.HCOM_GUI_EXE_PATH
    ? resolve(process.env.HCOM_GUI_EXE_PATH)
    : join(localAppData, 'Programs', 'hcom_gui', 'hcom_gui.exe');
  assert.ok(existsSync(installedExe), `설치된 실행 파일을 찾을 수 없습니다: ${installedExe}`);

  const baseTmp = resolve(process.cwd(), '..', 'tmp', 'hcom-gui-installed-verify');
  mkdirSync(baseTmp, { recursive: true });
  const runDir = mkdtempSync(join(baseTmp, 'run-'));
  const repoA = createRepo(join(runDir, 'repo-alpha'), 'gui-branch-a', 'ALPHA_MARKER_101');
  const repoB = createRepo(join(runDir, 'repo-beta'), 'gui-branch-b', 'BETA_MARKER_202');
  const dataDir = join(runDir, 'data');
  const infoFile = join(runDir, 'runtime-info.json');
  const cdpPort = 9233;

  console.log('[verify-installed] exe:', installedExe);
  console.log('[verify-installed] runDir:', runDir);

  const workerSettings = JSON.stringify({
    agentMode: '',
    toolPermission: 'always-proceed',
    trustedWorkspaces: [repoA, repoB],
  });

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HCOM_GUI_DATA_DIR: dataDir,
    HCOM_GUI_TEST_INFO_FILE: infoFile,
    HCOM_GUI_WORKER_SETTINGS: workerSettings,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(installedExe, [`--remote-debugging-port=${cdpPort}`], {
    env: childEnv,
    stdio: 'ignore',
    windowsHide: false,
  });

  let sseA: { events: SseEvent[]; close: () => void } | null = null;
  let sseB: { events: SseEvent[]; close: () => void } | null = null;
  let info: RuntimeInfo | null = null;
  let projAId = '';
  let projBId = '';

  try {
    info = await waitForFile<RuntimeInfo>(infoFile, 30_000);
    console.log('[verify-installed] started:', info.baseUrl, 'version:', info.version, 'pid:', info.pid);

    const health = await api<{ ok: boolean; version: string; dataDir: string }>(info, '/api/health');
    assert.equal(health.ok, true);
    assert.equal(health.dataDir, dataDir);

    const diag = await api<{ codex: { ok: boolean; version: string }; hcom: { ok: boolean; version: string }; agy: { ok: boolean; version: string } }>(info, '/api/diagnostics');
    assert.equal(diag.codex.ok, true, 'Codex CLI 진단 실패');
    assert.equal(diag.hcom.ok, true, 'hcom CLI 진단 실패');
    assert.equal(diag.agy.ok, true, 'agy CLI 진단 실패');
    console.log('[verify-installed] diagnostics OK:', diag.codex.version, '|', diag.hcom.version, '|', diag.agy.version);

    const regA = await api<{ snapshot: ProjectSnapshot }>(info, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ folderPath: repoA, name: 'Alpha Service' }),
    });
    const regB = await api<{ snapshot: ProjectSnapshot }>(info, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ folderPath: repoB, name: 'Beta Console' }),
    });
    projAId = regA.snapshot.project.projectId;
    projBId = regB.snapshot.project.projectId;
    assert.notEqual(projAId, projBId);
    assert.notEqual(regA.snapshot.project.hcomDir, regB.snapshot.project.hcomDir);
    console.log('[verify-installed] registered A & B with distinct HCOM_DIRs');

    sseA = openSse(info, projAId);
    sseB = openSse(info, projBId);

    console.log('[verify-installed] starting A and B in parallel...');
    const [startedA, startedB] = await Promise.all([
      api<{ snapshot: ProjectSnapshot }>(info, `/api/projects/${projAId}/start`, { method: 'POST' }),
      api<{ snapshot: ProjectSnapshot }>(info, `/api/projects/${projBId}/start`, { method: 'POST' }),
    ]);

    assert.equal(startedA.snapshot.codex.status, 'ready');
    assert.equal(startedB.snapshot.codex.status, 'ready');
    assert.ok(startedA.snapshot.codex.threadId);
    assert.ok(startedB.snapshot.codex.threadId);
    assert.notEqual(startedA.snapshot.codex.threadId, startedB.snapshot.codex.threadId);
    const workerA = startedA.snapshot.workers[0]!;
    const workerB = startedB.snapshot.workers[0]!;
    assert.equal(workerA.status, 'ready');
    assert.equal(workerB.status, 'ready');
    assert.ok(workerA.hcomName);
    assert.ok(workerB.hcomName);
    console.log('[verify-installed] A & B started cleanly:', {
      threadA: startedA.snapshot.codex.threadId,
      threadB: startedB.snapshot.codex.threadId,
      hcomWorkerA: workerA.hcomName,
      hcomWorkerB: workerB.hcomName,
    });

    console.log('[verify-installed] sending parallel delegated hcom requests on A and B...');
    await Promise.all([
      api(info, `/api/projects/${projAId}/requests`, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'installed-req-a',
          prompt: '먼저 list_workers로 이 프로젝트의 기본 워커 ID를 확인한 뒤, 반드시 delegate_work 도구를 호출해 기본 워커에게 현재 프로젝트의 git 브랜치 이름과 PROJECT_MARKER.txt 내용을 확인하고 회신하도록 위임해줘. 워커 회신을 받으면 한국어로 간결히 요약해줘.',
        }),
      }),
      api(info, `/api/projects/${projBId}/requests`, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'installed-req-b',
          prompt: '먼저 list_workers로 이 프로젝트의 기본 워커 ID를 확인한 뒤, 반드시 delegate_work 도구를 호출해 기본 워커에게 현재 프로젝트의 git 브랜치 이름과 PROJECT_MARKER.txt 내용을 확인하고 회신하도록 위임해줘. 워커 회신을 받으면 한국어로 간결히 요약해줘.',
        }),
      }),
    ]);

    const [resA, resB] = await Promise.all([
      waitForRequestDone(info, projAId, 'installed-req-a'),
      waitForRequestDone(info, projBId, 'installed-req-b'),
    ]);

    assert.equal(resA.request.status, 'completed', `A 요청 실패: ${resA.request.error}`);
    assert.equal(resB.request.status, 'completed', `B 요청 실패: ${resB.request.error}`);
    assert.ok(resA.delegations.length >= 1 && resA.delegations[0]!.replyText, 'A 워커 회신 누락');
    assert.ok(resB.delegations.length >= 1 && resB.delegations[0]!.replyText, 'B 워커 회신 누락');

    const [afterA, afterB] = await Promise.all([
      api<{ snapshot: ProjectSnapshot }>(info, `/api/projects/${projAId}`),
      api<{ snapshot: ProjectSnapshot }>(info, `/api/projects/${projBId}`),
    ]);
    const boundConvA = afterA.snapshot.workers[0]!.conversationId;
    const boundConvB = afterB.snapshot.workers[0]!.conversationId;
    assert.ok(boundConvA, 'A 워커 conversationId 바인딩 누락');
    assert.ok(boundConvB, 'B 워커 conversationId 바인딩 누락');
    assert.notEqual(boundConvA, boundConvB, 'A/B 워커 conversationId 분리 실패');

    const textA = `${resA.delegations[0]!.replyText}\n${resA.request.finalText ?? ''}`;
    const textB = `${resB.delegations[0]!.replyText}\n${resB.request.finalText ?? ''}`;
    assert.match(textA, /gui-branch-a|ALPHA_MARKER_101/);
    assert.doesNotMatch(textA, /gui-branch-b|BETA_MARKER_202/);
    assert.match(textB, /gui-branch-b|BETA_MARKER_202/);
    assert.doesNotMatch(textB, /gui-branch-a|ALPHA_MARKER_101/);

    await sleep(1000);
    assert.ok(sseA.events.length > 0 && sseA.events.every(e => e.projectId === projAId), 'SSE A 교차 이벤트 감지');
    assert.ok(sseB.events.length > 0 && sseB.events.every(e => e.projectId === projBId), 'SSE B 교차 이벤트 감지');
    const hcomMsgsA = sseA.events.filter(e => e.kind === 'hcom.message');
    const hcomMsgsB = sseB.events.filter(e => e.kind === 'hcom.message');
    assert.ok(hcomMsgsA.length >= 1, 'SSE A hcom.message 누락');
    assert.ok(hcomMsgsB.length >= 1, 'SSE B hcom.message 누락');
    console.log('[verify-installed] hcom messages verified:', { hcomMsgsA: hcomMsgsA.length, hcomMsgsB: hcomMsgsB.length });

    // UI 새로고침 및 프로젝트 A/B 스크린샷 캡처 + 색상 검증
    await api(info, `/api/projects/${projAId}/select`, { method: 'POST' });
    const shotAPath = join(runDir, 'gui-project-a.png');
    const uiA = await captureViaCdp(
      cdpPort,
      shotAPath,
      `new Promise(r => { document.getElementById('toggleHcomLogBtn')?.click(); setTimeout(r, 400); })`,
    );
    console.log('[verify-installed] UI A styles & screenshot:', shotAPath, uiA);
    assert.equal(uiA.bodyBg, 'rgb(255, 255, 255)', '배경색이 흰색(#FFFFFF)이 아닙니다');
    assert.equal(uiA.sidebarBg, 'rgb(247, 247, 248)', '사이드바 색상이 아주 옅은 회색(#F7F7F8)이 아닙니다');

    await api(info, `/api/projects/${projBId}/select`, { method: 'POST' });
    const shotBPath = join(runDir, 'gui-project-b.png');
    const uiB = await captureViaCdp(
      cdpPort,
      shotBPath,
      `new Promise(r => { document.getElementById('toggleHcomLogBtn')?.click(); setTimeout(r, 400); })`,
    );
    console.log('[verify-installed] UI B styles & screenshot:', shotBPath, uiB);

    const summary = {
      ok: true,
      installedExe,
      version: info.version,
      runDir,
      shotAPath,
      shotBPath,
      projectA: { id: projAId, threadId: startedA.snapshot.codex.threadId, convId: boundConvA, hcomMessages: hcomMsgsA.length },
      projectB: { id: projBId, threadId: startedB.snapshot.codex.threadId, convId: boundConvB, hcomMessages: hcomMsgsB.length },
      uiA,
      uiB,
    };
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log('[verify-installed] ALL PASSED:', JSON.stringify(summary, null, 2));
  } finally {
    sseA?.close();
    sseB?.close();
    if (info) {
      if (projAId) await api(info, `/api/projects/${projAId}/stop`, { method: 'POST' }).catch(() => {});
      if (projBId) await api(info, `/api/projects/${projBId}/stop`, { method: 'POST' }).catch(() => {});
    }
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {}
  }
}

void main().catch(error => {
  console.error('[verify-installed] FAILED:', error);
  process.exit(1);
});
