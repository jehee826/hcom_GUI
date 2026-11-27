import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexSession, type CodexSandboxMode, type DynamicTool, type SessionOptions, type ToolOutput, type ToolResult, type TurnResult } from '../codex/index.ts';
import {
  HcomAdapter,
  isJammedTerminal,
  isWorkerReply,
  type ActiveParticipant,
  type HcomEvent,
  type Participant,
  type ProjectScope,
  type Receipt,
  type StoppedParticipant,
  type TerminalState,
  type WorkerBinding,
  type WorkerLaunch,
  type WorkerLaunchOptions,
} from '../hcom/index.ts';
import { defaultGitInspector, normalizePathKey, validateRelativeDocPath, type GitInspector } from '../projects/git.ts';
import {
  ProjectStore,
  type CodexSessionRecord,
  type DelegationRecord,
  type HandoffRecord,
  type ProjectEventRecord,
  type ProjectRecord,
  type RequestRecord,
  type WorkerRecord,
  type WorkerSessionStatus,
} from '../store/index.ts';
import { KeyedLock } from './locks.ts';

export interface CodexClient {
  startThread(): Promise<string>;
  resumeThread(threadId: string): Promise<string>;
  runTurn(input: { text: string } | { toolOutput: ToolOutput }): Promise<TurnResult>;
  close(): Promise<void>;
}

export interface HcomClient {
  readonly scope: Readonly<ProjectScope>;
  initialize(): Promise<void>;
  startCodex(threadId: string): Promise<Participant>;
  stopCodex(participant: Participant): Promise<void>;
  launchWorker(options?: WorkerLaunchOptions): Promise<WorkerLaunch>;
  resumeWorker(worker: WorkerBinding, options?: WorkerLaunchOptions): Promise<WorkerLaunch>;
  probeWorker(name: string, expectedCwd?: string): Promise<WorkerBinding>;
  verifyResumedWorker(worker: WorkerBinding, expectedCwd?: string): Promise<WorkerBinding>;
  stopWorker(worker: WorkerBinding): Promise<void>;
  stopWorkerByName(name: string, expectedSessionId?: string, expectedCwd?: string | null): Promise<void>;
  stopLaunch(launch: WorkerLaunch, expectedSessionId?: string, expectedCwd?: string): Promise<void>;
  listParticipants(): Promise<ActiveParticipant[]>;
  getStoppedWorker(name: string): Promise<StoppedParticipant | undefined>;
  settleWorker(name: string, timeoutMs?: number): Promise<boolean>;
  clearBannerOverlay(name: string): Promise<boolean>;
  readTerminal(name: string): Promise<TerminalState>;
  clearJammedInput(name: string, requestId: number): Promise<boolean>;
  send(sender: Participant, target: Participant, text: string): Promise<Receipt>;
  follow(afterId: number, onEvent: (event: HcomEvent) => void, onError: (error: Error) => void): () => Promise<void>;
}

export interface ProjectManagerOptions {
  readonly dataDir: string;
  readonly store?: ProjectStore;
  readonly codexCommand: string;
  readonly model?: string;
  readonly codexSandbox?: CodexSandboxMode;
  readonly env?: NodeJS.ProcessEnv;
  readonly workerSettings?: Record<string, unknown>;
  readonly replyTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly git?: GitInspector;
  readonly createCodex?: (options: SessionOptions) => Promise<CodexClient>;
  readonly createHcom?: (scope: ProjectScope) => HcomClient;
}

export interface ProjectSnapshot {
  readonly project: ProjectRecord;
  readonly codex: CodexSessionRecord;
  readonly workers: WorkerRecord[];
  readonly handoff: HandoffRecord;
  readonly selected: boolean;
}

export interface AddWorkerInput {
  readonly name: string;
  readonly requestKey: string;
  readonly cwd?: string;
  readonly start?: boolean;
}

export interface HandoffUpdateInput {
  readonly goal?: string;
  readonly designDocs?: string[];
  readonly testCommand?: string | null;
  readonly testResult?: string;
  readonly nextSteps?: string;
}

interface PendingDelegation {
  readonly delegation: DelegationRecord;
  readonly worker: WorkerRecord;
  readonly target: Participant;
  readonly receipt: Receipt;
  readonly toolName: string;
}

interface ProjectRuntime {
  readonly projectId: string;
  readonly hcom: HcomClient;
  readonly settingsPath: string;
  codex?: CodexClient;
  codexCwd?: string;
  codexParticipant?: Participant;
  readonly launches: Map<string, WorkerLaunch>;
  readonly bindings: Map<string, WorkerBinding>;
  readonly events: HcomEvent[];
  eventError?: Error;
  stopFollow?: () => Promise<void>;
  activeRequest?: { requestId: string; delegation?: PendingDelegation };
  reconciled: boolean;
}

const delegateTools: DynamicTool[] = [
  {
    type: 'function',
    name: 'list_workers',
    description: '현재 프로젝트의 hcom_gui 관리 워커(Antigravity/agy) 목록과 상태를 조회한다. 셸에서 agy나 hcom list를 직접 실행하지 말고 반드시 이 도구로 워커를 확인한다.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'delegate_work',
    description: '현재 프로젝트의 hcom_gui 관리 워커(Antigravity/agy) 한 명에게 hcom으로 작업을 위임한다. 워커 협업 시 셸에서 agy/hcom을 직접 호출하지 말고 반드시 이 도구를 사용한다.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: '위임할 현재 프로젝트 소속 워커 ID' },
        task: { type: 'string', description: '워커에게 전달할 작업 지시' },
      },
      required: ['workerId', 'task'],
      additionalProperties: false,
    },
  },
];

