import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HcomAdapter, type CommandResult, type HcomEvent, type Participant, type ProjectScope, type TerminalState, type WorkerBinding } from '../src/hcom/index.ts';
import { ProjectManager, type CodexClient, type HcomClient } from '../src/runtime/index.ts';
import { startGuiServer } from '../src/server/index.ts';

function makeNoopHcom(
  scope: ProjectScope,
  overrides: Partial<HcomClient> & { onSend?: (sender: Participant, target: Participant, text: string, emit: (ev: HcomEvent) => void) => number } = {},
): HcomClient {
  let seq = 10;
  let listener: ((ev: HcomEvent) => void) | undefined;
  const active = new Map<string, { name: string; sessionId: string; cwd: string }>();
  return {
    scope,
    async initialize() {},
    async startCodex(threadId) {
      return { projectId: scope.projectId, name: 'codex1', sessionId: threadId, tool: 'adhoc', status: 'listening' };
    },
    async stopCodex() {},
    async launchWorker(opts) {
      const name = 'w1';
      const cwd = typeof opts === 'object' ? (opts.cwd ?? scope.cwd) : scope.cwd;
      active.set(name, { name, sessionId: `conv-${name}`, cwd });
      return { name, batchId: 'b1', readiness: 'ready' };
    },
    async resumeWorker(binding) {
      active.set(binding.name, { name: binding.name, sessionId: binding.sessionId, cwd: binding.directory });
      return { name: binding.name, batchId: 'b2', readiness: 'ready' };
    },
    async probeWorker(name): Promise<WorkerBinding> {
      const found = active.get(name)!;
      return {
        projectId: scope.projectId,
        name,
        sessionId: found.sessionId,
        status: 'listening',
        tool: 'agy',
        directory: found.cwd,
        hooksBound: true,
        processBound: true,
        evidence: 'hcom-managed-binding',
      };
    },
    async verifyResumedWorker(binding) { return binding; },
    async stopWorker(binding) { active.delete(binding.name); },
    async stopWorkerByName(name) { active.delete(name); },
    async stopLaunch(launch) { active.delete(launch.name); },
    async listParticipants() {
      return [...active.values()].map(a => ({
        projectId: scope.projectId,
        name: a.name,
        baseName: a.name,
        sessionId: a.sessionId,
        tool: 'agy',
        status: 'listening',
        directory: a.cwd,
        hooksBound: true,
        processBound: true,
      }));
    },
    async getStoppedWorker() { return undefined; },
    async settleWorker() { return true; },
    async clearBannerOverlay() { return false; },
    async readTerminal(): Promise<TerminalState> {
      return { ready: true, promptEmpty: true, inputText: '', lines: ['>'] };
    },
    async clearJammedInput() { return false; },
    async send(sender, target, text) {
      const eventId = overrides.onSend
        ? overrides.onSend(sender, target, text, ev => listener?.(ev))
        : ++seq;
      return { eventId, deliveredTo: [target.name] };
    },
    follow(_afterId, onEvent) {
      listener = onEvent;
      return async () => { listener = undefined; };
    },
    ...overrides,
  };
}

