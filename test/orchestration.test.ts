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
  WorkerLaunchOptions,
} from '../src/hcom/index.ts';
import { defaultGitInspector, type GitInspector } from '../src/projects/git.ts';
import { ProjectManager, summarizeWorkerReplyForCodex, type CodexClient, type HcomClient } from '../src/runtime/index.ts';

class SimHcomBackend {
  readonly hcomDir: string;
  nextEventId = 1;
  nextWorkerSeq = 1;
  codex?: { name: string; sessionId: string };
  readonly activeWorkers = new Map<string, { name: string; sessionId: string; directory: string; status: string; hooksBound: boolean; processBound: boolean; tool: string }>();
  readonly stoppedWorkers = new Map<string, { name: string; sessionId: string; directory: string; tool: string }>();
  readonly eventLog: HcomEvent[] = [];
  readonly listeners = new Set<(event: HcomEvent) => void>();
  onSend?: (info: { projectId: string; sender: Participant; target: Participant; text: string; eventId: number; emit: (ev: HcomEvent) => void; nextId: () => number }) => void;

  constructor(hcomDir: string) {
    this.hcomDir = hcomDir;
  }

  recordAndEmit(event: HcomEvent): void {
    this.eventLog.push(event);
    for (const listener of this.listeners) listener(event);
  }
}

class SimHcomNetwork {
  readonly backends = new Map<string, SimHcomBackend>();
  backendFor(scope: ProjectScope): SimHcomBackend {
    let b = this.backends.get(scope.hcomDir);
    if (!b) {
      b = new SimHcomBackend(scope.hcomDir);
      this.backends.set(scope.hcomDir, b);
    }
    return b;
  }
}

class SimHcomClient implements HcomClient {
  readonly scope: Readonly<ProjectScope>;
  readonly backend: SimHcomBackend;

  constructor(scope: ProjectScope, backend: SimHcomBackend) {
    this.scope = Object.freeze({ ...scope });
    this.backend = backend;
  }

