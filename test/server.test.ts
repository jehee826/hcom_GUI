import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionOptions, ToolOutput, TurnResult } from '../src/codex/index.ts';
import type { ActiveParticipant, HcomEvent, Participant, ProjectScope, Receipt, StoppedParticipant, TerminalState, WorkerBinding, WorkerLaunch } from '../src/hcom/index.ts';
import type { GitInspector, GitRepoInfo } from '../src/projects/git.ts';
import { ProjectManager, type CodexClient, type HcomClient } from '../src/runtime/index.ts';
import { startGuiServer } from '../src/server/index.ts';

function fakeGit(): GitInspector {
  const repos: Record<string, GitRepoInfo & { branch: string; commit: string }> = {
    'c:\\srv\\a': { rootPath: 'C:\\srv\\a', rootKey: 'c:\\srv\\a', gitCommonDir: 'C:\\srv\\a\\.git', gitCommonDirKey: 'c:\\srv\\a\\.git', defaultName: 'srv-a', branch: 'main-a', commit: '커밋 없음' },
    'c:\\srv\\a-wt': { rootPath: 'C:\\srv\\a-wt', rootKey: 'c:\\srv\\a-wt', gitCommonDir: 'C:\\srv\\a\\.git', gitCommonDirKey: 'c:\\srv\\a\\.git', defaultName: 'srv-a-wt', branch: 'wt-a', commit: '커밋 없음' },
    'c:\\srv\\b': { rootPath: 'C:\\srv\\b', rootKey: 'c:\\srv\\b', gitCommonDir: 'C:\\srv\\b\\.git', gitCommonDirKey: 'c:\\srv\\b\\.git', defaultName: 'srv-b', branch: 'main-b', commit: '커밋 없음' },
  };
  return {
    resolveProject(folderPath: string) {
      const hit = repos[folderPath.toLowerCase()];
      if (!hit) throw new Error(`unknown repo: ${folderPath}`);
      return hit;
    },
    readSnapshot(cwd: string) {
      const hit = repos[cwd.toLowerCase()];
      return hit ? { branchStatus: hit.branch, commitStatus: hit.commit } : { branchStatus: '확인 필요', commitStatus: '확인 필요' };
    },
  };
}

function makeFakeHcom(scope: ProjectScope): HcomClient {
  let seq = 1;
  let workerSeq = 1;
  let codex: Participant | undefined;
  const workers = new Map<string, { name: string; sessionId: string; cwd: string }>();
  const listeners = new Set<(event: HcomEvent) => void>();
  const emit = (e: HcomEvent) => { for (const l of listeners) l(e); };

  return {
    scope: Object.freeze({ ...scope }),
    async initialize() {},
    async startCodex(threadId: string) {
      codex ??= { projectId: scope.projectId, name: `c_${scope.projectId.slice(0, 4)}`, sessionId: threadId, tool: 'adhoc', status: 'active' };
      return codex;
    },
    async stopCodex() { codex = undefined; },
    async launchWorker() {
      const id = workerSeq++;
      const name = `w${id}_${scope.projectId.slice(0, 4)}`;
      workers.set(name, { name, sessionId: `conv-${scope.projectId}-${id}`, cwd: scope.cwd });
      return Object.freeze({ name, batchId: `b-${id}`, readiness: 'ready' });
    },
    async resumeWorker(worker: WorkerBinding) {
      workers.set(worker.name, { name: worker.name, sessionId: worker.sessionId, cwd: worker.directory });
      return Object.freeze({ name: worker.name, batchId: 'resumed', readiness: 'ready' });
    },
    async probeWorker(name: string) {
      const w = workers.get(name)!;
      return { projectId: scope.projectId, name, sessionId: w.sessionId, status: 'listening', tool: 'antigravity', directory: w.cwd, hooksBound: true, processBound: true, evidence: 'hcom-managed-binding' };
    },
    async verifyResumedWorker(worker: WorkerBinding) { return worker; },
    async stopWorker(worker: WorkerBinding) { workers.delete(worker.name); },
    async stopWorkerByName(name: string) { workers.delete(name); },
    async stopLaunch(launch: WorkerLaunch) { workers.delete(launch.name); },
    async listParticipants(): Promise<ActiveParticipant[]> {
      const out: ActiveParticipant[] = [];
      if (codex) out.push({ ...codex, baseName: codex.name, directory: scope.cwd, hooksBound: true, processBound: false });
      for (const w of workers.values()) {
        out.push({ projectId: scope.projectId, name: w.name, baseName: w.name, tool: 'antigravity', status: 'listening', sessionId: w.sessionId, directory: w.cwd, hooksBound: true, processBound: true });
      }
      return out;
    },
    async getStoppedWorker(): Promise<StoppedParticipant | undefined> { return undefined; },
    async settleWorker() { return true; },
    async clearBannerOverlay() { return false; },
    async readTerminal(): Promise<TerminalState> { return { ready: true, promptEmpty: true, inputText: '', lines: ['>'] }; },
    async clearJammedInput() { return false; },
    async send(sender: Participant, target: Participant, text: string): Promise<Receipt> {
      const eventId = seq++;
      emit({ projectId: scope.projectId, id: eventId, type: 'message', instance: sender.name, data: { from: sender.name, sender_kind: 'instance', intent: 'request', delivered_to: [target.name], text } });
      setTimeout(() => {
        const replyId = seq++;
        emit({ projectId: scope.projectId, id: replyId, type: 'message', instance: target.name, data: { from: target.name, sender_kind: 'instance', scope: 'mentions', delivered_to: [sender.name], reply_to: String(eventId), intent: 'inform', text: `done:${scope.cwd}` } });
      }, 10);
      return { eventId, deliveredTo: [target.name] };
    },
    follow(_afterId: number, onEvent: (e: HcomEvent) => void) {
      listeners.add(onEvent);
      return async () => { listeners.delete(onEvent); };
    },
  };
}

