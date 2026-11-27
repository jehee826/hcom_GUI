import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import type { GitInspector, GitRepoInfo } from '../src/projects/git.ts';
import { ProjectManager, type CodexClient, type HcomClient } from '../src/runtime/index.ts';

class FakeHcomNetwork {
  private readonly scopes = new Map<string, FakeHcomBackend>();

  backendFor(scope: ProjectScope): FakeHcomBackend {
    let backend = this.scopes.get(scope.hcomDir);
    if (!backend) {
      backend = new FakeHcomBackend(scope.hcomDir);
      this.scopes.set(scope.hcomDir, backend);
    }
    return backend;
  }
}

class FakeHcomBackend {
  readonly hcomDir: string;
  nextEventId = 1;
  nextWorkerSeq = 1;
  codex?: { name: string; sessionId: string };
  readonly activeWorkers = new Map<string, { name: string; sessionId: string; directory: string; status: string; hooksBound: boolean; processBound: boolean; tool: string }>();
  readonly stoppedWorkers = new Map<string, { name: string; sessionId: string; directory: string; tool: string }>();
  readonly sentLog: Array<{ sender: string; target: string; text: string; eventId: number }> = [];
  readonly listeners = new Set<(event: HcomEvent) => void>();
  failWorktreeResumeFor?: string;
  forceSessionIdFor?: Map<string, string>;

  constructor(hcomDir: string) {
    this.hcomDir = hcomDir;
  }