  async initialize(): Promise<void> {}
  async startCodex(threadId: string): Promise<Participant> {
    if (!this.backend.codex) {
      this.backend.codex = { name: `codex_${this.scope.projectId.slice(0, 4)}`, sessionId: threadId };
    }
    return { projectId: this.scope.projectId, name: this.backend.codex.name, sessionId: threadId, tool: 'adhoc', status: 'active' };
  }
  async stopCodex(participant: Participant): Promise<void> {
    if (this.backend.codex?.name === participant.name) this.backend.codex = undefined;
  }
  async launchWorker(options?: WorkerLaunchOptions): Promise<WorkerLaunch> {
    const cwd = typeof options === 'object' && options?.cwd ? options.cwd : this.scope.cwd;
    const seq = this.backend.nextWorkerSeq++;
    const name = `w${seq}_${this.scope.projectId.slice(0, 4)}`;
    this.backend.activeWorkers.set(name, {
      name,
      sessionId: `conv-${this.scope.projectId}-${seq}`,
      directory: cwd,
      status: 'listening',
      hooksBound: true,
      processBound: true,
      tool: 'antigravity',
    });
    return Object.freeze({ name, batchId: `batch-${seq}`, readiness: 'ready' });
  }
  async resumeWorker(worker: WorkerBinding, options?: WorkerLaunchOptions): Promise<WorkerLaunch> {
    const cwd = typeof options === 'object' && options?.cwd ? options.cwd : worker.directory;
    this.backend.activeWorkers.set(worker.name, {
      name: worker.name,
      sessionId: worker.sessionId,
      directory: cwd,
      status: 'listening',
      hooksBound: true,
      processBound: true,
      tool: 'antigravity',
    });
    return Object.freeze({ name: worker.name, batchId: 'resume', readiness: 'ready' });
  }
  async probeWorker(name: string): Promise<WorkerBinding> {
    const item = this.backend.activeWorkers.get(name);
    if (!item) throw new Error('워커 바인딩 없음');
    return { projectId: this.scope.projectId, name: item.name, sessionId: item.sessionId, status: item.status, tool: item.tool, directory: item.directory, hooksBound: true, processBound: true, evidence: 'hcom-managed-binding' };
  }
  async verifyResumedWorker(worker: WorkerBinding): Promise<WorkerBinding> { return this.probeWorker(worker.name); }
  async stopWorker(worker: WorkerBinding): Promise<void> {
    const item = this.backend.activeWorkers.get(worker.name);
    if (item) {
      this.backend.activeWorkers.delete(worker.name);
      this.backend.stoppedWorkers.set(worker.name, { name: item.name, sessionId: item.sessionId, directory: item.directory, tool: item.tool });
    }
  }
  async stopWorkerByName(name: string): Promise<void> { this.backend.activeWorkers.delete(name); }
  async stopLaunch(launch: WorkerLaunch): Promise<void> { this.backend.activeWorkers.delete(launch.name); }
  async listParticipants(): Promise<ActiveParticipant[]> {
    const out: ActiveParticipant[] = [];
    if (this.backend.codex) {
      out.push({ projectId: this.scope.projectId, name: this.backend.codex.name, baseName: this.backend.codex.name, tool: 'adhoc', status: 'active', sessionId: this.backend.codex.sessionId, directory: this.scope.cwd, hooksBound: false, processBound: false });
    }
    for (const w of this.backend.activeWorkers.values()) {
      out.push({ projectId: this.scope.projectId, name: w.name, baseName: w.name, tool: w.tool, status: w.status, sessionId: w.sessionId, directory: w.directory, hooksBound: w.hooksBound, processBound: w.processBound });
    }
    return out;
  }
  async getStoppedWorker(name: string): Promise<StoppedParticipant | undefined> {
    const item = this.backend.stoppedWorkers.get(name);
    return item ? { projectId: this.scope.projectId, ...item } : undefined;
  }
  async settleWorker(): Promise<boolean> { return true; }
  async clearBannerOverlay(): Promise<boolean> { return false; }
  async readTerminal(): Promise<TerminalState> { return { ready: true, promptEmpty: true, inputText: '', lines: ['>'] }; }
  async clearJammedInput(): Promise<boolean> { return false; }
  async send(sender: Participant, target: Participant, text: string): Promise<Receipt> {
    const eventId = this.backend.nextEventId++;
    this.backend.recordAndEmit({
      projectId: this.scope.projectId,
      id: eventId,
      type: 'message',
      data: { from: sender.name, sender_kind: 'instance', intent: 'request', delivered_to: [target.name], text },
    });
    if (this.backend.onSend) {
      this.backend.onSend({
        projectId: this.scope.projectId,
        sender,
        target,
        text,
        eventId,
        emit: ev => this.backend.recordAndEmit(ev),
        nextId: () => this.backend.nextEventId++,
      });
    }
    return { eventId, deliveredTo: [target.name] };
  }
  follow(afterId: number, onEvent: (event: HcomEvent) => void): () => Promise<void> {
    for (const past of this.backend.eventLog) {
      if (past.id > afterId) onEvent(past);
    }
    this.backend.listeners.add(onEvent);
    return async () => { this.backend.listeners.delete(onEvent); };
  }
}

type TurnScript = (ctx: {
  input: { text: string } | { toolOutput: ToolOutput };
  turnNum: number;
  callTool: (tool: string, args: Record<string, unknown>) => Promise<string>;
}) => Promise<string>;

function makeScriptedCodex(onTurn: TurnScript) {
  let seq = 0;
  let totalTurns = 0;
  const create = async (options: SessionOptions): Promise<CodexClient> => {
    let threadId: string | undefined;
    let turnNum = 0;
    let callSeq = 0;
    return {
      async startThread() { threadId = `thread-${++seq}`; return threadId; },
      async resumeThread(id) { threadId = id; return threadId; },
      async runTurn(input): Promise<TurnResult> {
        turnNum++;
        totalTurns++;
        const finalText = await onTurn({
          input,
          turnNum,
          callTool: async (tool, args) => {
            const res = await options.onToolCall!({ tool, callId: `c-${++callSeq}`, arguments: args });
            return res.contentItems[0]?.text ?? '';
          },
        });
        if (finalText === '__NO_FINAL_ANSWER__') {
          return { threadId: threadId!, turnId: `turn-${turnNum}`, status: 'needs_final_answer', reason: '최종 본문 누락' };
        }
        return { threadId: threadId!, turnId: `turn-${turnNum}`, status: 'completed', finalText };
      },
      async close() {},
    };
  };
  return { create, getTotalTurns: () => totalTurns };
}

