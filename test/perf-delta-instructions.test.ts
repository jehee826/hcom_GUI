import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionOptions, ToolOutput, TurnResult } from '../src/codex/index.ts';
import type {
  ActiveParticipant,
  HcomEvent,
  Participant,
  ProjectScope,
  Receipt,
  StoppedParticipant,
  TerminalState,
  WorkerBinding,
  WorkerLaunch,
} from '../src/hcom/index.ts';
import { defaultGitInspector, type GitInspector } from '../src/projects/git.ts';
import { ProjectManager, type CodexClient, type HcomClient } from '../src/runtime/index.ts';
import { startGuiServer } from '../src/server/index.ts';

test('최근 이력 페이지네이션, 비동기 진단 캐시, SSE delta, 사용자 지침 유연화 및 토큰 절감이 동작한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hcom-gui-perf-delta-'));
  const dataDir = join(root, 'data');
  const repoDir = join(root, 'proj-a');
  mkdirSync(repoDir, { recursive: true });

  const capturedInputs: Array<{ text?: string; toolOutput?: ToolOutput }> = [];
  let listWorkersJson = '';
  let diagCalls = 0;

  const fakeGit: GitInspector = {
    resolveProject(folderPath) { return defaultGitInspector.resolveProject(folderPath); },
    readSnapshot() { return { branchStatus: 'main', commitStatus: 'abc1234' }; },
  };

  const listeners = new Set<(event: HcomEvent) => void>();
  let nextEventId = 1;
  const emitHcom = (ev: HcomEvent) => { for (const l of listeners) l(ev); };

  const createCodex = async (options: SessionOptions): Promise<CodexClient> => ({
    async startThread() { return 'thread-perf-1'; },
    async resumeThread(id) { return id; },
    async runTurn(input): Promise<TurnResult> {
      capturedInputs.push(input);
      if ('text' in input && input.text.includes('위임해')) {
        const listRes = await options.onToolCall?.({ tool: 'list_workers', callId: 'lw-1', arguments: {} });
        listWorkersJson = listRes?.contentItems?.[0]?.text ?? '';
        const workers = JSON.parse(listWorkersJson) as Array<{ workerId: string }>;
        await options.onToolCall?.({
          tool: 'delegate_work',
          callId: 'dw-1',
          arguments: { workerId: workers[0]!.workerId, task: '간단 점검' },
        });
        return { threadId: 'thread-perf-1', turnId: 'turn-1', status: 'needs_final_answer' };
      }
      return { threadId: 'thread-perf-1', turnId: `turn-${capturedInputs.length}`, status: 'completed', finalText: '완료 응답' };
    },
    async close() {},
  });

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
    async clearJammedInput() { return false; },
    async send(sender, target, text): Promise<Receipt> {
      const eventId = nextEventId++;
      emitHcom({ projectId: scope.projectId, id: eventId, type: 'message', data: { from: sender.name, sender_kind: 'instance', intent: 'request', delivered_to: [target.name], text } });
      setTimeout(() => {
        emitHcom({
          projectId: scope.projectId,
          id: nextEventId++,
          type: 'message',
          instance: target.name,
          data: { from: target.name, sender_kind: 'instance', scope: 'mentions', intent: 'inform', reply_to: String(eventId), delivered_to: [sender.name], text: '결과: 점검 완료' },
        });
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
    pollIntervalMs: 20,
    replyTimeoutMs: 5000,
    createCodex,
    createHcom,
  });

  const srv = await startGuiServer({
    manager,
    appVersion: '1.0.0',
    getDiagnostics: async (refresh) => {
      diagCalls++;
      return {
        codex: { ok: true, path: 'codex', version: refresh ? 'v2' : 'v1' },
        hcom: { ok: true, path: 'hcom', version: '0.7.31' },
        agy: { ok: true, path: 'agy', version: '1.5.18' },
      };
    },
  });
  const headers = { 'x-hcom-token': srv.token, 'content-type': 'application/json' };

  try {
    // 1. 비동기 진단 엔드포인트 refresh 파라미터 전달 확인
    const d1 = await (await fetch(`${srv.baseUrl}/api/diagnostics`, { headers })).json() as { codex: { version: string } };
    const d2 = await (await fetch(`${srv.baseUrl}/api/diagnostics?refresh=1`, { headers })).json() as { codex: { version: string } };
    assert.equal(d1.codex.version, 'v1');
    assert.equal(d2.codex.version, 'v2');
    assert.equal(diagCalls, 2);

    // 2. 프로젝트 등록 + 기본 상태(사용자 지침 비어있음 -> 추가 주입 0)
    const { snapshot } = await (await fetch(`${srv.baseUrl}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ folderPath: repoDir, name: 'Perf Proj' }),
    })).json() as { snapshot: { project: { projectId: string }; codex: { customInstructions: string } } };
    const projectId = snapshot.project.projectId;
    assert.equal(snapshot.codex.customInstructions, '');

    // SSE 이벤트 구독해 delta 포함 여부 확인
    const enrichedEvents: Array<{ kind: string; hasDelta: boolean }> = [];
    const unsub = manager.subscribeEvents(ev => {
      enrichedEvents.push({ kind: ev.kind, hasDelta: Boolean(ev.delta) });
    });

    await manager.submitRequest(projectId, 'r-1', '첫 번째 요청');
    assert.equal(capturedInputs[0]?.text, '첫 번째 요청');

    // 3. 사용자 지침 설정 -> 다음 요청에 유연 반영 + SSE delta 포함 확인
    const patchRes = await fetch(`${srv.baseUrl}/api/projects/${projectId}/codex/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ customInstructions: '간결하게 핵심만 답해줘.' }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json() as { codex: { customInstructions: string } };
    assert.equal(patched.codex.customInstructions, '간결하게 핵심만 답해줘.');
    assert.ok(enrichedEvents.some(e => e.kind === 'codex.settings_updated' && e.hasDelta));

    await manager.submitRequest(projectId, 'r-2', '두 번째 요청');
    assert.equal(capturedInputs[1]?.text, '[사용자 지침]\n간결하게 핵심만 답해줘.\n\n두 번째 요청');

    // 4. 위임 시 list_workers 경량화 및 buildReviewTurnInput 반복 검수 지침 제거 확인
    await manager.submitRequest(projectId, 'r-3', '워커에게 위임해줘');
    const parsedWorkers = JSON.parse(listWorkersJson) as Array<Record<string, unknown>>;
    assert.equal(parsedWorkers[0]!.tool, 'agy');
    assert.equal('engine' in parsedWorkers[0]!, false);
    assert.equal('model' in parsedWorkers[0]!, false);

    const reviewInput = capturedInputs.find(inp => Boolean(inp.toolOutput));
    assert.ok(reviewInput?.toolOutput?.output.includes('점검 완료'));
    assert.equal(reviewInput?.toolOutput?.output.includes('[검수 지침]'), false);

    // 5. 최근 이력 페이지네이션 (?limit=2 -> 최신 2건 + hasMoreRequests=true, /requests로 이전 1건 조회)
    const page1 = await (await fetch(`${srv.baseUrl}/api/projects/${projectId}?limit=2`, { headers })).json() as {
      requests: Array<{ requestId: string; createdAt: string }>;
      hasMoreRequests: boolean;
      totalRequests: number;
    };
    assert.equal(page1.requests.length, 2);
    assert.equal(page1.totalRequests, 3);
    assert.equal(page1.hasMoreRequests, true);
    assert.deepEqual(page1.requests.map(r => r.requestId), ['r-2', 'r-3']);

    const oldest = page1.requests[0]!;
    const page2 = await (await fetch(
      `${srv.baseUrl}/api/projects/${projectId}/requests?limit=2&beforeCreatedAt=${encodeURIComponent(oldest.createdAt)}&beforeRequestId=${encodeURIComponent(oldest.requestId)}`,
      { headers },
    )).json() as { requests: Array<{ requestId: string }>; hasMoreRequests: boolean };
    assert.deepEqual(page2.requests.map(r => r.requestId), ['r-1']);
    assert.equal(page2.hasMoreRequests, false);

    unsub();
  } finally {
    await srv.close();
    await manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