  emit(event: HcomEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeHcomClient implements HcomClient {
  readonly scope: Readonly<ProjectScope>;
  readonly backend: FakeHcomBackend;
  readonly launchCount = { launch: 0, resume: 0 };

  constructor(scope: ProjectScope, backend: FakeHcomBackend) {
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
    this.launchCount.launch++;
    await new Promise(resolve => setTimeout(resolve, 15));
    const cwd = typeof options === 'object' && options?.cwd ? options.cwd : this.scope.cwd;
    const seq = this.backend.nextWorkerSeq++;
    const name = `w${seq}_${this.scope.projectId.slice(0, 4)}`;
    const sessionId = this.backend.forceSessionIdFor?.get(name) ?? `conv-${this.scope.projectId}-${seq}`;
    this.backend.activeWorkers.set(name, {
      name,
      sessionId,
      directory: cwd,
      status: 'listening',
      hooksBound: true,
      processBound: true,
      tool: 'antigravity',
    });
    return Object.freeze({ name, batchId: `batch-${seq}`, readiness: 'ready' });
  }

  async resumeWorker(worker: WorkerBinding, options?: WorkerLaunchOptions): Promise<WorkerLaunch> {
    this.launchCount.resume++;
    const stopped = this.backend.stoppedWorkers.get(worker.name);
    if (!stopped || stopped.sessionId !== worker.sessionId) throw new Error('중지된 워커와 저장된 세션이 일치하지 않습니다');
    const cwd = typeof options === 'object' && options?.cwd ? options.cwd : worker.directory;
    if (this.backend.failWorktreeResumeFor && cwd.toLowerCase() === this.backend.failWorktreeResumeFor.toLowerCase()) {
      throw new Error('agy가 다른 cwd에서 기존 대화 재개를 거부했습니다');
    }
    this.backend.stoppedWorkers.delete(worker.name);
    this.backend.activeWorkers.set(worker.name, {
      name: worker.name,
      sessionId: worker.sessionId,
      directory: cwd,
      status: 'listening',
      hooksBound: true,
      processBound: true,
      tool: 'antigravity',
    });
    return Object.freeze({ name: worker.name, batchId: 'resume-batch', readiness: 'ready' });
  }

  async probeWorker(name: string, expectedCwd?: string): Promise<WorkerBinding> {
    const item = this.backend.activeWorkers.get(name);
    if (!item) throw new Error('워커의 세션 바인딩 확인 필요');
    if (expectedCwd && item.directory.toLowerCase() !== expectedCwd.toLowerCase()) {
      throw new Error('워커의 프로젝트 소속 확인 필요');
    }
    return {
      projectId: this.scope.projectId,
      name: item.name,
      sessionId: item.sessionId,
      status: item.status,
      tool: item.tool,
      directory: item.directory,
      hooksBound: true,
      processBound: true,
      evidence: 'hcom-managed-binding',
    };
  }

  async verifyResumedWorker(worker: WorkerBinding, expectedCwd?: string): Promise<WorkerBinding> {
    const current = await this.probeWorker(worker.name, expectedCwd ?? worker.directory);
    if (current.sessionId !== worker.sessionId) throw new Error('재개된 native 대화 ID가 다릅니다');
    return current;
  }

  async stopWorker(worker: WorkerBinding): Promise<void> {
    const item = this.backend.activeWorkers.get(worker.name);
    if (!item || item.sessionId !== worker.sessionId) throw new Error('워커 세션이 변경되었습니다');
    this.backend.activeWorkers.delete(worker.name);
    this.backend.stoppedWorkers.set(worker.name, {
      name: item.name,
      sessionId: item.sessionId,
      directory: item.directory,
      tool: item.tool,
    });
  }

  async stopWorkerByName(name: string): Promise<void> {
    const item = this.backend.activeWorkers.get(name);
    if (!item) return;
    this.backend.activeWorkers.delete(name);
    this.backend.stoppedWorkers.set(name, { name: item.name, sessionId: item.sessionId, directory: item.directory, tool: item.tool });
  }

  async stopLaunch(launch: WorkerLaunch): Promise<void> {
    await this.stopWorkerByName(launch.name);
  }

  async listParticipants(): Promise<ActiveParticipant[]> {
    const list: ActiveParticipant[] = [];
    if (this.backend.codex) {
      list.push({
        projectId: this.scope.projectId,
        name: this.backend.codex.name,
        baseName: this.backend.codex.name,
        tool: 'adhoc',
        status: 'active',
        sessionId: this.backend.codex.sessionId,
        directory: this.scope.cwd,
        hooksBound: true,
        processBound: false,
      });
    }
    for (const w of this.backend.activeWorkers.values()) {
      list.push({
        projectId: this.scope.projectId,
        name: w.name,
        baseName: w.name,
        tool: w.tool,
        status: w.status,
        sessionId: w.sessionId,
        directory: w.directory,
        hooksBound: w.hooksBound,
        processBound: w.processBound,
      });
    }
    return list;
  }

  async getStoppedWorker(name: string): Promise<StoppedParticipant | undefined> {
    const item = this.backend.stoppedWorkers.get(name);
    if (!item) return undefined;
    return { projectId: this.scope.projectId, ...item };
  }

  async settleWorker(): Promise<boolean> { return true; }
  async clearBannerOverlay(): Promise<boolean> { return false; }
  async readTerminal(): Promise<TerminalState> { return { ready: true, promptEmpty: true, inputText: '', lines: ['>'] }; }
  async clearJammedInput(): Promise<boolean> { return false; }

  async send(sender: Participant, target: Participant, text: string): Promise<Receipt> {
    if (sender.projectId !== this.scope.projectId || target.projectId !== this.scope.projectId) {
      throw new Error('다른 프로젝트 참가자입니다');
    }
    const worker = this.backend.activeWorkers.get(target.name);
    if (!worker) throw new Error(`활성 워커 없음: ${target.name}`);
    const eventId = this.backend.nextEventId++;
    this.backend.sentLog.push({ sender: sender.name, target: target.name, text, eventId });
    setTimeout(() => {
      const replyId = this.backend.nextEventId++;
      this.backend.emit({
        projectId: this.scope.projectId,
        id: replyId,
        type: 'message',
        instance: worker.name,
        data: {
          from: worker.name,
          sender_kind: 'instance',
          scope: 'mentions',
          delivered_to: [sender.name],
          reply_to: String(eventId),
          intent: 'inform',
          text: `reply:${worker.name}:${worker.directory}`,
        },
      });
    }, 10);
    return { eventId, deliveredTo: [target.name] };
  }

  follow(_afterId: number, onEvent: (event: HcomEvent) => void): () => Promise<void> {
    this.backend.listeners.add(onEvent);
    return async () => { this.backend.listeners.delete(onEvent); };
  }
}

class FakeCodexFactory {
  nextThreadSeq = 1;
  readonly connections: Array<{ cwd: string; hcomDir?: string; started?: string; resumed?: string; closed: boolean }> = [];
  onDelegateTarget?: (prompt: string, workersJson: string) => { workerId: string; task: string } | undefined;

  create = async (options: SessionOptions): Promise<CodexClient> => {
    await new Promise(resolve => setTimeout(resolve, 10));
    const record = { cwd: options.cwd, hcomDir: options.hcomDir, started: undefined as string | undefined, resumed: undefined as string | undefined, closed: false };
    this.connections.push(record);
    let threadId = '';
    let turnSeq = 0;

    return {
      startThread: async () => {
        threadId = `thread-${this.nextThreadSeq++}`;
        record.started = threadId;
        return threadId;
      },
      resumeThread: async (id: string) => {
        threadId = id;
        record.resumed = id;
        return id;
      },
      runTurn: async (input: { text: string } | { toolOutput: ToolOutput }): Promise<TurnResult> => {
        const turnId = `${threadId}-turn-${++turnSeq}`;
        if ('toolOutput' in input) {
          return { threadId, turnId, status: 'completed', finalText: `reviewed:${input.toolOutput.output}` };
        }
        if (options.onToolCall) {
          const listResult = await options.onToolCall({ tool: 'list_workers', callId: `list-${turnSeq}`, arguments: {} });
          const workersJson = listResult.contentItems[0]?.text ?? '[]';
          const delegation = this.onDelegateTarget?.(input.text, workersJson);
          if (delegation) {
            const delResult = await options.onToolCall({
              tool: 'delegate_work',
              callId: `del-${turnSeq}`,
              arguments: delegation,
            });
            return {
              threadId,
              turnId,
              status: 'completed',
              finalText: delResult.success ? 'delegated' : `rejected:${delResult.contentItems[0]?.text}`,
            };
          }
        }
        return { threadId, turnId, status: 'completed', finalText: `direct:${options.cwd}` };
      },
      close: async () => { record.closed = true; },
    };
  };
}

function makeFakeGit(): GitInspector {
  const map: Record<string, GitRepoInfo & { branch: string; commit: string }> = {
    'c:\\repos\\a': { rootPath: 'C:\\repos\\a', rootKey: 'c:\\repos\\a', gitCommonDir: 'C:\\repos\\a\\.git', gitCommonDirKey: 'c:\\repos\\a\\.git', defaultName: 'repo-a', branch: 'branch-a', commit: '커밋 없음' },
    'c:\\repos\\a-wt': { rootPath: 'C:\\repos\\a-wt', rootKey: 'c:\\repos\\a-wt', gitCommonDir: 'C:\\repos\\a\\.git', gitCommonDirKey: 'c:\\repos\\a\\.git', defaultName: 'repo-a-wt', branch: 'branch-a-wt', commit: '111 wt commit' },
    'c:\\repos\\b': { rootPath: 'C:\\repos\\b', rootKey: 'c:\\repos\\b', gitCommonDir: 'C:\\repos\\b\\.git', gitCommonDirKey: 'c:\\repos\\b\\.git', defaultName: 'repo-b', branch: 'branch-b', commit: '커밋 없음' },
  };
  return {
    resolveProject(folderPath: string): GitRepoInfo {
      const entry = map[folderPath.toLowerCase()];
      if (!entry) throw new Error(`unknown repo: ${folderPath}`);
      return entry;
    },
    readSnapshot(cwd: string) {
      const entry = map[cwd.toLowerCase()];
      return entry ? { branchStatus: entry.branch, commitStatus: entry.commit } : { branchStatus: '확인 필요', commitStatus: '확인 필요' };
    },
  };
}

test('2단계 전체 격리: A·B 동시 실행, 교차 거절, 추가 워커, 중복 방지, worktree 전환, 백엔드 재시작 복구', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hcom-gui-mgr-test-'));
  const network = new FakeHcomNetwork();
  const codexFactory = new FakeCodexFactory();
  const hcomClients = new Map<string, FakeHcomClient>();

  const makeManager = () => new ProjectManager({
    dataDir,
    codexCommand: 'fake-codex',
    git: makeFakeGit(),
    pollIntervalMs: 10,
    replyTimeoutMs: 5000,
    createCodex: codexFactory.create,
    createHcom: scope => {
      const client = new FakeHcomClient(scope, network.backendFor(scope));
      hcomClients.set(scope.projectId, client);
      return client;
    },
  });

  const manager = makeManager();
  try {
    // 1. A·B 등록 및 중복 worktree 등록 거절
    const snapA = manager.registerProject('C:\\repos\\a', { name: 'Project A' });
    const snapB = manager.registerProject('C:\\repos\\b', { name: 'Project B' });
    assert.throws(() => manager.registerProject('C:\\repos\\a-wt'), /이미 같은 프로젝트 폴더/);
    assert.notEqual(snapA.project.projectId, snapB.project.projectId);
    assert.notEqual(snapA.project.hcomDir, snapB.project.hcomDir);

    // 2. A·B 동시 시작 + A 이중 클릭(동시 startProject) 직렬화 검증
    const [startedA1, startedA2, startedB] = await Promise.all([
      manager.startProject(snapA.project.projectId),
      manager.startProject(snapA.project.projectId),
      manager.startProject(snapB.project.projectId),
    ]);
    assert.equal(startedA1.codex.threadId, startedA2.codex.threadId);
    assert.notEqual(startedA1.codex.threadId, startedB.codex.threadId);
    assert.equal(hcomClients.get(snapA.project.projectId)!.launchCount.launch, 1);
    assert.equal(hcomClients.get(snapB.project.projectId)!.launchCount.launch, 1);

    const workerA1 = startedA1.workers[0]!;
    const workerB1 = startedB.workers[0]!;
    assert.ok(workerA1.conversationId);
    assert.ok(workerB1.conversationId);
    assert.notEqual(workerA1.conversationId, workerB1.conversationId);

    // 각 hcom 목록은 자기 프로젝트 참가자만 표시 (Codex 1 + 기본 워커 1 = 2)
    assert.equal((await manager.listProjectHcomParticipants(snapA.project.projectId)).length, 2);
    assert.equal((await manager.listProjectHcomParticipants(snapB.project.projectId)).length, 2);

    // 3. 양방향 교차 workerId 전송 거절 및 상대 대화 ID 재사용 거절
    await assert.rejects(manager.sendTaskToWorker(snapA.project.projectId, workerB1.workerId, 'cross'), /다른 프로젝트/);
    await assert.rejects(manager.sendTaskToWorker(snapB.project.projectId, workerA1.workerId, 'cross'), /다른 프로젝트/);
    await assert.rejects(manager.bindWorkerConversation(snapA.project.projectId, workerA1.workerId, workerB1.conversationId!), /재사용할 수 없습니다/);
    assert.equal(network.backendFor(hcomClients.get(snapB.project.projectId)!.scope).sentLog.length, 0);

    // Codex 도구를 통한 교차 workerId 위임도 거절되고 B에 메시지가 가지 않는다.
    codexFactory.onDelegateTarget = () => ({ workerId: workerB1.workerId, task: 'steal B' });
    const rejectedReq = await manager.submitRequest(snapA.project.projectId, 'req-cross', 'cross test');
    assert.match(rejectedReq.finalText ?? '', /rejected:거절됨/);
    assert.equal(network.backendFor(hcomClients.get(snapB.project.projectId)!.scope).sentLog.length, 0);

    // 4. A에 추가 워커 생성 + 동일 requestKey 재전송(동시 포함) 중복 방지
    const [added1, added2] = await Promise.all([
      manager.addWorker(snapA.project.projectId, { name: '워커 2', requestKey: 'add-w2' }),
      manager.addWorker(snapA.project.projectId, { name: '워커 2', requestKey: 'add-w2' }),
    ]);
    assert.equal(added1.workerId, added2.workerId);
    assert.notEqual(added1.workerId, workerA1.workerId);
    assert.notEqual(added1.conversationId, workerA1.conversationId);
    assert.equal((await manager.listProjectHcomParticipants(snapA.project.projectId)).length, 3);
    assert.equal((await manager.listProjectHcomParticipants(snapB.project.projectId)).length, 2);

    // 추가 워커만 지목해 Codex 위임 → 회신 → 검토 → 인계 기록 갱신
    codexFactory.onDelegateTarget = (_prompt, workersJson) => {
      const list = JSON.parse(workersJson) as Array<{ workerId: string }>;
      assert.equal(list.length, 2);
      assert.ok(list.every(item => item.workerId !== workerB1.workerId));
      return { workerId: added1.workerId, task: 'check branch' };
    };
    const delegatedReq = await manager.submitRequest(snapA.project.projectId, 'req-a-1', 'delegate to worker 2');
    assert.equal(delegatedReq.status, 'completed');
    assert.match(delegatedReq.finalText ?? '', new RegExp(`reviewed:.*${added1.hcomName}`, 's'));
    // 동일 requestId 재전송 시 재실행하지 않고 저장 결과 반환
    const dupReq = await manager.submitRequest(snapA.project.projectId, 'req-a-1', 'delegate to worker 2');
    assert.equal(dupReq.reviewTurnId, delegatedReq.reviewTurnId);

    const backendA = network.backendFor(hcomClients.get(snapA.project.projectId)!.scope);
    assert.equal(backendA.sentLog.length, 1);
    assert.equal(backendA.sentLog[0]!.target, added1.hcomName);
    assert.equal(network.backendFor(hcomClients.get(snapB.project.projectId)!.scope).sentLog.length, 0);

    // 인계 기록 격리 확인
    const handoffA = manager.getHandoff(snapA.project.projectId);
    const handoffB = manager.getHandoff(snapB.project.projectId);
    assert.match(handoffA.lastWorkerReport ?? '', new RegExp(added1.hcomName!));
    assert.equal(handoffB.lastWorkerReport, null);
    assert.equal(handoffB.testResult, '미실행');
    assert.equal(handoffB.commitStatus, '커밋 없음');

    // 5. 추가 워커 개별 중지 후 동일 ID 재개 (기본 워커/Codex 유지)
    const stoppedAdded = await manager.stopWorker(snapA.project.projectId, added1.workerId);
    assert.equal(stoppedAdded.status, 'stopped');
    const resumedAdded = await manager.startWorker(snapA.project.projectId, added1.workerId);
    assert.equal(resumedAdded.status, 'ready');
    assert.equal(resumedAdded.conversationId, added1.conversationId);
    assert.equal(manager.getProjectSnapshot(snapA.project.projectId).workers[0]!.conversationId, workerA1.conversationId);

    // 6. worktree 전환: B 경로 지정 거절, A의 worktree 전환 성공 + 실패 시 기존 경로 보존
    await assert.rejects(manager.switchWorktree(snapA.project.projectId, 'codex', 'C:\\repos\\b'), /다른 Git 저장소/);
    await assert.rejects(manager.switchWorktree(snapA.project.projectId, { workerId: workerA1.workerId }, 'C:\\repos\\b'), /다른 Git 저장소/);

    const switchedCodex = await manager.switchWorktree(snapA.project.projectId, 'codex', 'C:\\repos\\a-wt');
    assert.equal(switchedCodex.codex.cwd, 'C:\\repos\\a-wt');
    assert.equal(switchedCodex.codex.threadId, startedA1.codex.threadId);
    assert.equal(switchedCodex.project.hcomDir, snapA.project.hcomDir);
    assert.equal(switchedCodex.handoff.branchStatus, 'branch-a-wt');

    const switchedWorker = await manager.switchWorktree(snapA.project.projectId, { workerId: workerA1.workerId }, 'C:\\repos\\a-wt');
    const movedA1 = switchedWorker.workers.find(w => w.workerId === workerA1.workerId)!;
    assert.equal(movedA1.cwd, 'C:\\repos\\a-wt');
    assert.equal(movedA1.conversationId, workerA1.conversationId);

    // worktree 전환 실패 시 기존 경로(C:\repos\a) 유지 및 needs_attention 표시
    backendA.failWorktreeResumeFor = 'C:\\repos\\a-wt';
    await assert.rejects(manager.switchWorktree(snapA.project.projectId, { workerId: added1.workerId }, 'C:\\repos\\a-wt'), /거부/);
    const failedAdded = manager.getProjectSnapshot(snapA.project.projectId).workers.find(w => w.workerId === added1.workerId)!;
    assert.equal(failedAdded.cwd, 'C:\\repos\\a');
    assert.equal(failedAdded.status, 'needs_attention');
    backendA.failWorktreeResumeFor = undefined;

    // 7. 창 닫기/백엔드 재시작 시 살아 있는 프로세스 대조·재연결 및 중지 워커 동일 ID 재개
    // added1은 위 실패에서 중지된 상태, workerA1과 workerB1은 살아 있는 상태
    await manager.detachAll();
    const reopened = makeManager();
    try {
      const recA = await reopened.reconcileProject(snapA.project.projectId);
      const recA1 = recA.workers.find(w => w.workerId === workerA1.workerId)!;
      const recAdded = recA.workers.find(w => w.workerId === added1.workerId)!;
      assert.equal(recA1.status, 'ready');
      assert.equal(recA1.conversationId, workerA1.conversationId);
      assert.equal(recAdded.status, 'stopped');

      // startProject 시 살아 있는 workerA1은 재실행하지 않고, Codex는 저장된 threadId로 재개한다.
      const beforeLaunchCount = hcomClients.get(snapA.project.projectId)!.launchCount.launch;
      const restartedA = await reopened.startProject(snapA.project.projectId);
      assert.equal(hcomClients.get(snapA.project.projectId)!.launchCount.launch, beforeLaunchCount);
      assert.equal(restartedA.codex.threadId, startedA1.codex.threadId);
      assert.equal(codexFactory.connections.at(-1)?.resumed, startedA1.codex.threadId);

      // 중지된 추가 워커는 저장된 ID로 재개된다.
      const resumedAgain = await reopened.startWorker(snapA.project.projectId, added1.workerId);
      assert.equal(resumedAgain.conversationId, added1.conversationId);
    } finally {
      await reopened.shutdownAll();
    }
  } finally {
    await manager.detachAll().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('A·B 동시 요청 처리 중 교차 오염이 없고 활성 요청 중 worktree 전환을 거절한다', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hcom-gui-conc-test-'));
  const network = new FakeHcomNetwork();
  const codexFactory = new FakeCodexFactory();
  const manager = new ProjectManager({
    dataDir,
    codexCommand: 'fake-codex',
    git: makeFakeGit(),
    pollIntervalMs: 10,
    replyTimeoutMs: 5000,
    createCodex: codexFactory.create,
    createHcom: scope => new FakeHcomClient(scope, network.backendFor(scope)),
  });

  try {
    const snapA = manager.registerProject('C:\\repos\\a', { name: 'A' });
    const snapB = manager.registerProject('C:\\repos\\b', { name: 'B' });
    await Promise.all([manager.startProject(snapA.project.projectId), manager.startProject(snapB.project.projectId)]);

    // 진행 중 요청이 있으면 worktree 전환을 거절한다.
    manager.store.acceptRequest({ projectId: snapA.project.projectId, requestId: 'busy-1', prompt: 'working' });
    manager.store.updateRequest(snapA.project.projectId, 'busy-1', { status: 'worker_working' });
    await assert.rejects(manager.switchWorktree(snapA.project.projectId, 'codex', 'C:\\repos\\a-wt'), /진행 중인/);
    manager.store.updateRequest(snapA.project.projectId, 'busy-1', { status: 'completed' });

    // A·B에 동시에 위임 요청을 보내도 각각 자기 워커의 응답만 받는다.
    codexFactory.onDelegateTarget = (_prompt, workersJson) => {
      const list = JSON.parse(workersJson) as Array<{ workerId: string }>;
      return { workerId: list[0]!.workerId, task: 'parallel check' };
    };
    const [reqA, reqB] = await Promise.all([
      manager.submitRequest(snapA.project.projectId, 'par-a', 'check a'),
      manager.submitRequest(snapB.project.projectId, 'par-b', 'check b'),
    ]);
    assert.equal(reqA.status, 'completed');
    assert.equal(reqB.status, 'completed');
    assert.match(reqA.finalText ?? '', /C:\\repos\\a/);
    assert.match(reqB.finalText ?? '', /C:\\repos\\b/);
    assert.ok(!(reqA.finalText ?? '').includes('C:\\repos\\b'));
    assert.ok(!(reqB.finalText ?? '').includes('C:\\repos\\a'));
  } finally {
    await manager.shutdownAll().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('프로젝트 등록 폴더와 추가 worktree 경로를 워커 trustedWorkspaces로 전달하고 Codex sandbox 옵션을 넘긴다', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hcom-gui-trust-test-'));
  const network = new FakeHcomNetwork();
  const codexFactory = new FakeCodexFactory();
  const seenSandboxes: Array<string | undefined> = [];
  const manager = new ProjectManager({
    dataDir,
    codexCommand: 'fake-codex',
    git: makeFakeGit(),
    pollIntervalMs: 10,
    replyTimeoutMs: 5000,
    createCodex: async opts => {
      seenSandboxes.push(opts.sandbox);
      return codexFactory.create(opts);
    },
    createHcom: scope => new FakeHcomClient(scope, network.backendFor(scope)),
  });

  try {
    const snap = manager.registerProject('C:\\repos\\a', { name: 'A' });
    await manager.startProject(snap.project.projectId);
    assert.deepEqual(seenSandboxes, ['danger-full-access']);

    const settingsPath = join(snap.project.hcomDir, 'agy-settings.json');
    const initialSettings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { agentMode: string; trustedWorkspaces: string[] };
    assert.equal(initialSettings.agentMode, '');
    assert.deepEqual(initialSettings.trustedWorkspaces, ['C:\\repos\\a']);

    await manager.addWorker(snap.project.projectId, { name: 'WT 워커', requestKey: 'wt-trust-1', cwd: 'C:\\repos\\a-wt' });
    const updatedSettings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { trustedWorkspaces: string[] };
    assert.deepEqual(updatedSettings.trustedWorkspaces, ['C:\\repos\\a', 'C:\\repos\\a-wt']);
  } finally {
    await manager.shutdownAll().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