function makeFakeGit(): GitInspector {
  const map: Record<string, { root: string; common: string; branch: string }> = {
    'c:\\sim\\a': { root: 'C:\\sim\\a', common: 'C:\\sim\\a\\.git', branch: 'main-a' },
    'c:\\sim\\b': { root: 'C:\\sim\\b', common: 'C:\\sim\\b\\.git', branch: 'main-b' },
  };
  return {
    resolveProject(folderPath: string) {
      const key = folderPath.replace(/[\\/]+$/, '').toLowerCase();
      const found = map[key];
      if (!found) {
        return {
          rootPath: folderPath,
          rootKey: key,
          gitCommonDir: folderPath,
          gitCommonDirKey: `dir:${key}`,
          defaultName: folderPath.split(/[\\/]/).at(-1) || folderPath,
          isGitRepo: false,
        };
      }
      return {
        rootPath: found.root,
        rootKey: found.root.toLowerCase(),
        gitCommonDir: found.common,
        gitCommonDirKey: found.common.toLowerCase(),
        defaultName: found.root.split('\\').at(-1)!,
        isGitRepo: true,
      };
    },
    readSnapshot(cwd: string) {
      const found = map[cwd.replace(/[\\/]+$/, '').toLowerCase()];
      return found ? { branchStatus: found.branch, commitStatus: 'abc init' } : { branchStatus: 'Git 없음', commitStatus: 'Git 없음' };
    },
  };
}