function makeFakeCodex() {
  let seq = 1;
  return async (options: SessionOptions): Promise<CodexClient> => {
    let threadId = '';
    let turn = 0;
    return {
      async startThread() { threadId = `t-${seq++}`; return threadId; },
      async resumeThread(id: string) { threadId = id; return id; },
      async runTurn(input: { text: string } | { toolOutput: ToolOutput }): Promise<TurnResult> {
        const turnId = `${threadId}-${++turn}`;
        if ('toolOutput' in input) return { threadId, turnId, status: 'completed', finalText: `final:${input.toolOutput.output}` };
        if (options.onToolCall) {
          const listed = await options.onToolCall({ tool: 'list_workers', callId: 'c1', arguments: {} });
          const workers = JSON.parse(listed.contentItems[0]!.text) as Array<{ workerId: string }>;
          await options.onToolCall({ tool: 'delegate_work', callId: 'c2', arguments: { workerId: workers[0]!.workerId, task: input.text } });
        }
        return { threadId, turnId, status: 'completed', finalText: 'delegated' };
      },
      async close() {},
    };
  };
}

async function readSseUntil(url: string, headers: Record<string, string>, predicate: (events: Array<{ id: number; event: string; data: Record<string, unknown> }>) => boolean): Promise<Array<{ id: number; event: string; data: Record<string, unknown> }>> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const received: Array<{ id: number; event: string; data: Record<string, unknown> }> = [];
  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (!block.trim() || block.startsWith(':')) continue;
        let id = 0;
        let event = 'message';
        let dataLine = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = Number(line.slice(4));
          else if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) dataLine = line.slice(6);
        }
        if (dataLine) received.push({ id, event, data: JSON.parse(dataLine) as Record<string, unknown> });
      }
      if (predicate(received)) break;
    }
  } finally {
    controller.abort();
    reader.releaseLock();
  }
  return received;
}