function mapHcomWorkerStatus(status: string): WorkerSessionStatus {
  if (status === 'blocked') return 'needs_attention';
  if (status === 'active') return 'working';
  if (status === 'stopped') return 'stopped';
  return 'ready';
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export class ProjectManager {
  readonly dataDir: string;
  readonly store: ProjectStore;
  private readonly ownsStore: boolean;
  private storeClosed = false;
  private readonly options: ProjectManagerOptions;
  private readonly git: GitInspector;
  private readonly createCodex: (options: SessionOptions) => Promise<CodexClient>;
  private readonly createHcom: (scope: ProjectScope) => HcomClient;
  private readonly locks = new KeyedLock();
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private readonly eventSubscribers = new Set<(event: ProjectEventRecord) => void>();

  constructor(options: ProjectManagerOptions) {
    this.dataDir = options.dataDir;
    this.ownsStore = !options.store;
    this.store = options.store ?? new ProjectStore(join(options.dataDir, 'state.sqlite'));
    this.options = options;
    this.git = options.git ?? defaultGitInspector;
    this.createCodex = options.createCodex ?? (sessionOptions => CodexSession.connect(sessionOptions));
    this.createHcom = options.createHcom ?? (scope => new HcomAdapter(scope));
  }

  registerProject(folderPath: string, options?: { name?: string; defaultWorkerName?: string }): ProjectSnapshot {
    const info = this.git.resolveProject(folderPath);
    const snapshot = this.git.readSnapshot(info.rootPath);
    const existing = this.store.findProjectByCommonDir(info.gitCommonDirKey);
    if (existing) {
      throw new Error(`이미 같은 Git 저장소가 등록되어 있습니다 (${existing.name}, projectId=${existing.projectId}).`);
    }
    const projectId = randomUUID();
    const hcomDir = ProjectStore.projectHcomDir(this.dataDir, projectId);
    const created = this.store.registerProject({
      projectId,
      name: options?.name?.trim() || info.defaultName,
      rootPath: info.rootPath,
      gitCommonDir: info.gitCommonDir,
      gitCommonDirKey: info.gitCommonDirKey,
      hcomDir,
      branchStatus: snapshot.branchStatus,
      commitStatus: snapshot.commitStatus,
      defaultWorkerName: options?.defaultWorkerName,
    });
    if (!this.store.getSelectedProjectId()) this.store.selectProject(created.project.projectId);
    this.emitEvent(created.project.projectId, 'project.registered', { rootPath: info.rootPath });
    return this.getProjectSnapshot(created.project.projectId);
  }

  listProjects(): ProjectSnapshot[] {
    const selectedId = this.store.getSelectedProjectId();
    return this.store.listProjects().map(project => ({
      project,
      codex: this.store.getCodexSession(project.projectId)!,
      workers: this.store.listWorkers(project.projectId),
      handoff: this.store.getHandoff(project.projectId)!,
      selected: project.projectId === selectedId,
    }));
  }

  getSelectedProjectId(): string | null {
    return this.store.getSelectedProjectId();
  }

  selectProject(projectId: string): ProjectSnapshot {
    this.store.selectProject(projectId);
    return this.getProjectSnapshot(projectId);
  }

  getProjectSnapshot(projectId: string): ProjectSnapshot {
    const project = this.requireProject(projectId);
    return {
      project,
      codex: this.store.getCodexSession(projectId)!,
      workers: this.store.listWorkers(projectId),
      handoff: this.store.getHandoff(projectId)!,
      selected: this.store.getSelectedProjectId() === projectId,
    };
  }

  getHandoff(projectId: string): HandoffRecord {
    this.requireProject(projectId);
    return this.store.getHandoff(projectId)!;
  }

  updateHandoff(projectId: string, patch: HandoffUpdateInput): HandoffRecord {
    const project = this.requireProject(projectId);
    const designDocs = patch.designDocs?.map(doc => validateRelativeDocPath(project.rootPath, doc));
    const updated = this.store.updateHandoff(projectId, {
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(designDocs !== undefined ? { designDocs } : {}),
      ...(patch.testCommand !== undefined ? { testCommand: patch.testCommand } : {}),
      ...(patch.testResult !== undefined ? { testResult: patch.testResult } : {}),
      ...(patch.nextSteps !== undefined ? { nextSteps: patch.nextSteps } : {}),
    });
    this.emitEvent(projectId, 'handoff.updated', { updatedAt: updated.updatedAt });
    return updated;
  }

  refreshHandoffGitState(projectId: string, cwd?: string): HandoffRecord {
    const project = this.requireProject(projectId);
    const targetCwd = cwd ?? this.store.getCodexSession(projectId)?.cwd ?? project.rootPath;
    const snap = this.git.readSnapshot(targetCwd);
    return this.store.updateHandoff(projectId, {
      branchStatus: snap.branchStatus,
      commitStatus: snap.commitStatus,
    });
  }

  subscribeEvents(listener: (event: ProjectEventRecord) => void): () => void {
    this.eventSubscribers.add(listener);
    return () => { this.eventSubscribers.delete(listener); };
  }

  private emitEvent(projectId: string, kind: string, payload: Record<string, unknown>): ProjectEventRecord {
    const saved = this.store.appendEvent(projectId, kind, payload);
    for (const listener of this.eventSubscribers) {
      try { listener(saved); } catch {}
    }
    return saved;
  }

  listRequests(projectId: string): RequestRecord[] {
    this.requireProject(projectId);
    return this.store.listRequests(projectId);
  }

  getRequest(projectId: string, requestId: string): RequestRecord | undefined {
    this.requireProject(projectId);
    return this.store.getRequest(projectId, requestId);
  }

  listDelegations(projectId: string, requestId?: string): DelegationRecord[] {
    this.requireProject(projectId);
    return this.store.listDelegations(projectId, requestId);
  }

  listProjectEvents(projectId: string, afterSeq = 0): ProjectEventRecord[] {
    this.requireProject(projectId);
    return this.store.listEvents(projectId, afterSeq);
  }

  async listProjectWorkers(projectId: string): Promise<WorkerRecord[]> {
    this.requireProject(projectId);
    const runtime = this.runtimes.get(projectId);
    if (runtime) await this.syncStatusesFromHcom(projectId, runtime);
    return this.store.listWorkers(projectId);
  }

  async listProjectHcomParticipants(projectId: string): Promise<ActiveParticipant[]> {
    const runtime = await this.ensureRuntime(projectId);
    return runtime.hcom.listParticipants();
  }

  async startProject(projectId: string): Promise<ProjectSnapshot> {
    this.requireProject(projectId);
    const defaultWorker = this.store.getDefaultWorker(projectId);
    if (!defaultWorker) throw new Error(`기본 워커가 등록되어 있지 않습니다: ${projectId}`);
    await this.ensureRuntime(projectId);
    await this.ensureCodexSession(projectId);
    await this.startWorker(projectId, defaultWorker.workerId);
    return this.getProjectSnapshot(projectId);
  }

  async reconcileProject(projectId: string): Promise<ProjectSnapshot> {
    const runtime = await this.ensureRuntime(projectId, false);
    await this.reconcileRuntime(projectId, runtime);
    return this.getProjectSnapshot(projectId);
  }

  async addWorker(projectId: string, input: AddWorkerInput): Promise<WorkerRecord> {
    const project = this.requireProject(projectId);
    const targetCwd = input.cwd ? this.assertSameProjectWorktree(project, input.cwd) : project.rootPath;
    return this.locks.run(`add-worker:${projectId}:${input.requestKey}`, async () => {
      const { worker, created } = this.store.createAdditionalWorker({
        projectId,
        name: input.name,
        requestKey: input.requestKey,
        cwd: targetCwd,
      });
      if (created) {
        this.emitEvent(projectId, 'worker.added', { workerId: worker.workerId, name: worker.name, cwd: worker.cwd });
      }
      if (input.start !== false) {
        return this.startWorker(projectId, worker.workerId);
      }
      return worker;
    });
  }

  async startWorker(projectId: string, workerId: string): Promise<WorkerRecord> {
    this.requireProject(projectId);
    this.assertWorkerBelongsToProject(projectId, workerId);
    return this.locks.run(`worker:${projectId}:${workerId}`, async () => {
      const runtime = await this.ensureRuntime(projectId);
      let worker = this.assertWorkerBelongsToProject(projectId, workerId);

      // 이미 살아 있는 프로세스인지 hcom 목록과 대조한다.
      if (worker.hcomName) {
        const active = (await runtime.hcom.listParticipants()).find(item => item.name === worker.hcomName);
        if (active) {
          if (active.processBound && normalizePathKey(active.directory) === normalizePathKey(worker.cwd)
            && (!worker.conversationId || !active.sessionId || active.sessionId === worker.conversationId)) {
            if (active.hooksBound && active.sessionId) {
              this.assertConversationUnowned(projectId, workerId, active.sessionId);
              const binding: WorkerBinding = {
                projectId,
                name: active.name,
                sessionId: active.sessionId,
                status: active.status,
                tool: active.tool,
                directory: active.directory,
                hooksBound: true,
                processBound: true,
                evidence: 'hcom-managed-binding',
              };
              runtime.bindings.set(workerId, binding);
              return this.store.updateWorker(projectId, workerId, {
                conversationId: active.sessionId,
                status: mapHcomWorkerStatus(active.status),
                lastError: null,
              });
            }
            return this.store.updateWorker(projectId, workerId, {
              status: mapHcomWorkerStatus(active.status),
              lastError: null,
            });
          }
          const reason = '워커 프로세스의 세션 ID 또는 작업 경로가 저장된 기록과 일치하지 않습니다.';
          this.store.updateWorker(projectId, workerId, { status: 'needs_attention', lastError: reason });
          throw new Error(reason);
        }
      }

      worker = this.store.updateWorker(projectId, workerId, { status: 'starting', lastError: null });
      let launch: WorkerLaunch | undefined;
      try {
        await this.writeWorkerSettingsFile(projectId, runtime.settingsPath, [worker.cwd]);
        if (worker.conversationId && worker.hcomName) {
          this.assertConversationUnowned(projectId, workerId, worker.conversationId);
          const stopped = await runtime.hcom.getStoppedWorker(worker.hcomName);
          if (!stopped || stopped.sessionId !== worker.conversationId) {
            throw new Error(`중지된 워커의 저장된 대화 ID를 확인할 수 없습니다 (${worker.hcomName}).`);
          }
          const binding: WorkerBinding = {
            projectId,
            name: worker.hcomName,
            sessionId: worker.conversationId,
            status: 'stopped',
            tool: stopped.tool,
            directory: stopped.directory,
            hooksBound: true,
            processBound: true,
            evidence: 'hcom-managed-binding',
          };
          launch = await runtime.hcom.resumeWorker(binding, { settingsPath: runtime.settingsPath, cwd: worker.cwd });
        } else {
          launch = await runtime.hcom.launchWorker({ settingsPath: runtime.settingsPath, cwd: worker.cwd });
        }
        runtime.launches.set(workerId, launch);
        await this.prepareWorkerLaunch(runtime.hcom, launch);
      } catch (error) {
        if (launch) {
          await runtime.hcom.stopLaunch(launch, worker.conversationId ?? undefined, worker.cwd).catch(() => {});
          runtime.launches.delete(workerId);
        }
        const message = error instanceof Error ? error.message : String(error);
        const status: WorkerSessionStatus = /로컬 확인/.test(message) ? 'needs_attention' : 'error';
        this.store.updateWorker(projectId, workerId, { status, lastError: message });
        throw error;
      }

      const active = (await runtime.hcom.listParticipants()).find(item => item.name === launch.name);
      let conversationId = worker.conversationId;
      if (active?.hooksBound && active.sessionId) {
        if (worker.conversationId && active.sessionId !== worker.conversationId) {
          const reason = '재개된 워커의 대화 ID가 저장된 ID와 다릅니다.';
          this.store.updateWorker(projectId, workerId, { status: 'needs_attention', lastError: reason });
          throw new Error(reason);
        }
        this.assertConversationUnowned(projectId, workerId, active.sessionId);
        conversationId = active.sessionId;
        runtime.bindings.set(workerId, {
          projectId,
          name: active.name,
          sessionId: active.sessionId,
          status: active.status,
          tool: active.tool,
          directory: active.directory,
          hooksBound: true,
          processBound: true,
          evidence: 'hcom-managed-binding',
        });
      }
      const updated = this.store.updateWorker(projectId, workerId, {
        hcomName: launch.name,
        conversationId,
        status: 'ready',
        lastError: null,
      });
      this.emitEvent(projectId, 'worker.started', { workerId, hcomName: launch.name, conversationId });
      return updated;
    });
  }

  async stopWorker(projectId: string, workerId: string): Promise<WorkerRecord> {
    this.requireProject(projectId);
    this.assertWorkerBelongsToProject(projectId, workerId);
    return this.locks.run(`worker:${projectId}:${workerId}`, async () => {
      const runtime = await this.ensureRuntime(projectId);
      const worker = this.assertWorkerBelongsToProject(projectId, workerId);
      const binding = runtime.bindings.get(workerId);
      const launch = runtime.launches.get(workerId);

      if (binding) {
        await runtime.hcom.stopWorker(binding);
      } else if (worker.hcomName && worker.conversationId) {
        const current = await runtime.hcom.probeWorker(worker.hcomName, worker.cwd).catch(() => undefined);
        if (current) await runtime.hcom.stopWorker(current);
        else await runtime.hcom.stopWorkerByName(worker.hcomName, worker.conversationId, null);
      } else if (launch) {
        await runtime.hcom.stopLaunch(launch, worker.conversationId ?? undefined, worker.cwd);
      } else if (worker.hcomName) {
        await runtime.hcom.stopWorkerByName(worker.hcomName, worker.conversationId ?? undefined, null);
      }

      runtime.bindings.delete(workerId);
      runtime.launches.delete(workerId);
      const updated = this.store.updateWorker(projectId, workerId, { status: 'stopped', lastError: null });
      this.emitEvent(projectId, 'worker.stopped', { workerId, hcomName: worker.hcomName, conversationId: worker.conversationId });
      return updated;
    });
  }

  async bindWorkerConversation(projectId: string, workerId: string, conversationId: string): Promise<WorkerRecord> {
    this.requireProject(projectId);
    this.assertWorkerBelongsToProject(projectId, workerId);
    this.assertConversationUnowned(projectId, workerId, conversationId);
    return this.store.updateWorker(projectId, workerId, { conversationId });
  }

  async switchWorktree(projectId: string, target: 'codex' | { workerId: string }, worktreePath: string): Promise<ProjectSnapshot> {
    const project = this.requireProject(projectId);
    const nextCwd = this.assertSameProjectWorktree(project, worktreePath);

    if (target === 'codex') {
      await this.locks.run(`codex:${projectId}`, async () => {
        if (this.store.hasActiveRequest(projectId) || this.store.hasActiveDelegation(projectId)) {
          throw new Error('진행 중인 Codex 턴 또는 위임 작업이 끝난 뒤 작업 경로를 변경할 수 있습니다.');
        }
        const runtime = await this.ensureRuntime(projectId);
        const current = this.store.getCodexSession(projectId)!;
        const prevCwd = current.cwd;
        const wasConnected = Boolean(runtime.codex);
        if (!wasConnected) {
          this.store.updateCodexSession(projectId, { cwd: nextCwd, lastError: null });
          this.refreshHandoffGitState(projectId, nextCwd);
          return;
        }
        try {
          await runtime.codex!.close();
          runtime.codex = undefined;
          runtime.codexCwd = undefined;
          const nextCodex = await this.connectCodexForCwd(project, runtime, nextCwd);
          if (current.threadId) {
            await nextCodex.resumeThread(current.threadId);
          } else {
            const threadId = await nextCodex.startThread();
            this.store.updateCodexSession(projectId, { threadId });
          }
          runtime.codex = nextCodex;
          runtime.codexCwd = nextCwd;
          this.store.updateCodexSession(projectId, { cwd: nextCwd, status: 'ready', lastError: null });
          this.refreshHandoffGitState(projectId, nextCwd);
          this.emitEvent(projectId, 'codex.worktree_switched', { cwd: nextCwd, threadId: current.threadId });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.store.updateCodexSession(projectId, { cwd: prevCwd, status: 'needs_attention', lastError: `worktree 전환 실패: ${message}` });
          throw error;
        }
      });
      return this.getProjectSnapshot(projectId);
    }

    const { workerId } = target;
    this.assertWorkerBelongsToProject(projectId, workerId);
    await this.locks.run(`worker:${projectId}:${workerId}`, async () => {
      if (this.store.hasActiveDelegation(projectId, workerId)) {
        throw new Error('진행 중인 위임 작업이 끝난 뒤 워커 작업 경로를 변경할 수 있습니다.');
      }
      const runtime = await this.ensureRuntime(projectId);
      const worker = this.assertWorkerBelongsToProject(projectId, workerId);
      const prevCwd = worker.cwd;
      if (!worker.hcomName || !worker.conversationId) {
        if (runtime.launches.has(workerId)) {
          throw new Error('워커의 초기 대화가 바인딩된 뒤 작업 경로를 변경할 수 있습니다.');
        }
        this.store.updateWorker(projectId, workerId, { cwd: nextCwd, lastError: null });
        this.emitEvent(projectId, 'worker.worktree_switched', { workerId, cwd: nextCwd, conversationId: null });
        return;
      }

      const active = (await runtime.hcom.listParticipants()).find(item => item.name === worker.hcomName);
      if (active) {
        const binding = runtime.bindings.get(workerId) ?? await runtime.hcom.probeWorker(worker.hcomName, prevCwd);
        await runtime.hcom.stopWorker(binding);
        runtime.bindings.delete(workerId);
        runtime.launches.delete(workerId);
      }

      const stopped = await runtime.hcom.getStoppedWorker(worker.hcomName);
      if (!stopped || stopped.sessionId !== worker.conversationId) {
        const reason = 'worktree 전환을 위한 중지된 워커 세션을 확인할 수 없습니다.';
        this.store.updateWorker(projectId, workerId, { cwd: prevCwd, status: 'needs_attention', lastError: reason });
        throw new Error(reason);
      }

      const binding: WorkerBinding = {
        projectId,
        name: worker.hcomName,
        sessionId: worker.conversationId,
        status: 'stopped',
        tool: stopped.tool,
        directory: stopped.directory,
        hooksBound: true,
        processBound: true,
        evidence: 'hcom-managed-binding',
      };
      await this.writeWorkerSettingsFile(projectId, runtime.settingsPath, [nextCwd]);

      let launch: WorkerLaunch | undefined;
      try {
        launch = await runtime.hcom.resumeWorker(binding, { settingsPath: runtime.settingsPath, cwd: nextCwd });
        runtime.launches.set(workerId, launch);
        await this.prepareWorkerLaunch(runtime.hcom, launch);
        const verified = await runtime.hcom.verifyResumedWorker(binding, nextCwd);
        runtime.bindings.set(workerId, verified);
        this.store.updateWorker(projectId, workerId, { cwd: nextCwd, status: 'ready', lastError: null });
        this.emitEvent(projectId, 'worker.worktree_switched', { workerId, cwd: nextCwd, conversationId: worker.conversationId });
      } catch (error) {
        if (launch) {
          await runtime.hcom.stopWorkerByName(launch.name, worker.conversationId, null).catch(() => {});
          runtime.launches.delete(workerId);
        }
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateWorker(projectId, workerId, { cwd: prevCwd, status: 'needs_attention', lastError: `worktree 전환 실패: ${message}` });
        throw error;
      }
    });
    return this.getProjectSnapshot(projectId);
  }

  async sendTaskToWorker(projectId: string, workerId: string, task: string): Promise<{ receipt: Receipt; reply: HcomEvent; binding: WorkerBinding }> {
    this.requireProject(projectId);
    const worker = this.assertWorkerBelongsToProject(projectId, workerId);
    const runtime = await this.ensureRuntime(projectId);
    const sender = await this.ensureCodexParticipant(projectId, runtime);
    const readyWorker = worker.hcomName ? worker : await this.startWorker(projectId, workerId);
    if (!readyWorker.hcomName) throw new Error('워커의 hcom 참가자 이름이 없습니다.');
    const target: Participant = {
      projectId,
      name: readyWorker.hcomName,
      sessionId: readyWorker.conversationId ?? '',
      tool: 'agy',
      status: readyWorker.status,
    };
    this.store.updateWorker(projectId, workerId, { status: 'working', lastError: null });
    const receipt = await runtime.hcom.send(sender, target, task);
    try {
      const reply = await this.waitForWorkerReply(projectId, runtime, sender, target, receipt.eventId);
      const binding = await this.bindAfterReply(projectId, workerId, readyWorker, runtime);
      this.store.updateWorker(projectId, workerId, { status: 'ready', lastError: null });
      return { receipt, reply, binding };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateWorker(projectId, workerId, {
        status: /대기 상태/.test(message) ? 'needs_attention' : 'error',
        lastError: message,
      });
      throw error;
    }
  }

  async submitRequest(projectId: string, requestId: string, prompt: string): Promise<RequestRecord> {
    this.requireProject(projectId);
    const accepted = this.store.acceptRequest({ projectId, requestId, prompt });
    if (!accepted.created) return accepted.request;
    this.emitEvent(projectId, 'request.accepted', { requestId, prompt });

    return this.locks.run(`request:${projectId}`, async () => {
      const runtime = await this.ensureRuntime(projectId);
      const codex = await this.ensureCodexSession(projectId);
      this.store.updateRequest(projectId, requestId, { status: 'codex_running' });
      this.store.updateCodexSession(projectId, { status: 'running', lastError: null });
      this.emitEvent(projectId, 'request.codex_running', { requestId });
      runtime.activeRequest = { requestId };

      try {
        const firstTurn = await codex.runTurn({ text: prompt });
        const pending = runtime.activeRequest.delegation;

        if (!pending) {
          const finalStatus = firstTurn.status === 'completed'
            ? 'completed'
            : firstTurn.status === 'needs_final_answer'
              ? 'needs_verification'
              : firstTurn.status;
          const record = this.store.updateRequest(projectId, requestId, {
            status: finalStatus,
            codexTurnId: firstTurn.turnId,
            finalText: firstTurn.finalText ?? null,
            error: firstTurn.reason ?? null,
          });
          this.store.updateCodexSession(projectId, { status: 'ready' });
          this.emitEvent(projectId, 'request.finished', { requestId, status: record.status, finalText: record.finalText });
          return record;
        }

        if (firstTurn.status !== 'completed') {
          const record = this.store.updateRequest(projectId, requestId, {
            status: firstTurn.status === 'needs_final_answer' ? 'needs_verification' : firstTurn.status,
            codexTurnId: firstTurn.turnId,
            error: firstTurn.reason ?? '위임 턴이 완료되지 않았습니다.',
          });
          this.store.updateCodexSession(projectId, { status: 'ready' });
          this.emitEvent(projectId, 'request.finished', { requestId, status: record.status, error: record.error });
          return record;
        }

        this.store.updateRequest(projectId, requestId, { status: 'worker_working', codexTurnId: firstTurn.turnId });
        this.emitEvent(projectId, 'request.worker_working', {
          requestId,
          workerId: pending.worker.workerId,
          workerName: pending.worker.name,
          requestEventId: pending.receipt.eventId,
        });

        const sender = runtime.codexParticipant!;
        const reply = await this.waitForWorkerReply(projectId, runtime, sender, pending.target, pending.receipt.eventId);
        const binding = await this.bindAfterReply(projectId, pending.worker.workerId, pending.worker, runtime);
        const replyText = String(reply.data.text).trim();

        this.store.updateDelegation(projectId, pending.delegation.delegationId, {
          replyEventId: reply.id,
          replyText,
          status: 'replied',
        });
        this.store.updateWorker(projectId, pending.worker.workerId, { status: 'ready', lastError: null });
        this.store.updateRequest(projectId, requestId, { status: 'codex_reviewing' });
        this.emitEvent(projectId, 'request.codex_reviewing', {
          requestId,
          workerId: pending.worker.workerId,
          workerName: pending.worker.name,
          replyEventId: reply.id,
          replyText,
          conversationId: binding.sessionId,
        });

        const reviewTurn = await codex.runTurn({
          toolOutput: {
            name: pending.toolName,
            output: `워커(${pending.worker.name})의 실제 회신:\n${replyText}`,
          },
        });
        const reviewStatus = reviewTurn.status === 'completed'
          ? 'completed'
          : reviewTurn.status === 'needs_final_answer'
            ? 'needs_verification'
            : reviewTurn.status;
        this.store.updateDelegation(projectId, pending.delegation.delegationId, {
          status: reviewStatus === 'completed' ? 'reviewed' : 'failed',
        });
        const finalRecord = this.store.updateRequest(projectId, requestId, {
          status: reviewStatus,
          reviewTurnId: reviewTurn.turnId,
          finalText: reviewTurn.finalText ?? null,
          error: reviewTurn.reason ?? null,
        });
        this.store.updateCodexSession(projectId, { status: 'ready' });
        if (reviewStatus === 'completed') {
          const gitSnap = this.git.readSnapshot(this.store.getCodexSession(projectId)!.cwd);
          this.store.updateHandoff(projectId, {
            branchStatus: gitSnap.branchStatus,
            commitStatus: gitSnap.commitStatus,
            lastWorkerReport: replyText,
            lastCodexReview: reviewTurn.finalText ?? null,
          });
          this.emitEvent(projectId, 'handoff.updated', { requestId });
        }
        this.emitEvent(projectId, 'request.finished', {
          requestId,
          status: finalRecord.status,
          finalText: finalRecord.finalText,
        });
        return finalRecord;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = /대기 상태/.test(message) ? 'needs_attention' : /확인/.test(message) ? 'needs_verification' : 'failed';
        this.store.updateRequest(projectId, requestId, { status, error: message });
        this.store.updateCodexSession(projectId, { status: status === 'needs_attention' ? 'needs_attention' : 'ready', lastError: message });
        this.emitEvent(projectId, 'request.failed', { requestId, status, error: message });
        throw error;
      } finally {
        runtime.activeRequest = undefined;
      }
    });
  }

  async detachProject(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return;
    this.runtimes.delete(projectId);
    const stopFollow = runtime.stopFollow;
    runtime.stopFollow = undefined;
    await Promise.allSettled([
      stopFollow ? stopFollow() : Promise.resolve(),
      runtime.codex ? runtime.codex.close() : Promise.resolve(),
    ]);
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map(projectId => this.detachProject(projectId)));
    if (this.ownsStore && !this.storeClosed) {
      this.storeClosed = true;
      this.store.close();
    }
  }

  async shutdownProject(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId) ?? (this.store.getProject(projectId) ? await this.ensureRuntime(projectId, true) : undefined);
    if (!runtime) return;
    const errors: unknown[] = [];
    const stopFollow = runtime.stopFollow;
    runtime.stopFollow = undefined;
    for (const settled of await Promise.allSettled([
      stopFollow ? stopFollow() : Promise.resolve(),
      runtime.codex ? runtime.codex.close() : Promise.resolve(),
    ])) {
      if (settled.status === 'rejected') errors.push(settled.reason);
    }
    runtime.codex = undefined;
    runtime.codexCwd = undefined;

    for (const worker of this.store.listWorkers(projectId)) {
      try {
        await this.stopWorker(projectId, worker.workerId);
      } catch (error) {
        errors.push(error);
      }
    }

    if (runtime.codexParticipant) {
      try {
        await runtime.hcom.stopCodex(runtime.codexParticipant);
      } catch (error) {
        errors.push(error);
      }
      runtime.codexParticipant = undefined;
    }

    this.store.updateCodexSession(projectId, { status: 'stopped', lastError: null });
    this.emitEvent(projectId, 'project.stopped', { projectId });
    this.runtimes.delete(projectId);
    if (errors.length) {
      throw new AggregateError(errors, `프로젝트 종료 정리 확인 필요 (${projectId})`);
    }
  }

  async shutdownAll(): Promise<void> {
    if (this.storeClosed) return;
    const errors: unknown[] = [];
    const ids = new Set<string>([...this.runtimes.keys(), ...this.store.listProjects().map(project => project.projectId)]);
    for (const projectId of ids) {
      const hasRuntime = this.runtimes.has(projectId);
      const hasKnownSessions = this.store.listWorkers(projectId).some(w => Boolean(w.hcomName))
        || Boolean(this.store.getCodexSession(projectId)?.hcomName);
      if (!hasRuntime && !hasKnownSessions) continue;
      try {
        await this.shutdownProject(projectId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.ownsStore && !this.storeClosed) {
      this.storeClosed = true;
      this.store.close();
    }
    if (errors.length) {
      throw new AggregateError(errors, '전체 프로젝트 종료 정리 확인 필요');
    }
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`등록되지 않은 프로젝트입니다: ${projectId}`);
    return project;
  }

  private assertWorkerBelongsToProject(projectId: string, workerId: string): WorkerRecord {
    const worker = this.store.getWorker(projectId, workerId);
    if (worker) return worker;
    const foreign = this.store.findWorkerByIdGlobal(workerId);
    if (foreign) throw new Error(`다른 프로젝트(${foreign.projectId}) 소속 워커에 접근할 수 없습니다.`);
    throw new Error(`워커를 찾을 수 없습니다: ${workerId}`);
  }

  private assertConversationUnowned(projectId: string, workerId: string, conversationId: string): void {
    const owner = this.store.findWorkerByConversationId(conversationId);
    if (owner && (owner.projectId !== projectId || owner.workerId !== workerId)) {
      throw new Error(`다른 프로젝트 또는 워커(${owner.projectId}/${owner.workerId})에 귀속된 대화 ID는 재사용할 수 없습니다.`);
    }
  }

  private assertSameProjectWorktree(project: ProjectRecord, worktreePath: string): string {
    const info = this.git.resolveProject(worktreePath);
    if (info.gitCommonDirKey !== project.gitCommonDirKey) {
      throw new Error(`다른 Git 저장소의 작업 경로는 이 프로젝트에 지정할 수 없습니다 (${worktreePath}).`);
    }
    return info.rootPath;
  }

  private async ensureRuntime(projectId: string, reconcile = true): Promise<ProjectRuntime> {
    const existing = this.runtimes.get(projectId);
    if (existing) {
      if (reconcile && !existing.reconciled) await this.reconcileRuntime(projectId, existing);
      return existing;
    }
    return this.locks.run(`runtime:${projectId}`, async () => {
      const cached = this.runtimes.get(projectId);
      if (cached) {
        if (reconcile && !cached.reconciled) await this.reconcileRuntime(projectId, cached);
        return cached;
      }
      const project = this.requireProject(projectId);
      await mkdir(project.hcomDir, { recursive: true });
      const settingsPath = join(project.hcomDir, 'agy-settings.json');
      await this.writeWorkerSettingsFile(projectId, settingsPath);

      const hcom = this.createHcom({ projectId, cwd: project.rootPath, hcomDir: project.hcomDir });
      await hcom.initialize();

      const runtime: ProjectRuntime = {
        projectId,
        hcom,
        settingsPath,
        launches: new Map(),
        bindings: new Map(),
        events: [],
        reconciled: false,
      };
      this.runtimes.set(projectId, runtime);
      this.startFollowLoop(projectId, runtime);
      if (reconcile) await this.reconcileRuntime(projectId, runtime);
      return runtime;
    });
  }

  private startFollowLoop(projectId: string, runtime: ProjectRuntime): void {
    const cursor = this.store.getCursor(projectId)?.lastEventId ?? 0;
    runtime.eventError = undefined;
    runtime.stopFollow = runtime.hcom.follow(
      cursor,
      event => {
        runtime.events.push(event);
        this.store.updateCursor(projectId, event.id);
        this.handleHcomEvent(projectId, event);
      },
      error => {
        runtime.eventError = error;
        if (/DB가 교체/.test(error.message)) {
          this.store.markDbReset(projectId);
          this.emitEvent(projectId, 'hcom.db_reset', { error: error.message });
        }
      },
    );
  }

  private handleHcomEvent(projectId: string, event: HcomEvent): void {
    if (event.type === 'message' && typeof event.data.from === 'string' && typeof event.data.text === 'string') {
      const senderKind = typeof event.data.sender_kind === 'string' ? event.data.sender_kind : '';
      if (senderKind === 'instance') {
        this.emitEvent(projectId, 'hcom.message', {
          eventId: event.id,
          from: event.data.from,
          intent: typeof event.data.intent === 'string' ? event.data.intent : null,
          replyTo: typeof event.data.reply_to === 'string' ? event.data.reply_to : null,
          deliveredTo: Array.isArray(event.data.delivered_to) ? event.data.delivered_to : [],
          text: event.data.text,
        });
      }
      return;
    }
    if (event.type !== 'status' || !event.instance) return;
    const worker = this.store.findWorkerByHcomName(projectId, event.instance);
    if (!worker) return;
    const rawStatus = typeof event.data.status === 'string' ? event.data.status : '';
    if (!rawStatus) return;
    const mapped = mapHcomWorkerStatus(rawStatus);
    const session = typeof event.data.session === 'string' && event.data.session ? event.data.session : undefined;
    if (session) {
      const owner = this.store.findWorkerByConversationId(session);
      if (owner && (owner.projectId !== projectId || owner.workerId !== worker.workerId)) {
        this.store.updateWorker(projectId, worker.workerId, {
          status: 'needs_attention',
          lastError: '다른 프로젝트에 귀속된 대화 ID 충돌이 감지되었습니다.',
        });
        this.emitEvent(projectId, 'worker.status', { workerId: worker.workerId, status: 'needs_attention' });
        return;
      }
    }
    const updated = this.store.updateWorker(projectId, worker.workerId, {
      status: mapped,
      ...(session && !worker.conversationId ? { conversationId: session } : {}),
      lastError: mapped === 'needs_attention' ? String(event.data.detail ?? event.data.context ?? 'blocked') : null,
    });
    if (updated.status !== worker.status || updated.conversationId !== worker.conversationId) {
      this.emitEvent(projectId, 'worker.status', {
        workerId: worker.workerId,
        status: updated.status,
        conversationId: updated.conversationId,
      });
    }
  }

  private async reconcileRuntime(projectId: string, runtime: ProjectRuntime): Promise<void> {
    const active = await runtime.hcom.listParticipants();
    const workers = this.store.listWorkers(projectId);
    for (const worker of workers) {
      if (!worker.hcomName) continue;
      const found = active.find(item => item.name === worker.hcomName);
      if (found) {
        const cwdMatches = normalizePathKey(found.directory) === normalizePathKey(worker.cwd);
        const idMatches = !worker.conversationId || !found.sessionId || found.sessionId === worker.conversationId;
        if (found.processBound && cwdMatches && idMatches) {
          if (found.hooksBound && found.sessionId) {
            this.assertConversationUnowned(projectId, worker.workerId, found.sessionId);
            runtime.bindings.set(worker.workerId, {
              projectId,
              name: found.name,
              sessionId: found.sessionId,
              status: found.status,
              tool: found.tool,
              directory: found.directory,
              hooksBound: true,
              processBound: true,
              evidence: 'hcom-managed-binding',
            });
          }
          this.store.updateWorker(projectId, worker.workerId, {
            conversationId: found.sessionId || worker.conversationId,
            status: mapHcomWorkerStatus(found.status),
            lastError: null,
          });
        } else {
          this.store.updateWorker(projectId, worker.workerId, {
            status: 'needs_attention',
            lastError: '재연결 중 워커 세션 또는 작업 경로 불일치가 감지되었습니다.',
          });
        }
      } else if (worker.conversationId) {
        const stopped = await runtime.hcom.getStoppedWorker(worker.hcomName);
        if (stopped && stopped.sessionId === worker.conversationId) {
          this.store.updateWorker(projectId, worker.workerId, { status: 'stopped', lastError: null });
        } else {
          this.store.updateWorker(projectId, worker.workerId, {
            status: 'disconnected',
            lastError: '저장된 워커 세션을 hcom에서 찾지 못했습니다.',
          });
        }
      } else {
        this.store.updateWorker(projectId, worker.workerId, { status: 'stopped', lastError: null });
      }
    }

    const codexRec = this.store.getCodexSession(projectId)!;
    if (codexRec.hcomName && codexRec.threadId) {
      const activeCodex = active.find(item => item.name === codexRec.hcomName && item.sessionId === codexRec.threadId && item.tool === 'adhoc');
      if (activeCodex) {
        runtime.codexParticipant = {
          projectId,
          name: activeCodex.name,
          sessionId: activeCodex.sessionId,
          tool: activeCodex.tool,
          status: activeCodex.status,
        };
      }
    }
    if (!runtime.codex && codexRec.status !== 'stopped') {
      this.store.updateCodexSession(projectId, { status: 'stopped' });
    }
    runtime.reconciled = true;
  }

  private async syncStatusesFromHcom(projectId: string, runtime: ProjectRuntime): Promise<void> {
    const active = await runtime.hcom.listParticipants().catch(() => undefined);
    if (!active) return;
    for (const worker of this.store.listWorkers(projectId)) {
      if (!worker.hcomName) continue;
      const found = active.find(item => item.name === worker.hcomName);
      if (found) {
        this.store.updateWorker(projectId, worker.workerId, { status: mapHcomWorkerStatus(found.status) });
      } else if (worker.status === 'ready' || worker.status === 'working') {
        this.store.updateWorker(projectId, worker.workerId, { status: 'stopped' });
      }
    }
  }

  private async ensureCodexSession(projectId: string): Promise<CodexClient> {
    return this.locks.run(`codex:${projectId}`, async () => {
      const project = this.requireProject(projectId);
      const runtime = await this.ensureRuntime(projectId);
      const codexRec = this.store.getCodexSession(projectId)!;
      if (runtime.codex) {
        await this.ensureCodexParticipant(projectId, runtime);
        return runtime.codex;
      }

      this.store.updateCodexSession(projectId, { status: 'starting', lastError: null });
      try {
        const client = await this.connectCodexForCwd(project, runtime, codexRec.cwd);
        let threadId: string;
        if (codexRec.threadId) {
          threadId = await client.resumeThread(codexRec.threadId);
        } else {
          threadId = await client.startThread();
        }
        const participant = await runtime.hcom.startCodex(threadId);
        runtime.codex = client;
        runtime.codexCwd = codexRec.cwd;
        runtime.codexParticipant = participant;
        this.store.updateCodexSession(projectId, {
          threadId,
          hcomName: participant.name,
          status: 'ready',
          lastError: null,
        });
        this.emitEvent(projectId, 'codex.started', { threadId, hcomName: participant.name, cwd: codexRec.cwd });
        return client;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateCodexSession(projectId, { status: 'error', lastError: message });
        throw error;
      }
    });
  }

  private async ensureCodexParticipant(projectId: string, runtime: ProjectRuntime): Promise<Participant> {
    if (runtime.codexParticipant) return runtime.codexParticipant;
    const codexRec = this.store.getCodexSession(projectId)!;
    if (!codexRec.threadId) {
      await this.ensureCodexSession(projectId);
      return runtime.codexParticipant!;
    }
    const participant = await runtime.hcom.startCodex(codexRec.threadId);
    runtime.codexParticipant = participant;
    this.store.updateCodexSession(projectId, { hcomName: participant.name });
    return participant;
  }

  private async writeWorkerSettingsFile(projectId: string, settingsPath: string, extraPaths: readonly string[] = []): Promise<void> {
    const project = this.requireProject(projectId);
    const base: Record<string, unknown> = { agentMode: '', ...(this.options.workerSettings ?? {}) };
    const rawTrusted = base.trustedWorkspaces;
    const existingTrusted = Array.isArray(rawTrusted)
      ? rawTrusted.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const seen = new Set<string>();
    const trustedWorkspaces: string[] = [];
    for (const candidate of [
      ...existingTrusted,
      project.rootPath,
      ...this.store.listWorkers(projectId).map(w => w.cwd),
      ...extraPaths,
    ]) {
      const key = normalizePathKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      trustedWorkspaces.push(candidate);
    }
    const payload = JSON.stringify({ ...base, trustedWorkspaces });
    await writeFile(settingsPath, payload, 'utf8');
  }

  private async connectCodexForCwd(project: ProjectRecord, runtime: ProjectRuntime, cwd: string): Promise<CodexClient> {
    return this.createCodex({
      command: this.options.codexCommand,
      cwd,
      model: this.options.model,
      sandbox: this.options.codexSandbox ?? 'danger-full-access',
      env: this.options.env ?? process.env,
      hcomDir: project.hcomDir,
      dynamicTools: delegateTools,
      onToolCall: params => this.handleCodexToolCall(project.projectId, runtime, params),
    });
  }

  private async handleCodexToolCall(projectId: string, runtime: ProjectRuntime, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = asNonEmptyString(params.tool);
    if (tool === 'list_workers') {
      await this.syncStatusesFromHcom(projectId, runtime);
      const workers = this.store.listWorkers(projectId).map(worker => ({
        workerId: worker.workerId,
        name: worker.name,
        isDefault: worker.isDefault,
        hcomName: worker.hcomName,
        status: worker.status,
        cwd: worker.cwd,
      }));
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(workers) }] };
    }

    if (tool === 'delegate_work') {
      const active = runtime.activeRequest;
      const callId = asNonEmptyString(params.callId);
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {};
      const workerId = asNonEmptyString(args.workerId);
      const task = asNonEmptyString(args.task);
      if (!active || !callId || !workerId || !task) {
        return { success: false, contentItems: [{ type: 'inputText', text: '유효하지 않은 위임 요청 인자입니다.' }] };
      }
      if (active.delegation) {
        return { success: false, contentItems: [{ type: 'inputText', text: 'MVP는 요청당 하나의 위임 작업만 허용합니다.' }] };
      }

      const worker = this.store.getWorker(projectId, workerId);
      if (!worker) {
        const foreign = this.store.findWorkerByIdGlobal(workerId);
        const reason = foreign
          ? `거절됨: 워커(${workerId})는 다른 프로젝트(${foreign.projectId}) 소속입니다.`
          : `거절됨: 현재 프로젝트에 워커(${workerId})가 없습니다.`;
        return { success: false, contentItems: [{ type: 'inputText', text: reason }] };
      }

      const readyWorker = worker.hcomName && (worker.status === 'ready' || worker.status === 'working')
        ? worker
        : await this.startWorker(projectId, worker.workerId);
      if (!readyWorker.hcomName) {
        return { success: false, contentItems: [{ type: 'inputText', text: '워커가 아직 hcom에 등록되지 않았습니다.' }] };
      }

      const sender = await this.ensureCodexParticipant(projectId, runtime);
      const target: Participant = {
        projectId,
        name: readyWorker.hcomName,
        sessionId: readyWorker.conversationId ?? '',
        tool: 'agy',
        status: readyWorker.status,
      };
      this.store.updateWorker(projectId, readyWorker.workerId, { status: 'working', lastError: null });
      const wireTask = /--intent\s+inform/i.test(task)
        ? task
        : `${task}\n\n[hcom 회신 규칙] 작업 완료 후 단순 접수(ack)가 아닌 최종 결과를 반드시 hcom send @${sender.name} --intent inform --reply-to <요청ID> 형식으로 회신하세요.`;
      const receipt = await runtime.hcom.send(sender, target, wireTask);
      const delegation = this.store.createDelegation({
        projectId,
        requestId: active.requestId,
        workerId: readyWorker.workerId,
        toolCallId: callId,
        requestEventId: receipt.eventId,
        prompt: task,
      });
      active.delegation = { delegation, worker: readyWorker, target, receipt, toolName: tool };
      return {
        success: true,
        contentItems: [{ type: 'inputText', text: `워커(${readyWorker.name}, event #${receipt.eventId})에게 작업을 전달했습니다. 실제 회신은 이후 도구 출력으로 제공됩니다.` }],
      };
    }

    return { success: false, contentItems: [{ type: 'inputText', text: `지원하지 않는 도구입니다: ${String(params.tool)}` }] };
  }

  private async prepareWorkerLaunch(hcom: HcomClient, launch: WorkerLaunch): Promise<void> {
    if (launch.readiness === 'needs_attention') {
      throw new Error(`워커 실행에 로컬 확인이 필요합니다 (${launch.name})`);
    }
    if (await hcom.settleWorker(launch.name)) return;
    if (launch.readiness === 'ready') return;
    const term = await hcom.readTerminal(launch.name).catch(() => undefined);
    if (term?.ready) return;
    throw new Error(`워커 입력 준비 시간 초과 (${launch.name})`);
  }

  private async bindAfterReply(projectId: string, workerId: string, worker: WorkerRecord, runtime: ProjectRuntime): Promise<WorkerBinding> {
    const hcomName = worker.hcomName!;
    const current = await runtime.hcom.probeWorker(hcomName, worker.cwd);
    if (worker.conversationId && current.sessionId !== worker.conversationId) {
      this.store.updateWorker(projectId, workerId, {
        status: 'needs_attention',
        lastError: '워커의 native 대화 ID가 저장된 ID와 달라졌습니다.',
      });
      throw new Error('워커의 native 대화 ID가 저장된 ID와 달라졌습니다.');
    }
    this.assertConversationUnowned(projectId, workerId, current.sessionId);
    runtime.bindings.set(workerId, current);
    this.store.updateWorker(projectId, workerId, { conversationId: current.sessionId, hcomName: current.name });
    return current;
  }

  private async waitForWorkerReply(
    projectId: string,
    runtime: ProjectRuntime,
    sender: Participant,
    target: Participant,
    requestEventId: number,
  ): Promise<HcomEvent> {
    const timeoutMs = this.options.replyTimeoutMs ?? 180_000;
    const pollMs = this.options.pollIntervalMs ?? 1000;
    const deadline = Date.now() + timeoutMs;
    let jammedSince: number | undefined;
    for (let tick = 0; Date.now() < deadline; tick++) {
      if (runtime.eventError) throw runtime.eventError;
      const found = runtime.events.find(event => isWorkerReply(event, projectId, sender, target, requestEventId));
      if (found) return found;
      const status = runtime.events.findLast(event => event.id > requestEventId && event.type === 'status' && event.instance === target.name);
      if (status?.data.status === 'blocked') {
        throw new Error(`워커가 대기 상태로 중단됐습니다 (${String(status.data.context ?? 'blocked')}): ${String(status.data.detail ?? '')}`);
      }
      const started = runtime.events.some(event => event.id > requestEventId && event.type === 'status' && event.instance === target.name && event.data.status === 'active');
      if (!started && tick % 2 === 1) {
        await runtime.hcom.clearBannerOverlay(target.name).catch(() => false);
        const term = await runtime.hcom.readTerminal(target.name).catch(() => undefined);
        if (term && isJammedTerminal(term, requestEventId)) {
          jammedSince ??= Date.now();
          if (Date.now() - jammedSince >= 4000) {
            await runtime.hcom.clearJammedInput(target.name, requestEventId).catch(() => false);
            jammedSince = undefined;
          }
        } else {
          jammedSince = undefined;
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new Error('워커 결과 회신 시간 초과');
  }
}