test('summarizeWorkerReplyForCodex는 대용량 회신을 결과·변경 파일·테스트 요약 위주로 압축한다', () => {
  const short = '결과: 완료';
  assert.equal(summarizeWorkerReplyForCodex(short), short);

  const noisy = [
    '\x1b[32m결과: 로그인 API 수정 완료\x1b[0m',
    '변경 파일: src/auth.ts, test/auth.test.ts',
    '테스트 요약: 12/12 통과',
    ...Array.from({ length: 300 }, (_, i) => `verbose-log-line-${i}: ${'x'.repeat(30)}`),
  ].join('\n');
  const compacted = summarizeWorkerReplyForCodex(noisy, 1200);
  assert.ok(compacted.length < 1400);
  assert.match(compacted, /결과: 로그인 API 수정 완료/);
  assert.match(compacted, /변경 파일: src\/auth\.ts/);
  assert.match(compacted, /테스트 요약: 12\/12 통과/);
  assert.doesNotMatch(compacted, /\x1b\[/);
});

test('1차 회신이 부족하면 같은 요청 안에서 2차 재지시 후 검수 통과 시 최종 답변을 한 번만 반환한다', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hcom-orch-redelegate-'));
  const network = new SimHcomNetwork();
  let sendCount = 0;

  const codex = makeScriptedCodex(async ({ input, callTool }) => {
    const workers = JSON.parse(await callTool('list_workers', {})) as Array<{ workerId: string }>;
    const workerId = workers[0]!.workerId;
    if ('text' in input) {
      // 1차 위임: 한 턴에 2회 연속 위임 시도 시 2번째는 거절되는지도 함께 확인
      const first = await callTool('delegate_work', { workerId, task: '1차 구현과 테스트 실행' });
      assert.match(first, /1차/);
      const blockedDup = await callTool('delegate_work', { workerId, task: '중복 동시 위임' });
      assert.match(blockedDup, /한 턴에는 한 워커/);
      return '1차 위임 전송';
    }
      if (input.toolOutput.output.includes('테스트 누락')) {
      // 검수 결과 보완 필요 -> 같은 requestId에서 2차 재지시 (중간 위임 턴은 final_answer 없이 끝날 수 있음)
      const second = await callTool('delegate_work', { workerId, task: '누락된 테스트를 추가하고 통과시켜줘' });
      assert.match(second, /2차/);
      return '__NO_FINAL_ANSWER__';
    }
    return '최종 검수 통과: 구현 및 테스트 완료';
  });

  const manager = new ProjectManager({
    dataDir,
    codexCommand: 'fake',
    git: makeFakeGit(),
    pollIntervalMs: 10,
    replyTimeoutMs: 5000,
    createCodex: codex.create,
    createHcom: scope => {
      const backend = network.backendFor(scope);
      backend.onSend = ({ projectId, sender, target, eventId, emit, nextId }) => {
        sendCount++;
        const replyText = sendCount === 1
          ? '결과: 구현만 완료\n변경 파일: src/a.ts\n테스트 요약: 테스트 누락'
          : '결과: 테스트 보완 완료\n변경 파일: src/a.ts, test/a.test.ts\n테스트 요약: 5/5 통과';
        setTimeout(() => {
          emit({
            projectId,
            id: nextId(),
            type: 'message',
            instance: target.name,
            data: { from: target.name, sender_kind: 'instance', scope: 'mentions', intent: 'inform', reply_to: String(eventId), delivered_to: [sender.name], text: replyText },
          });
        }, 15);
      };
      return new SimHcomClient(scope, backend);
    },
  });

  try {
    const snap = manager.registerProject('C:\\sim\\a', { name: 'Alpha' });
    await manager.startProject(snap.project.projectId);
    const finishedEvents: unknown[] = [];
    manager.subscribeEvents(ev => {
      if (ev.kind === 'request.finished') finishedEvents.push(ev);
    });

    const req = await manager.submitRequest(snap.project.projectId, 'req-redelegate-1', '기능 구현하고 테스트까지 검증해줘');
    assert.equal(req.status, 'completed');
    assert.equal(req.round, 2);
    assert.equal(req.finalText, '최종 검수 통과: 구현 및 테스트 완료');
    assert.equal(finishedEvents.length, 1, '최종 완료 이벤트는 정확히 한 번만 발행돼야 합니다');

    const delegations = manager.listDelegations(snap.project.projectId, 'req-redelegate-1');
    assert.equal(delegations.length, 2);
    assert.equal(delegations[0]!.round, 1);
    assert.equal(delegations[0]!.status, 'reviewed');
    assert.equal(delegations[1]!.round, 2);
    assert.equal(delegations[1]!.status, 'reviewed');
  } finally {
    await manager.shutdownAll().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('직접 답변, ask_user 질문 후 재접속·답변 이어가기, 중복 답변 차단이 동작한다', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hcom-orch-askuser-'));
  const network = new SimHcomNetwork();
  const makeCodex = () => makeScriptedCodex(async ({ input, callTool }) => {
    if ('text' in input && input.text.includes('간단 질문')) {
      return '직접 답변: 위임 없이 완료했습니다.';
    }
    if ('text' in input && input.text.includes('설계 선택')) {
      await callTool('ask_user', { question: 'A안과 B안 중 어떤 방식을 원하시나요?', options: ['A안', 'B안'] });
      return '질문 대기';
    }
    if ('text' in input && input.text.includes('[사용자 답변]') && input.text.includes('B안')) {
      const workers = JSON.parse(await callTool('list_workers', {})) as Array<{ workerId: string }>;
      await callTool('delegate_work', { workerId: workers[0]!.workerId, task: 'B안 적용' });
      return 'B안 위임';
    }
    if ('toolOutput' in input) {
      return `B안 최종 완료 (${input.toolOutput.output.includes('B안 완료') ? '검수 통과' : '확인'})`;
    }
    return '기타';
  });

  const makeManager = (codex: ReturnType<typeof makeCodex>) => new ProjectManager({
    dataDir,
    codexCommand: 'fake',
    git: makeFakeGit(),
    pollIntervalMs: 10,
    replyTimeoutMs: 5000,
    createCodex: codex.create,
    createHcom: scope => {
      const backend = network.backendFor(scope);
      backend.onSend = ({ projectId, sender, target, eventId, emit, nextId }) => {
        setTimeout(() => {
          emit({
            projectId,
            id: nextId(),
            type: 'message',
            instance: target.name,
            data: { from: target.name, sender_kind: 'instance', scope: 'mentions', intent: 'inform', reply_to: String(eventId), delivered_to: [sender.name], text: '결과: B안 완료\n변경 파일: src/b.ts\n테스트 요약: 통과' },
          });
        }, 15);
      };
      return new SimHcomClient(scope, backend);
    },
  });

  const codex1 = makeCodex();
  const m1 = makeManager(codex1);
  let projectId = '';
  try {
    const snap = m1.registerProject('C:\\sim\\a', { name: 'Alpha' });
    projectId = snap.project.projectId;
    await m1.startProject(projectId);

    // 1. 직접 답변
    const direct = await m1.submitRequest(projectId, 'req-direct', '간단 질문입니다');
    assert.equal(direct.status, 'completed');
    assert.equal(direct.round, 0);
    assert.equal(direct.finalText, '직접 답변: 위임 없이 완료했습니다.');
    assert.equal(m1.listDelegations(projectId, 'req-direct').length, 0);

    // 2. ask_user -> waiting_user 대기
    const waiting = await m1.submitRequest(projectId, 'req-ask', '설계 선택이 필요한 작업');
    assert.equal(waiting.status, 'waiting_user');
    assert.equal(waiting.pendingQuestion, 'A안과 B안 중 어떤 방식을 원하시나요?');
    assert.deepEqual(waiting.pendingQuestionOptions, ['A안', 'B안']);
    const turnsWhileWaiting = codex1.getTotalTurns();
    await new Promise(r => setTimeout(r, 80));
    assert.equal(codex1.getTotalTurns(), turnsWhileWaiting, '답변 대기 중 추가 Codex 턴이 없어야 합니다');

    // 3. 백엔드 재접속 후에도 waiting_user 상태가 유지되고 같은 requestId에서 이어짐
    await m1.detachAll();
    const codex2 = makeCodex();
    const m2 = makeManager(codex2);
    try {
      const restored = m2.getRequest(projectId, 'req-ask')!;
      assert.equal(restored.status, 'waiting_user');
      assert.equal(restored.pendingQuestion, 'A안과 B안 중 어떤 방식을 원하시나요?');

      const resumed = await m2.replyToRequest(projectId, 'req-ask', 'rk-1', 'B안');
      assert.equal(resumed.deduplicated, false);
      assert.equal(resumed.request.status, 'completed');
      assert.equal(resumed.request.round, 1);
      assert.match(resumed.request.finalText ?? '', /B안 최종 완료/);
      assert.equal(resumed.request.userReplies.length, 1);

      // 동일 replyKey 중복 제출 차단
      const dupReply = await m2.replyToRequest(projectId, 'req-ask', 'rk-1', 'B안');
      assert.equal(dupReply.deduplicated, true);
      await m2.shutdownAll();
    } finally {
      await m2.detachAll().catch(() => {});
    }
  } finally {
    await m1.detachAll().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('시간 초과(timed_out), 취소(cancelled), 실패(failed)를 명확히 구분한다', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hcom-orch-states-'));
  const network = new SimHcomNetwork();
  const codex = makeScriptedCodex(async ({ input, callTool }) => {
    if ('text' in input) {
      const workers = JSON.parse(await callTool('list_workers', {})) as Array<{ workerId: string }>;
      await callTool('delegate_work', { workerId: workers[0]!.workerId, task: input.text });
      return '위임';
    }
    return '완료';
  });

  const manager = new ProjectManager({
    dataDir,
    codexCommand: 'fake',
    git: makeFakeGit(),
    pollIntervalMs: 15,
    replyTimeoutMs: 120,
    createCodex: codex.create,
    createHcom: scope => {
      const backend = network.backendFor(scope);
      // 의도적으로 회신을 보내지 않음 (timeout / cancel 검증)
      return new SimHcomClient(scope, backend);
    },
  });

  try {
    const snap = manager.registerProject('C:\\sim\\a', { name: 'Alpha' });
    await manager.startProject(snap.project.projectId);

    // 1. 시간 초과 -> timed_out
    const timedOut = await manager.submitRequest(snap.project.projectId, 'req-timeout', '회신 없는 작업');
    assert.equal(timedOut.status, 'timed_out');
    assert.match(timedOut.error ?? '', /시간 초과/);

    // 2. 진행 중 취소 -> cancelled
    const cancelPromise = manager.submitRequest(snap.project.projectId, 'req-cancel', '취소할 작업');
    await new Promise(r => setTimeout(r, 35));
    await manager.cancelRequest(snap.project.projectId, 'req-cancel');
    const cancelled = await cancelPromise;
    assert.equal(cancelled.status, 'cancelled');
  } finally {
    await manager.shutdownAll().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('회신 중복 도착과 백엔드 재접속 복구(resumePendingRequests) 시 검수가 정확히 한 번만 실행된다', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hcom-orch-recovery-'));
  const network = new SimHcomNetwork();
  let reviewCount = 0;
  let capturedSend: { projectId: string; sender: Participant; target: Participant; eventId: number; emit: (ev: HcomEvent) => void; nextId: () => number } | undefined;

  const makeCodex = () => makeScriptedCodex(async ({ input, callTool }) => {
    if ('text' in input) {
      const workers = JSON.parse(await callTool('list_workers', {})) as Array<{ workerId: string }>;
      await callTool('delegate_work', { workerId: workers[0]!.workerId, task: '오프라인 복구 작업' });
      return '위임';
    }
    reviewCount++;
    return `복구 검수 완료 (${reviewCount}회)`;
  });

  const makeManager = (codex: ReturnType<typeof makeCodex>, replyTimeoutMs: number) => new ProjectManager({
    dataDir,
    codexCommand: 'fake',
    git: makeFakeGit(),
    pollIntervalMs: 15,
    replyTimeoutMs,
    createCodex: codex.create,
    createHcom: scope => {
      const backend = network.backendFor(scope);
      backend.onSend = info => { capturedSend = info; };
      return new SimHcomClient(scope, backend);
    },
  });

  const m1 = makeManager(makeCodex(), 5000);
  let projectId = '';
  try {
    const snap = m1.registerProject('C:\\sim\\a', { name: 'Alpha' });
    projectId = snap.project.projectId;
    await m1.startProject(projectId);

    // 요청 전송 후 worker_working 상태에서 백엔드 분리 시뮬레이션
    const pendingPromise = m1.submitRequest(projectId, 'req-recover', '재접속 복구 테스트');
    pendingPromise.catch(() => {});
    await new Promise(r => setTimeout(r, 40));
    assert.ok(capturedSend);
    assert.equal(m1.getRequest(projectId, 'req-recover')?.status, 'worker_working');
    await m1.detachAll();

    // 백엔드가 끊긴 동안 워커가 회신을 보내고, 동일 이벤트가 중복 기록되는 상황
    const replyEventId = capturedSend!.nextId();
    const replyEvent: HcomEvent = {
      projectId,
      id: replyEventId,
      type: 'message',
      instance: capturedSend!.target.name,
      data: {
        from: capturedSend!.target.name,
        sender_kind: 'instance',
        scope: 'mentions',
        intent: 'inform',
        reply_to: String(capturedSend!.eventId),
        delivered_to: [capturedSend!.sender.name],
        text: '결과: 오프라인 중 완료\n변경 파일: src/rec.ts\n테스트 요약: 통과',
      },
    };
    capturedSend!.emit(replyEvent);
    capturedSend!.emit(replyEvent); // 중복 이벤트

    // 새 백엔드에서 재접속 복구
    const m2 = makeManager(makeCodex(), 5000);
    try {
      const resumed = await m2.resumePendingRequests(projectId);
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0]!.status, 'completed');
      assert.equal(resumed[0]!.finalText, '복구 검수 완료 (1회)');
      assert.equal(reviewCount, 1);

      // 재호출해도 이미 검수 완료된 회신을 다시 처리하지 않음
      const secondCall = await m2.resumePendingRequests(projectId);
      assert.equal(secondCall.length, 0);
      assert.equal(reviewCount, 1);
      await m2.shutdownAll();
    } finally {
      await m2.detachAll().catch(() => {});
    }
  } finally {
    await m1.detachAll().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('A·B 동시 멀티라운드 격리, 일반 폴더 등록, 워커 직접 메시지 전송이 동작한다', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hcom-orch-parallel-'));
  const plainDir = join(dataDir, 'plain-workspace');
  mkdirSync(plainDir, { recursive: true });
  const network = new SimHcomNetwork();
  const roundByProject = new Map<string, number>();

  const codex = makeScriptedCodex(async ({ input, callTool }) => {
    const workers = JSON.parse(await callTool('list_workers', {})) as Array<{ workerId: string; cwd: string }>;
    const worker = workers[0]!;
    if ('text' in input) {
      if (input.text.includes('ask-b')) {
        await callTool('ask_user', { question: 'B 확인?' });
        return '질문';
      }
      if (input.text.includes('[사용자 답변]')) {
        await callTool('delegate_work', { workerId: worker.workerId, task: 'B 작업' });
        return 'B 위임';
      }
      await callTool('delegate_work', { workerId: worker.workerId, task: 'A 1차' });
      return 'A 1차';
    }
    const prev = (roundByProject.get(worker.cwd) ?? 0) + 1;
    roundByProject.set(worker.cwd, prev);
    if (worker.cwd.includes('\\a') && prev === 1) {
      await callTool('delegate_work', { workerId: worker.workerId, task: 'A 2차 보완' });
      return 'A 2차';
    }
    return `DONE:${worker.cwd}:${input.toolOutput.output.includes('2차') ? 'round2' : 'round1'}`;
  });

  const manager = new ProjectManager({
    dataDir,
    codexCommand: 'fake',
    git: makeFakeGit(),
    pollIntervalMs: 10,
    replyTimeoutMs: 5000,
    createCodex: codex.create,
    createHcom: scope => {
      const backend = network.backendFor(scope);
      backend.onSend = ({ projectId, sender, target, text, eventId, emit, nextId }) => {
        setTimeout(() => {
          emit({
            projectId,
            id: nextId(),
            type: 'message',
            instance: target.name,
            data: { from: target.name, sender_kind: 'instance', scope: 'mentions', intent: 'inform', reply_to: String(eventId), delivered_to: [sender.name], text: `REPLY(${scope.cwd}): ${text.split('\n')[0]}` },
          });
        }, 15);
      };
      return new SimHcomClient(scope, backend);
    },
  });

  try {
    const snapA = manager.registerProject('C:\\sim\\a', { name: 'A' });
    const snapB = manager.registerProject('C:\\sim\\b', { name: 'B' });
    const snapPlain = manager.registerProject(plainDir, { name: 'Plain' });
    assert.equal(snapPlain.handoff.branchStatus, 'Git 없음');
    await assert.rejects(manager.switchWorktree(snapPlain.project.projectId, 'codex', 'C:\\sim\\a'), /일반 폴더/);

    await Promise.all([
      manager.startProject(snapA.project.projectId),
      manager.startProject(snapB.project.projectId),
      manager.startProject(snapPlain.project.projectId),
    ]);

    // A(2라운드 재지시)와 B(ask_user -> reply -> 위임) 동시 실행
    const pA = manager.submitRequest(snapA.project.projectId, 'req-a', 'A 멀티라운드');
    const pB = manager.submitRequest(snapB.project.projectId, 'req-b', 'ask-b');
    const waitingB = await pB;
    assert.equal(waitingB.status, 'waiting_user');
    const [doneA, doneB] = await Promise.all([
      pA,
      manager.replyToRequest(snapB.project.projectId, 'req-b', 'rk-b', '진행'),
    ]);
    assert.equal(doneA.status, 'completed');
    assert.equal(doneA.round, 2);
    assert.match(doneA.finalText ?? '', /C:\\sim\\a/);
    assert.ok(!(doneA.finalText ?? '').includes('C:\\sim\\b'));
    assert.equal(doneB.request.status, 'completed');
    assert.match(doneB.request.finalText ?? '', /C:\\sim\\b/);
    assert.ok(!(doneB.request.finalText ?? '').includes('C:\\sim\\a'));

    // 일반 폴더 프로젝트에서 워커 직접 메시지 전송 검증 + 타 프로젝트 워커 거절
    const plainWorkerId = snapPlain.workers[0]!.workerId;
    const directRes = await manager.sendDirectWorkerMessage(snapPlain.project.projectId, plainWorkerId, 'direct-1', '직접 확인');
    assert.equal(directRes.deduplicated, false);
    assert.equal(directRes.request.mode, 'direct_worker');
    assert.equal(directRes.request.status, 'completed');
    assert.match(directRes.request.finalText ?? '', /직접 확인/);
    await assert.rejects(
      manager.sendDirectWorkerMessage(snapPlain.project.projectId, snapA.workers[0]!.workerId, 'direct-cross', '교차'),
      /다른 프로젝트/,
    );

    // 실제 디스크 기반 defaultGitInspector에서도 일반 폴더가 정상 해석됨 확인
    const realPlain = defaultGitInspector.resolveProject(plainDir);
    assert.equal(realPlain.isGitRepo, false);
    assert.equal(defaultGitInspector.readSnapshot(plainDir).branchStatus, 'Git 없음');
  } finally {
    await manager.shutdownAll().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