test('Express API와 SSE는 토큰 인증·Origin 검증·프로젝트별 격리·커서 재생을 보장한다', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hcom-gui-srv-test-'));
  const manager = new ProjectManager({
    dataDir,
    codexCommand: 'fake-codex',
    git: fakeGit(),
    pollIntervalMs: 10,
    replyTimeoutMs: 5000,
    createCodex: makeFakeCodex(),
    createHcom: makeFakeHcom,
  });
  const srv = await startGuiServer({
    manager,
    appVersion: '1.0.0',
    getDiagnostics: () => ({
      codex: { ok: true, path: 'C:\\codex.exe', version: '0.162.1' },
      hcom: { ok: true, path: 'C:\\hcom.exe', version: '0.7.31' },
      agy: { ok: true, path: 'C:\\agy.exe', version: '1.5.18' },
    }),
  });

  const authHeaders = { 'x-hcom-token': srv.token, 'content-type': 'application/json' };
  try {
    // 1. 무인증 401 및 외부 Origin 403 차단
    const noAuth = await fetch(`${srv.baseUrl}/api/projects`);
    assert.equal(noAuth.status, 401);
    const badOrigin = await fetch(`${srv.baseUrl}/api/projects`, { headers: { ...authHeaders, origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);

    // 2. 프로젝트 A·B 등록 및 worktree 중복 409 거절
    const resA = await fetch(`${srv.baseUrl}/api/projects`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ folderPath: 'C:\\srv\\a', name: 'A' }) });
    assert.equal(resA.status, 201);
    const idA = ((await resA.json()) as { snapshot: { project: { projectId: string } } }).snapshot.project.projectId;

    const dupWt = await fetch(`${srv.baseUrl}/api/projects`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ folderPath: 'C:\\srv\\a-wt' }) });
    assert.equal(dupWt.status, 409);

    const resB = await fetch(`${srv.baseUrl}/api/projects`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ folderPath: 'C:\\srv\\b', name: 'B' }) });
    assert.equal(resB.status, 201);
    const idB = ((await resB.json()) as { snapshot: { project: { projectId: string } } }).snapshot.project.projectId;

    // 3. A·B 시작 후 A/B 각각 SSE 구독하며 요청 동시 전송 → 프로젝트별 격리 확인
    await Promise.all([
      fetch(`${srv.baseUrl}/api/projects/${idA}/start`, { method: 'POST', headers: authHeaders }),
      fetch(`${srv.baseUrl}/api/projects/${idB}/start`, { method: 'POST', headers: authHeaders }),
    ]);

    const sseAPromise = readSseUntil(`${srv.baseUrl}/api/projects/${idA}/events?token=${srv.token}&afterSeq=0`, {}, evs => evs.some(e => e.event === 'request.finished'));
    const sseBPromise = readSseUntil(`${srv.baseUrl}/api/projects/${idB}/events?token=${srv.token}&afterSeq=0`, {}, evs => evs.some(e => e.event === 'request.finished'));

    const [postA, postB] = await Promise.all([
      fetch(`${srv.baseUrl}/api/projects/${idA}/requests`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ requestId: 'r-a-1', prompt: 'hello A' }) }),
      fetch(`${srv.baseUrl}/api/projects/${idB}/requests`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ requestId: 'r-b-1', prompt: 'hello B' }) }),
    ]);
    assert.equal(postA.status, 202);
    assert.equal(postB.status, 202);

    const [evsA, evsB] = await Promise.all([sseAPromise, sseBPromise]);
    assert.ok(evsA.length > 0 && evsA.every(e => e.data.projectId === idA));
    assert.ok(evsB.length > 0 && evsB.every(e => e.data.projectId === idB));
    assert.ok(evsA.some(e => e.event === 'hcom.message'));
    assert.ok(evsB.some(e => e.event === 'hcom.message'));

    // 4. 동일 requestId 재전송 시 200 deduplicated 반환 & 단건 재조회 확인
    const dupReq = await fetch(`${srv.baseUrl}/api/projects/${idA}/requests`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ requestId: 'r-a-1', prompt: 'hello A' }) });
    assert.equal(dupReq.status, 200);
    const dupBody = (await dupReq.json()) as { deduplicated: boolean; request: { status: string; finalText: string } };
    assert.equal(dupBody.deduplicated, true);
    assert.equal(dupBody.request.status, 'completed');
    assert.match(dupBody.request.finalText, /C:\\srv\\a/);

    // 5. Last-Event-ID 커서 기반 SSE 재생 확인 (인계 수정 이벤트 1회만 수신)
    const lastA = evsA.at(-1)!.id;
    const patchRes = await fetch(`${srv.baseUrl}/api/projects/${idA}/handoff`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ goal: '3단계 검증', testResult: '통과' }),
    });
    assert.equal(patchRes.status, 200);
    const replayed = await readSseUntil(
      `${srv.baseUrl}/api/projects/${idA}/events?token=${srv.token}`,
      { 'last-event-id': String(lastA) },
      evs => evs.some(e => e.event === 'handoff.updated'),
    );
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0]!.event, 'handoff.updated');
    assert.ok(replayed[0]!.id > lastA);
  } finally {
    await srv.close();
    await manager.shutdownAll().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
