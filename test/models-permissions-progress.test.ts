import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexSession, type Progress, type SessionOptions, type TurnResult } from '../src/codex/index.ts';
import {
  HcomAdapter,
  type ActiveParticipant,
  type HcomEvent,
  type Participant,
  type ProjectScope,
  type Receipt,
  type Runner,
  type StoppedParticipant,
  type TerminalState,
  type WorkerBinding,
  type WorkerLaunch,
  type WorkerLaunchOptions,
} from '../src/hcom/index.ts';
import type { GitInspector } from '../src/projects/git.ts';
import { ProjectManager, type CodexClient, type HcomClient } from '../src/runtime/index.ts';
import { startGuiServer } from '../src/server/index.ts';
import { parseAgyModelsOutput, parseCodexModelList } from '../src/server/models.ts';

test('parseAgyModelsOutput와 parseCodexModelList는 실제 CLI 출력을 정확히 파싱한다', () => {
  const agyOut = [
    'Fetching available models...',
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-neon-low\tGemini 4 Neon (Low)',
    'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  ].join('\n');
  const agyModels = parseAgyModelsOutput(agyOut);
  assert.equal(agyModels.length, 3);
  assert.equal(agyModels[0]!.id, 'gemini-4-neon-high');
  assert.equal(agyModels[0]!.defaultEffort, 'high');
  assert.equal(agyModels[2]!.id, 'claude-sonnet-5-5-medium');

  const codexModels = parseCodexModelList({
    data: [
      {
        id: 'gpt-6.1-terra',
        model: 'gpt-6.1-terra',
        displayName: 'GPT-6.1 Terra',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      },
      { id: 'hidden-model', hidden: true },
    ],
  });
  assert.equal(codexModels.length, 1);
  assert.equal(codexModels[0]!.id, 'gpt-6.1-terra');
  assert.deepEqual(codexModels[0]!.efforts, ['low', 'high']);
});

test('CodexSession.setRuntimeConfig와 HcomAdapter의 model/effort/injectInput/readTranscript가 동작한다', async () => {
  const dynamicServer = String.raw`
  const readline = require('node:readline');
  const seen = [];
  const send = x => process.stdout.write(JSON.stringify(x) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') return send({ id: m.id, result: {} });
    if (m.method === 'thread/start') return send({ id: m.id, result: { thread: { id: 't-cfg' } } });
    if (m.method === 'turn/start') {
      seen.push({ model: m.params.model, effort: m.params.effort, policy: m.params.sandboxPolicy?.type });
      send({ method: 'item/completed', params: { threadId: 't-cfg', turnId: 'u-' + seen.length, item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(seen.at(-1)) } } });
      send({ method: 'turn/completed', params: { threadId: 't-cfg', turn: { id: 'u-' + seen.length, status: 'completed', error: null } } });
      return send({ id: m.id, result: { turn: { id: 'u-' + seen.length } } });
    }
  });`;

  const session = await CodexSession.connect({
    command: process.execPath,
    args: ['-e', dynamicServer],
    cwd: process.cwd(),
    env: process.env,
    model: 'gpt-6.1-sol',
    effort: 'low',
    sandbox: 'workspace-write',
  });
  try {
    await session.startThread();
    const t1 = await session.runTurn({ text: 'first' });
    assert.deepEqual(JSON.parse(t1.finalText ?? '{}'), { model: 'gpt-6.1-sol', effort: 'low', policy: 'workspaceWrite' });
    session.setRuntimeConfig({ model: 'gpt-6.1-terra', effort: 'high', sandbox: 'danger-full-access' });
    const t2 = await session.runTurn({ text: 'second' });
    assert.deepEqual(JSON.parse(t2.finalText ?? '{}'), { model: 'gpt-6.1-terra', effort: 'high', policy: 'dangerFullAccess' });
  } finally {
    await session.close();
  }

  const calls: string[][] = [];
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === 'agy') return { code: 0, stderr: '', stdout: JSON.stringify({ launched: 1, failed: 0, names: ['w1'], batch_id: 'b1', readiness: { status: 'ready' } }) };
    if (args[0] === 'transcript') return { code: 0, stderr: '', stdout: JSON.stringify([{ role: 'assistant', text: 'checked' }]) };
    return { code: 0, stderr: '', stdout: 'Relay: not configured\n' };
  };
  const hcom = new HcomAdapter({ projectId: 'p', cwd: 'C:\\proj', hcomDir: 'C:\\hcom' }, runner);
  await hcom.initialize();
  await hcom.launchWorker({ settingsPath: 'C:\\hcom\\s.json', model: 'gemini-4-neon-high', effort: 'xhigh' });
  const agyCall = calls.find(c => c[0] === 'agy')!;
  assert.ok(agyCall.includes('--model') && agyCall.includes('gemini-4-neon-high'));
  assert.ok(agyCall.includes('--effort') && agyCall.includes('xhigh'));
  await hcom.injectInput('w1', '\r');
  assert.ok(calls.some(c => c[0] === 'term' && c[1] === 'inject' && c[2] === 'w1' && c[3] === '\r'));
  const transcript = await hcom.readTranscript('w1', 5);
  assert.deepEqual(transcript, [{ role: 'assistant', text: 'checked' }]);
});