test('초기화 실패 시 Codex/워커 요청이 accepted에 멈추지 않고 failed와 SSE 오류 이벤트를 기록한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hcom-neon-init-fail-'));
  const dataDir = join(root, 'data');
  const folder = join(root, 'proj');
  mkdirSync(folder, { recursive: true });

  let failCodex = true;
  let failWorkerLaunch = true;
  const manager = new ProjectManager({
    dataDir,
    codexCommand: 'fake-codex',
    createCodex: async (): Promise<CodexClient> => {
      if (failCodex) throw new Error('Codex App Server 연결 실패(테스트)');
      return {
        async startThread() { return 'th-ok'; },
        async resumeThread(id) { return id; },
        async runTurn() { return { threadId: 'th-ok', turnId: 't-1', status: 'completed', finalText: 'ok' }; },
        async close() {},
      };
    },
    createHcom: scope => makeNoopHcom(scope, {
      async launchWorker() {
        if (failWorkerLaunch) throw new Error('워커 실행 실패(테스트)');
        return { name: 'w1', batchId: 'b1', readiness: 'ready' };
      },
    }),
  });

  const events: Array<{ kind: string; status?: string; error?: string }> = [];
  const unsub = manager.subscribeEvents(ev => {
    events.push({
      kind: ev.kind,
      status: ev.delta?.request?.status,
      error: ev.delta?.request?.error ?? undefined,
    });
  });

  try {
    const reg = manager.registerProject(folder, { name: 'InitFailProj' });
    const projectId = reg.project.projectId;
    const workerId = reg.workers[0]!.workerId;

    // 1. Codex 초기화 실패 -> accepted에 멈추지 않고 failed + request.failed SSE 발행
    await assert.rejects(manager.submitRequest(projectId, 'req-codex-fail', '안녕'), /Codex App Server 연결 실패/);
    const failedCodex = manager.getRequest(projectId, 'req-codex-fail');
    assert.equal(failedCodex?.status, 'failed');
    assert.match(failedCodex?.error ?? '', /Codex App Server 연결 실패/);
    assert.ok(events.some(e => e.kind === 'request.failed' && e.status === 'failed' && /Codex App Server 연결 실패/.test(e.error ?? '')));

    // 2. 워커 직접 메시지 초기화(launchWorker) 실패 -> accepted에 멈추지 않고 failed + request.failed SSE 발행
    const directRes = await manager.sendDirectWorkerMessage(projectId, workerId, 'req-worker-fail', '파일 확인');
    assert.equal(directRes.request.status, 'failed');
    assert.match(directRes.request.error ?? '', /워커 실행 실패/);
    assert.ok(events.some(e => e.kind === 'request.failed' && e.status === 'failed' && /워커 실행 실패/.test(e.error ?? '')));

    // 3. 사용자가 새 요청 ID로 재시도하면 정상 완료된다
    failCodex = false;
    failWorkerLaunch = false;
    const retryOk = await manager.submitRequest(projectId, 'req-codex-retry', '재시도');
    assert.equal(retryOk.status, 'completed');
    assert.equal(retryOk.finalText, 'ok');
  } finally {
    unsub();
    await manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test('없는 워커나 다른 프로젝트 워커로의 메시지 전송은 접수 전 4xx로 거절되고 요청이 생성되지 않는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hcom-neon-4xx-'));
  const dataDir = join(root, 'data');
  const folderA = join(root, 'proj-a');
  const folderB = join(root, 'proj-b');
  mkdirSync(folderA, { recursive: true });
  mkdirSync(folderB, { recursive: true });

  const manager = new ProjectManager({
    dataDir,
    codexCommand: 'fake-codex',
    createHcom: scope => makeNoopHcom(scope),
  });
  const srv = await startGuiServer({
    manager,
    port: 0,
    appVersion: '1.0.0',
    getDiagnostics: async () => ({
      codex: { ok: true, path: 'codex', version: '1.0' },
      hcom: { ok: true, path: 'hcom', version: '1.0' },
      agy: { ok: true, path: 'agy', version: '1.0' },
    }),
    getModels: async () => ({ codex: [], agy: [], cachedAt: new Date().toISOString() }),
  });
  const headers = { 'x-hcom-token': srv.token, 'content-type': 'application/json' };

  try {
    const regA = manager.registerProject(folderA, { name: 'ProjA' });
    const regB = manager.registerProject(folderB, { name: 'ProjB' });

    // 없는 워커 -> 404 (202 아님) + 요청 미생성
    const missingRes = await fetch(`${srv.baseUrl}/api/projects/${regA.project.projectId}/workers/no-such-worker/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'req-missing-w', prompt: 'hello' }),
    });
    assert.equal(missingRes.status, 404);
    assert.equal(manager.getRequest(regA.project.projectId, 'req-missing-w'), undefined);

    // 다른 프로젝트 워커 -> 403 (202 아님) + 요청 미생성
    const crossRes = await fetch(`${srv.baseUrl}/api/projects/${regA.project.projectId}/workers/${regB.workers[0]!.workerId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'req-cross-w', prompt: 'hello' }),
    });
    assert.equal(crossRes.status, 403);
    assert.equal(manager.getRequest(regA.project.projectId, 'req-cross-w'), undefined);
  } finally {
    await srv.close();
    await manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test('정상 전송 경로는 불필요한 입력 복구를 호출하지 않고 settleWorker는 읽은 화면을 clearBannerOverlay에 재사용한다', async () => {
  // 1. settleWorker 중복 readTerminal 제거 확인 (배너 없는 정상 화면에서 term 조회 1회/틱, inject 0회)
  const calls: string[][] = [];
  const adapter = new HcomAdapter({ projectId: 'p1', cwd: 'C:\\proj', hcomDir: 'C:\\hcom' }, async (args): Promise<CommandResult> => {
    calls.push(args);
    if (args[0] === 'relay' && args[1] === 'status') return { stdout: 'Relay: disabled\n', stderr: '', code: 0 };
    if (args[0] === 'term' && args[1] === 'w1' && args[2] === '--json') {
      return {
        stdout: JSON.stringify({ ready: true, prompt_empty: true, input_text: '', lines: ['Gemini 4 Neon (Google AI Pro)', '>'] }),
        stderr: '',
        code: 0,
      };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  await adapter.initialize();
  const settled = await adapter.settleWorker('w1', 5000);
  assert.equal(settled, true);
  const termReads = calls.filter(c => c[0] === 'term' && c[1] === 'w1' && c[2] === '--json');
  const injects = calls.filter(c => c[0] === 'term' && c[1] === 'inject');
  // 3회 연속 안정 확인 동안 clearBannerOverlay가 같은 term을 재사용하므로 정확히 3회만 조회한다 (기존 6회 -> 3회).
  assert.equal(termReads.length, 3);
  assert.equal(injects.length, 0);

  // 2. 정상 sendDirectWorkerMessage 경로는 readTerminal/clearBannerOverlay/clearJammedInput/injectInput을 호출하지 않는다.
  const root = mkdtempSync(join(tmpdir(), 'hcom-neon-normal-send-'));
  const dataDir = join(root, 'data');
  const folder = join(root, 'proj');
  mkdirSync(folder, { recursive: true });
  let termCalls = 0;
  let recoveryCalls = 0;

  const manager = new ProjectManager({
    dataDir,
    codexCommand: 'fake-codex',
    createCodex: async (): Promise<CodexClient> => ({
      async startThread() { return 'th-1'; },
      async resumeThread(id) { return id; },
      async runTurn() { return { threadId: 'th-1', turnId: 't-1', status: 'completed', finalText: 'ok' }; },
      async close() {},
    }),
    createHcom: scope => makeNoopHcom(scope, {
      async readTerminal() { termCalls++; return { ready: true, promptEmpty: true, inputText: '', lines: ['>'] }; },
      async clearBannerOverlay() { recoveryCalls++; return false; },
      async clearJammedInput() { recoveryCalls++; return false; },
      onSend(sender, target, _text, emit) {
        const reqId = 42;
        setTimeout(() => {
          emit({
            projectId: scope.projectId,
            id: 43,
            type: 'message',
            instance: target.name,
            data: {
              from: target.name,
              sender_kind: 'instance',
              scope: 'mentions',
              delivered_to: [sender.name],
              reply_to: String(reqId),
              intent: 'inform',
              text: '정상 회신',
            },
          });
        }, 20);
        return reqId;
      },
    }),
  });

  try {
    const reg = manager.registerProject(folder, { name: 'NormalSendProj' });
    await manager.startProject(reg.project.projectId);
    const res = await manager.sendDirectWorkerMessage(reg.project.projectId, reg.workers[0]!.workerId, 'req-normal', '계산해줘');
    assert.equal(res.request.status, 'completed');
    assert.equal(res.request.finalText, '정상 회신');
    assert.equal(termCalls, 0);
    assert.equal(recoveryCalls, 0);
  } finally {
    await manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