test('권한 설정·모델 설정·승인 대기 복구(waiting_approval)·실시간 추론 로그·API 엔드포인트가 연동된다', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hcom-perm-prog-'));
  const injected: Array<{ name: string; text: string }> = [];
  const listeners = new Set<(ev: HcomEvent) => void>();
  const eventLog: HcomEvent[] = [];
  let nextEventId = 1;
  let lastReqEventId = 0;
  let lastSender = '';
  let lastTarget = '';
  let lastProjectId = '';

  const fakeGit: GitInspector = {
    resolveProject: folderPath => ({
      rootPath: folderPath,
      rootKey: folderPath.toLowerCase(),
      gitCommonDir: `${folderPath}\\.git`,
      gitCommonDirKey: `${folderPath}\\.git`.toLowerCase(),
      defaultName: 'Demo',
      isGitRepo: true,
    }),
    readSnapshot: () => ({ branchStatus: 'main', commitStatus: 'abc init' }),
  };

  let progressCb: ((ev: Progress) => void) | undefined;
  let listWorkersJson = '';
  const createCodex = async (opts: SessionOptions): Promise<CodexClient> => {
    progressCb = opts.onProgress;
    let runtimeCfg = { model: opts.model ?? null, effort: opts.effort ?? null, sandbox: opts.sandbox };
    return {
      async startThread() { return 'thread-perm-1'; },
      async resumeThread(id) { return id; },
      setRuntimeConfig(patch) {
        if (patch.model !== undefined) runtimeCfg.model = patch.model;
        if (patch.effort !== undefined) runtimeCfg.effort = patch.effort;
        if (patch.sandbox !== undefined) runtimeCfg.sandbox = patch.sandbox;
      },
      async runTurn(input): Promise<TurnResult> {
        progressCb?.({ method: 'item/reasoning/summaryTextDelta', params: { delta: '작업 계획을 세우는 중...' } });
        progressCb?.({ method: 'item/started', params: { item: { type: 'commandExecution', command: 'git status' } } });
        progressCb?.({ method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'commentary', text: '워커에게 작업을 전달합니다.' } } });
        if ('text' in input) {
          const listRes = await opts.onToolCall!({ tool: 'list_workers', callId: 'c-list', arguments: {} });
          listWorkersJson = listRes.contentItems[0]?.text ?? '';
          const workers = JSON.parse(listWorkersJson) as Array<{ workerId: string; tool: string }>;
          await opts.onToolCall!({ tool: 'delegate_work', callId: 'c-del', arguments: { workerId: workers[0]!.workerId, task: '검증 실행' } });
          return { threadId: 'thread-perm-1', turnId: 'turn-1', status: 'completed', finalText: '위임 완료' };
        }
        return { threadId: 'thread-perm-1', turnId: 'turn-2', status: 'completed', finalText: `승인 후 최종 완료 (${runtimeCfg.model ?? 'default'}/${runtimeCfg.effort ?? 'default'})` };
      },
      async close() {},
    };
  };

  const emitHcom = (ev: HcomEvent) => {
    eventLog.push(ev);
    for (const l of listeners) l(ev);
  };

  const createHcom = (scope: ProjectScope): HcomClient => ({
    scope: Object.freeze({ ...scope }),
    async initialize() {},
    async startCodex(threadId) { return { projectId: scope.projectId, name: 'cdx', sessionId: threadId, tool: 'adhoc', status: 'active' }; },
    async stopCodex() {},
    async launchWorker() { return Object.freeze({ name: 'varo', batchId: 'b1', readiness: 'ready' as const }); },
    async resumeWorker(w) { return Object.freeze({ name: w.name, batchId: 'b2', readiness: 'ready' as const }); },
    async probeWorker(name) { return { projectId: scope.projectId, name, sessionId: 'conv-varo', status: 'listening', tool: 'antigravity', directory: scope.cwd, hooksBound: true, processBound: true, evidence: 'hcom-managed-binding' }; },
    async verifyResumedWorker(w) { return w; },
    async stopWorker() {},
    async stopWorkerByName() {},
    async stopLaunch() {},
    async listParticipants(): Promise<ActiveParticipant[]> {
      return [{ projectId: scope.projectId, name: 'varo', baseName: 'varo', tool: 'antigravity', status: 'listening', sessionId: 'conv-varo', directory: scope.cwd, hooksBound: true, processBound: true }];
    },
    async getStoppedWorker(): Promise<StoppedParticipant | undefined> {
      return { projectId: scope.projectId, name: 'varo', tool: 'antigravity', sessionId: 'conv-varo', directory: scope.cwd };
    },
    async settleWorker() { return true; },
    async clearBannerOverlay() { return false; },
    async readTerminal(): Promise<TerminalState> { return { ready: true, promptEmpty: true, inputText: '', lines: ['>'] }; },
    async injectInput(name, text) {
      injected.push({ name, text });
      if (text === '\r') {
        // 승인 입력을 받으면 워커가 active로 복귀 후 회신 전송
        setTimeout(() => {
          emitHcom({ projectId: lastProjectId, id: nextEventId++, type: 'status', instance: lastTarget, data: { status: 'active', context: 'tool', detail: 'running check' } });
          emitHcom({
            projectId: lastProjectId,
            id: nextEventId++,
            type: 'message',
            instance: lastTarget,
            data: { from: lastTarget, sender_kind: 'instance', scope: 'mentions', intent: 'inform', reply_to: String(lastReqEventId), delivered_to: [lastSender], text: '결과: 승인 후 완료' },
          });
        }, 15);
      }
    },
    async readTranscript() { return [{ turn: 1, summary: 'checked files' }]; },
    async clearJammedInput() { return false; },
    async send(sender, target, text): Promise<Receipt> {
      const eventId = nextEventId++;
      lastProjectId = scope.projectId;
      lastReqEventId = eventId;
      lastSender = sender.name;
      lastTarget = target.name;
      emitHcom({ projectId: scope.projectId, id: eventId, type: 'message', data: { from: sender.name, sender_kind: 'instance', intent: 'request', delivered_to: [target.name], text } });
      // 워커가 승인 대기(pty:approval)에 진입하는 상황 시뮬레이션
      setTimeout(() => {
        emitHcom({ projectId: scope.projectId, id: nextEventId++, type: 'status', instance: target.name, data: { status: 'blocked', context: 'pty:approval', detail: 'Get-ChildItem C:\\demo' } });
      }, 15);
      return { eventId, deliveredTo: [target.name] };
    },
    follow(_afterId, onEvent) {
      listeners.add(onEvent);
      return async () => { listeners.delete(onEvent); };
    },
  });

  const manager = new ProjectManager({
    dataDir,
    codexCommand: 'fake',
    git: fakeGit,
    pollIntervalMs: 25,
    approvalDebounceMs: 40,
    replyTimeoutMs: 5000,
    createCodex,
    createHcom,
  });

  const srv = await startGuiServer({
    manager,
    appVersion: '1.0.0',
    getModels: async () => ({
      codex: [{ id: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true }],
      agy: [{ id: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)', efforts: ['low', 'high'], defaultEffort: 'high', isDefault: true }],
      cachedAt: new Date().toISOString(),
    }),
  });
  const headers = { 'x-hcom-token': srv.token, 'content-type': 'application/json' };

  try {
    // 1. GET /api/models
    const modelsRes = await fetch(`${srv.baseUrl}/api/models`, { headers });
    assert.equal(modelsRes.status, 200);
    const catalog = await modelsRes.json() as { codex: Array<{ id: string }>; agy: Array<{ id: string }> };
    assert.equal(catalog.codex[0]!.id, 'gpt-6.1-terra');
    assert.equal(catalog.agy[0]!.id, 'gemini-4-neon-high');

    // 2. 프로젝트 등록 + Codex/워커 모델·추론 강도·권한 설정 저장 확인
    const snap = manager.registerProject('C:\\demo', { name: 'Demo' });
    const pid = snap.project.projectId;
    const wid = snap.workers[0]!.workerId;
    await manager.startProject(pid);

    const codexPatch = await fetch(`${srv.baseUrl}/api/projects/${pid}/codex/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ model: 'gpt-6.1-terra', reasoningEffort: 'high', sandboxMode: 'workspace-write' }),
    });
    assert.equal(codexPatch.status, 200);
    assert.equal(manager.getProjectSnapshot(pid).codex.sandboxMode, 'workspace-write');

    const workerPatch = await fetch(`${srv.baseUrl}/api/projects/${pid}/workers/${wid}/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ model: 'gemini-4-neon-high', reasoningEffort: 'medium', permissionMode: 'ask' }),
    });
    assert.equal(workerPatch.status, 200);
    const settingsOnDisk = JSON.parse(readFileSync(join(snap.project.hcomDir, 'agy-settings.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(settingsOnDisk.toolPermission, undefined, 'ask 모드에서는 toolPermission 자동 승인이 제거돼야 합니다');

    // 3. 요청 실행 -> blocked(pty:approval) 발생 시 waiting_approval 전환 -> /approval approve로 계속 진행해 완료!
    const reqPromise = manager.submitRequest(pid, 'req-approval-1', '테스트 실행');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && manager.getRequest(pid, 'req-approval-1')?.status !== 'waiting_approval') {
      await new Promise(r => setTimeout(r, 20));
    }
    const waiting = manager.getRequest(pid, 'req-approval-1')!;
    assert.equal(waiting.status, 'waiting_approval');
    assert.equal(waiting.pendingApproval?.context, 'pty:approval');

    const approveRes = await fetch(`${srv.baseUrl}/api/projects/${pid}/requests/req-approval-1/approval`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(approveRes.status, 200);
    const done = await reqPromise;
    assert.equal(done.status, 'completed');
    assert.match(done.finalText ?? '', /gpt-6\.1-terra\/high/);
    assert.ok(injected.some(i => i.name === 'varo' && i.text === '\r'));

    // 4. list_workers에 tool: 'agy' 포함 & 추론/워커 로그 수집 확인
    const parsedWorkers = JSON.parse(listWorkersJson) as Array<{ tool: string; engine: string }>;
    assert.equal(parsedWorkers[0]!.tool, 'agy');
    assert.match(parsedWorkers[0]!.engine, /Antigravity/);

    const progress = manager.getRequestProgress(pid, 'req-approval-1');
    assert.ok(progress.some(p => p.source === 'codex' && p.kind === 'reasoning'));
    assert.ok(progress.some(p => p.source === 'worker' && p.kind === 'approval'));

    const workerLogsRes = await fetch(`${srv.baseUrl}/api/projects/${pid}/workers/${wid}/logs`, { headers });
    assert.equal(workerLogsRes.status, 200);
    const workerLogs = await workerLogsRes.json() as { progress: unknown[]; transcript: unknown[] };
    assert.ok(workerLogs.progress.length > 0);
    assert.equal(workerLogs.transcript.length, 1);
  } finally {
    await srv.close();
    await manager.shutdownAll().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
