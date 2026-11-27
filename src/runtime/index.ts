import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexSession, type CodexSandboxMode, type DynamicTool, type Progress, type SessionOptions, type ToolOutput, type ToolResult, type TurnResult } from '../codex/index.ts';
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
  type PendingApprovalRecord,
  type ProgressLogEntry,
  type ProjectEventRecord,
  type ProjectRecord,
  type RequestRecord,
  type StoredCodexSandboxMode,
  type WorkerPermissionMode,
  type WorkerRecord,
  type WorkerSessionStatus,
} from '../store/index.ts';
import { KeyedLock } from './locks.ts';

export interface CodexClient {
  startThread(): Promise<string>;
  resumeThread(threadId: string): Promise<string>;
  runTurn(input: { text: string } | { toolOutput: ToolOutput }): Promise<TurnResult>;
  setRuntimeConfig?(patch: { model?: string | null; effort?: string | null; sandbox?: CodexSandboxMode }): void;
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
  injectInput?(name: string, text: string): Promise<void>;
  readTranscript?(name: string, last?: number): Promise<unknown>;
  clearJammedInput(name: string, requestId: number): Promise<boolean>;
  send(sender: Participant, target: Participant, text: string): Promise<Receipt>;
  follow(afterId: number, onEvent: (event: HcomEvent) => void, onError: (error: Error) => void): () => Promise<void>;
}

export interface LiveProgressEvent {
  readonly projectId: string;
  readonly kind: 'request.progress' | 'worker.progress';
  readonly requestId?: string;
  readonly workerId?: string;
  readonly entry: ProgressLogEntry;
  readonly totalEntries: number;
}

export interface ProjectManagerOptions {
  readonly dataDir: string;
  readonly store?: ProjectStore;
  readonly codexCommand: string;
  readonly model?: string;
  readonly codexEffort?: string;
  readonly codexSandbox?: CodexSandboxMode;
  readonly env?: NodeJS.ProcessEnv;
  readonly workerSettings?: Record<string, unknown>;
  readonly replyTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly approvalDebounceMs?: number;
  readonly maxDelegationRounds?: number;
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
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly permissionMode?: WorkerPermissionMode;
  readonly start?: boolean;
}

export interface UpdateCodexSettingsInput {
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly sandboxMode?: StoredCodexSandboxMode;
}

export interface UpdateWorkerSettingsInput {
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly permissionMode?: WorkerPermissionMode;
  readonly applyNow?: boolean;
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

interface PendingUserQuestion {
  readonly question: string;
  readonly options: string[];
}

interface ActiveRequestState {
  readonly requestId: string;
  round: number;
  readonly abortController: AbortController;
  delegation?: PendingDelegation;
  pendingQuestion?: PendingUserQuestion;
}

class RequestCancelledError extends Error {
  constructor(message = '사용자 요청에 의해 작업이 취소되었습니다.') {
    super(message);
    this.name = 'RequestCancelledError';
  }
}

class WorkerTimeoutError extends Error {
  constructor(message = '워커 결과 회신 시간 초과') {
    super(message);
    this.name = 'WorkerTimeoutError';
  }
}

export function summarizeWorkerReplyForCodex(rawText: string, maxChars = 3200): string {
  const cleaned = rawText
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;

  const lines = cleaned.split('\n');
  const keyPattern = /(?:결과|변경\s*파일|수정|생성|삭제|테스트|검증|통과|실패|오류|에러|경고|result|summary|changed\s*files?|modified|test|pass|fail|error)/i;
  const highlighted = lines.filter(line => keyPattern.test(line));
  const headBudget = Math.floor(maxChars * 0.45);
  const tailBudget = Math.floor(maxChars * 0.25);
  const keyBlock = highlighted.join('\n').slice(0, Math.floor(maxChars * 0.4));
  const head = cleaned.slice(0, headBudget).trimEnd();
  const tail = cleaned.slice(-tailBudget).trimStart();
  const parts = keyBlock.length > 0 && !head.includes(keyBlock.slice(0, 60))
    ? [`[핵심 요약 추출]\n${keyBlock}`, `[앞부분]\n${head}`, `[뒷부분]\n${tail}`]
    : [head, tail];
  return `${parts.join('\n...\n')}\n\n[원문 일부 생략 · 전체 회신은 앱 위임 기록에 저장됨]`.slice(0, maxChars + 120);
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
  readonly eventWaiters: Set<() => void>;
  participantsCache?: { items: ActiveParticipant[]; cachedAt: number };
  eventError?: Error;
  stopFollow?: () => Promise<void>;
  activeRequest?: ActiveRequestState;
  reconciled: boolean;
}

const delegateTools: DynamicTool[] = [
  {
    type: 'function',
    name: 'list_workers',
    description: '현재 프로젝트의 hcom_gui 관리 워커(Antigravity/agy) 목록과 상태·모델·권한을 조회한다. 반환되는 모든 워커가 Antigravity(agy) 워커이며, 셸에서 agy나 hcom list를 직접 실행하지 말고 반드시 이 도구로 워커를 확인한다.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'delegate_work',
    description: '현재 프로젝트의 hcom_gui 관리 워커(Antigravity/agy) 한 명에게 hcom으로 작업을 위임하거나 검수 후 보완 재지시를 보낸다. 한 턴에는 한 워커에게 하나씩만 전달하며, 셸에서 agy/hcom을 직접 호출하지 말고 반드시 이 도구를 사용한다.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: '위임할 현재 프로젝트 소속 Antigravity(agy) 워커 ID' },
        task: { type: 'string', description: '워커에게 전달할 작업 또는 보완 재지시 내용' },
      },
      required: ['workerId', 'task'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'ask_user',
    description: '원격 저장소 유무 확인, 요구사항·설계 선택, 권한 판단 등 사용자 확인이 필요할 때 일반 텍스트로 턴을 끝내지 말고 반드시 이 도구를 호출해 질문을 표시하고 답변을 대기한다. 사용자가 답변하면 같은 요청에서 이어서 진행한다.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '사용자에게 확인할 구체적 질문' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '선택지가 있을 때 제시할 짧은 후보 목록(선택)',
        },
      },
      required: ['question'],
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
  private readonly liveSubscribers = new Set<(event: LiveProgressEvent) => void>();
  private readonly requestProgress = new Map<string, ProgressLogEntry[]>();
  private readonly workerProgress = new Map<string, ProgressLogEntry[]>();
  private readonly lastLiveEmitAt = new Map<string, number>();

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
    const existing = this.store.findProjectByCommonDir(info.gitCommonDirKey) ?? this.store.findProjectByRootPath(info.rootPath);
    if (existing) {
      throw new Error(`이미 같은 프로젝트 폴더가 등록되어 있습니다 (${existing.name}, projectId=${existing.projectId}).`);
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

  subscribeLive(listener: (event: LiveProgressEvent) => void): () => void {
    this.liveSubscribers.add(listener);
    return () => { this.liveSubscribers.delete(listener); };
  }

  private emitEvent(projectId: string, kind: string, payload: Record<string, unknown>): ProjectEventRecord {
    const saved = this.store.appendEvent(projectId, kind, payload);
    for (const listener of this.eventSubscribers) {
      try { listener(saved); } catch {}
    }
    return saved;
  }

  private pushRequestProgress(projectId: string, requestId: string, entry: ProgressLogEntry, mergeSameKind = false): void {
    const key = `${projectId}:${requestId}`;
    let list = this.requestProgress.get(key);
    if (!list) {
      list = [];
      this.requestProgress.set(key, list);
    }
    const last = list.at(-1);
    if (mergeSameKind && last && last.source === entry.source && last.kind === entry.kind) {
      const mergedDetail = `${last.detail ?? last.summary}${entry.detail ?? entry.summary}`.slice(-6000);
      const firstLine = mergedDetail.split('\n').map(s => s.trim()).filter(Boolean).at(-1) ?? entry.summary;
      list[list.length - 1] = {
        ...last,
        ts: entry.ts,
        summary: firstLine.slice(0, 140),
        detail: mergedDetail,
      };
    } else {
      list.push(entry);
      if (list.length > 200) list.splice(0, list.length - 200);
    }
    const now = Date.now();
    const throttleKey = `req:${key}`;
    const prevAt = this.lastLiveEmitAt.get(throttleKey) ?? 0;
    if (mergeSameKind && now - prevAt < 80) return;
    this.lastLiveEmitAt.set(throttleKey, now);
    const currentEntry = list.at(-1)!;
    const liveEvent: LiveProgressEvent = {
      projectId,
      kind: 'request.progress',
      requestId,
      entry: currentEntry,
      totalEntries: list.length,
    };
    for (const listener of this.liveSubscribers) {
      try { listener(liveEvent); } catch {}
    }
  }

  private pushWorkerProgress(projectId: string, workerId: string, entry: ProgressLogEntry): void {
    const key = `${projectId}:${workerId}`;
    let list = this.workerProgress.get(key);
    if (!list) {
      list = [];
      this.workerProgress.set(key, list);
    }
    const last = list.at(-1);
    if (last && last.kind === entry.kind && last.summary === entry.summary && last.detail === entry.detail) return;
    list.push(entry);
    if (list.length > 120) list.splice(0, list.length - 120);
    const liveEvent: LiveProgressEvent = {
      projectId,
      kind: 'worker.progress',
      workerId,
      entry,
      totalEntries: list.length,
    };
    for (const listener of this.liveSubscribers) {
      try { listener(liveEvent); } catch {}
    }
  }

  getRequestProgress(projectId: string, requestId: string): ProgressLogEntry[] {
    const mem = this.requestProgress.get(`${projectId}:${requestId}`);
    if (mem && mem.length > 0) return [...mem];
    return this.store.getRequest(projectId, requestId)?.progressSummary ?? [];
  }

  getAllRequestProgress(projectId: string): Record<string, ProgressLogEntry[]> {
    const out: Record<string, ProgressLogEntry[]> = {};
    for (const req of this.store.listRequests(projectId)) {
      const entries = this.getRequestProgress(projectId, req.requestId);
      if (entries.length > 0) out[req.requestId] = entries;
    }
    return out;
  }

  async getWorkerLogs(projectId: string, workerId: string, last = 8): Promise<{ progress: ProgressLogEntry[]; transcript: unknown }> {
    this.requireProject(projectId);
    const worker = this.assertWorkerBelongsToProject(projectId, workerId);
    const progress = [...(this.workerProgress.get(`${projectId}:${workerId}`) ?? [])];
    let transcript: unknown = [];
    if (worker.hcomName) {
      const runtime = this.runtimes.get(projectId) ?? await this.ensureRuntime(projectId, false);
      if (runtime.hcom.readTranscript) {
        transcript = await runtime.hcom.readTranscript(worker.hcomName, last).catch(() => []);
      }
    }
    return { progress, transcript };
  }

  private snapshotRequestProgress(projectId: string, requestId: string): ProgressLogEntry[] {
    const mem = this.requestProgress.get(`${projectId}:${requestId}`);
    if (!mem || mem.length === 0) return this.store.getRequest(projectId, requestId)?.progressSummary ?? [];
    return mem.slice(-40).map(entry => ({
      ...entry,
      ...(entry.detail && entry.detail.length > 1500 ? { detail: `${entry.detail.slice(0, 1500)}…` } : {}),
    }));
  }

  updateCodexSettings(projectId: string, input: UpdateCodexSettingsInput): CodexSessionRecord {
    this.requireProject(projectId);
    const updated = this.store.updateCodexSession(projectId, {
      ...(input.model !== undefined ? { model: input.model?.trim() || null } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort?.trim() || null } : {}),
      ...(input.sandboxMode !== undefined ? { sandboxMode: input.sandboxMode } : {}),
    });
    const runtime = this.runtimes.get(projectId);
    runtime?.codex?.setRuntimeConfig?.({
      model: updated.model ?? this.options.model ?? null,
      effort: updated.reasoningEffort ?? this.options.codexEffort ?? null,
      sandbox: updated.sandboxMode,
    });
    this.emitEvent(projectId, 'codex.settings_updated', {
      model: updated.model,
      reasoningEffort: updated.reasoningEffort,
      sandboxMode: updated.sandboxMode,
    });
    return updated;
  }

  async updateWorkerSettings(projectId: string, workerId: string, input: UpdateWorkerSettingsInput): Promise<WorkerRecord> {
    this.requireProject(projectId);
    this.assertWorkerBelongsToProject(projectId, workerId);
    const before = this.assertWorkerBelongsToProject(projectId, workerId);
    const updated = this.store.updateWorker(projectId, workerId, {
      ...(input.model !== undefined ? { model: input.model?.trim() || null } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort?.trim() || null } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    });
    const runtime = this.runtimes.get(projectId);
    if (runtime) {
      await this.writeWorkerSettingsFile(projectId, this.workerSettingsPathFor(projectId, updated), [updated.cwd], updated.permissionMode);
    }
    this.emitEvent(projectId, 'worker.settings_updated', {
      workerId,
      model: updated.model,
      reasoningEffort: updated.reasoningEffort,
      permissionMode: updated.permissionMode,
    });
    if (input.applyNow && (before.status === 'ready' || before.status === 'needs_attention')) {
      await this.stopWorker(projectId, workerId).catch(() => {});
      return this.startWorker(projectId, workerId);
    }
    return updated;
  }

  async resolveWorkerApproval(projectId: string, requestId: string, decision: 'approve' | 'deny'): Promise<RequestRecord> {
    this.requireProject(projectId);
    const req = this.store.getRequest(projectId, requestId);
    if (!req) throw new Error(`요청을 찾을 수 없습니다: ${projectId}/${requestId}`);
    if (req.status !== 'waiting_approval' || !req.pendingApproval) {
      throw new Error(`승인 대기 상태가 아닌 요청입니다 (${req.status}).`);
    }
    const approval = req.pendingApproval;
    const runtime = this.runtimes.get(projectId) ?? await this.ensureRuntime(projectId, false);
    if (runtime.hcom.injectInput) {
      await runtime.hcom.injectInput(approval.hcomName, decision === 'approve' ? '\r' : '\x1b');
    }
    const updated = this.store.updateRequest(projectId, requestId, {
      status: 'worker_working',
      pendingApproval: null,
      error: null,
    });
    this.store.updateWorker(projectId, approval.workerId, { status: 'working', lastError: null });
    this.pushRequestProgress(projectId, requestId, {
      ts: new Date().toISOString(),
      source: 'worker',
      kind: 'approval',
      summary: decision === 'approve' ? `워커(${approval.workerName}) 작업 승인됨` : `워커(${approval.workerName}) 작업 거절됨`,
      detail: approval.detail,
    });
    this.emitEvent(projectId, 'request.approval_resolved', {
      requestId,
      workerId: approval.workerId,
      decision,
    });
    this.notifyEventWaiters(runtime);
    return updated;
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

  async listProjectHcomParticipants(projectId: string, forceRefresh = true): Promise<ActiveParticipant[]> {
    const runtime = await this.ensureRuntime(projectId);
    if (!forceRefresh && runtime.participantsCache && Date.now() - runtime.participantsCache.cachedAt < 5000) {
      return runtime.participantsCache.items;
    }
    const items = await runtime.hcom.listParticipants();
    runtime.participantsCache = { items, cachedAt: Date.now() };
    return items;
  }

  getCachedHcomParticipants(projectId: string): ActiveParticipant[] {
    return this.runtimes.get(projectId)?.participantsCache?.items ?? [];
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
        model: input.model ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
        permissionMode: input.permissionMode ?? 'always-proceed',
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
        const settingsPath = this.workerSettingsPathFor(projectId, worker);
        await this.writeWorkerSettingsFile(projectId, settingsPath, [worker.cwd], worker.permissionMode);
        if (!worker.isDefault) {
          // 기본 agy-settings.json에도 추가 worktree 경로를 trustedWorkspaces로 동기화한다.
          await this.writeWorkerSettingsFile(projectId, runtime.settingsPath, [worker.cwd]);
        }
        const launchOpts: WorkerLaunchOptions = {
          settingsPath,
          cwd: worker.cwd,
          ...(worker.model ? { model: worker.model } : {}),
          ...(worker.reasoningEffort ? { effort: worker.reasoningEffort } : {}),
        };
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
          launch = await runtime.hcom.resumeWorker(binding, launchOpts);
        } else {
          launch = await runtime.hcom.launchWorker(launchOpts);
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
      runtime.participantsCache = undefined;
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
    const accepted = this.store.acceptRequest({ projectId, requestId, prompt, mode: 'codex' });
    if (!accepted.created) return accepted.request;
    this.emitEvent(projectId, 'request.accepted', { requestId, prompt, mode: 'codex' });

    return this.locks.run(`request:${projectId}`, async () => {
      return this.runCodexRequestLoop(projectId, requestId, { text: prompt });
    });
  }

  async replyToRequest(projectId: string, requestId: string, replyKey: string, answer: string): Promise<{ request: RequestRecord; deduplicated: boolean }> {
    this.requireProject(projectId);
    const trimmedKey = replyKey.trim();
    const trimmedAnswer = answer.trim();
    if (!trimmedKey || !trimmedAnswer) {
      throw new Error('replyKey와 답변 내용(answer)이 필요합니다.');
    }
    const existing = this.store.getRequest(projectId, requestId);
    if (!existing) throw new Error(`요청을 찾을 수 없습니다: ${projectId}/${requestId}`);
    if (existing.userReplies.some(entry => entry.replyKey === trimmedKey)) {
      return { request: existing, deduplicated: true };
    }
    if (existing.status !== 'waiting_user') {
      throw new Error(`사용자 답변 대기 상태가 아닌 요청입니다 (${existing.status}).`);
    }
    const question = existing.pendingQuestion ?? '';
    const nextReplies = [
      ...existing.userReplies,
      { replyKey: trimmedKey, question, answer: trimmedAnswer, createdAt: new Date().toISOString() },
    ];
    this.store.updateRequest(projectId, requestId, {
      status: 'codex_running',
      pendingQuestion: null,
      pendingQuestionOptions: [],
      userReplies: nextReplies,
      error: null,
    });
    this.emitEvent(projectId, 'request.user_replied', { requestId, replyKey: trimmedKey, question, answer: trimmedAnswer });

    const followup = `[사용자 답변]\n질문: ${question || '(질문 기록 없음)'}\n답변: ${trimmedAnswer}\n\n위 사용자 판단을 반영해 같은 요청을 이어서 완료하세요. 필요하면 delegate_work로 워커에 작업/재지시를 보내고, 추가 확인이 필요하면 ask_user로 질문하세요.`;
    const result = await this.locks.run(`request:${projectId}`, async () => {
      return this.runCodexRequestLoop(projectId, requestId, { text: followup });
    });
    return { request: result, deduplicated: false };
  }

  async cancelRequest(projectId: string, requestId: string): Promise<RequestRecord> {
    this.requireProject(projectId);
    const current = this.store.getRequest(projectId, requestId);
    if (!current) throw new Error(`요청을 찾을 수 없습니다: ${projectId}/${requestId}`);
    if (['completed', 'failed', 'timed_out', 'cancelled'].includes(current.status)) {
      return current;
    }

    const runtime = this.runtimes.get(projectId);
    if (runtime?.activeRequest?.requestId === requestId) {
      runtime.activeRequest.abortController.abort();
    }

    for (const del of this.store.listDelegations(projectId, requestId)) {
      if (del.status === 'sent') {
        this.store.updateDelegation(projectId, del.delegationId, { status: 'cancelled' });
        this.store.updateWorker(projectId, del.workerId, { status: 'ready', lastError: null });
      }
    }
    const updated = this.store.updateRequest(projectId, requestId, {
      status: 'cancelled',
      pendingQuestion: null,
      pendingQuestionOptions: [],
      error: '사용자 요청에 의해 취소되었습니다.',
    });
    if (this.store.getCodexSession(projectId)?.status === 'running') {
      this.store.updateCodexSession(projectId, { status: 'ready', lastError: null });
    }
    this.emitEvent(projectId, 'request.cancelled', { requestId, status: 'cancelled' });
    return updated;
  }

  async sendDirectWorkerMessage(
    projectId: string,
    workerId: string,
    requestId: string,
    prompt: string,
  ): Promise<{ request: RequestRecord; deduplicated: boolean }> {
    this.requireProject(projectId);
    this.assertWorkerBelongsToProject(projectId, workerId);
    const accepted = this.store.acceptRequest({ projectId, requestId, prompt, mode: 'direct_worker', targetWorkerId: workerId });
    if (!accepted.created) return { request: accepted.request, deduplicated: true };
    this.emitEvent(projectId, 'request.accepted', { requestId, prompt, mode: 'direct_worker', targetWorkerId: workerId });

    const completed = await this.locks.run(`request:${projectId}`, async () => {
      const runtime = await this.ensureRuntime(projectId);
      const worker = this.assertWorkerBelongsToProject(projectId, workerId);
      const readyWorker = worker.hcomName && (worker.status === 'ready' || worker.status === 'working')
        ? worker
        : await this.startWorker(projectId, workerId);
      if (!readyWorker.hcomName) throw new Error('워커가 hcom에 등록되지 않았습니다.');

      const sender = await this.ensureCodexParticipant(projectId, runtime);
      const target: Participant = {
        projectId,
        name: readyWorker.hcomName,
        sessionId: readyWorker.conversationId ?? '',
        tool: 'agy',
        status: readyWorker.status,
      };
      const abortController = new AbortController();
      runtime.activeRequest = { requestId, round: 1, abortController };

      try {
        this.store.updateWorker(projectId, workerId, { status: 'working', lastError: null });
        const wireTask = this.formatDelegationWireTask(prompt, sender.name);
        const receipt = await runtime.hcom.send(sender, target, wireTask);
        const delegation = this.store.createDelegation({
          projectId,
          requestId,
          workerId,
          round: 1,
          toolCallId: `direct:${requestId}`,
          requestEventId: receipt.eventId,
          prompt,
        });
        this.store.updateRequest(projectId, requestId, { status: 'worker_working', round: 1 });
        this.emitEvent(projectId, 'request.worker_working', {
          requestId,
          round: 1,
          workerId,
          workerName: readyWorker.name,
          requestEventId: receipt.eventId,
        });

        const reply = await this.waitForWorkerReply(
          projectId,
          runtime,
          sender,
          target,
          receipt.eventId,
          abortController.signal,
          { requestId, workerId, workerName: readyWorker.name },
        );
        const replyText = String(reply.data.text).trim();
        const summaryText = summarizeWorkerReplyForCodex(replyText);
        const claimed = this.store.claimDelegationReply(projectId, delegation.delegationId, reply.id, replyText, summaryText);
        if (!claimed.claimed) {
          return this.store.getRequest(projectId, requestId)!;
        }
        await this.bindAfterReply(projectId, workerId, readyWorker, runtime);
        this.store.updateDelegation(projectId, delegation.delegationId, { status: 'reviewed', reviewedAt: new Date().toISOString() });
        this.store.updateWorker(projectId, workerId, { status: 'ready', lastError: null });
        const finalRecord = this.store.updateRequest(projectId, requestId, {
          status: 'completed',
          pendingApproval: null,
          progressSummary: this.snapshotRequestProgress(projectId, requestId),
          finalText: replyText,
          error: null,
        });
        const gitSnap = this.git.readSnapshot(readyWorker.cwd);
        this.store.updateHandoff(projectId, {
          branchStatus: gitSnap.branchStatus,
          commitStatus: gitSnap.commitStatus,
          lastWorkerReport: replyText,
        });
        this.emitEvent(projectId, 'handoff.updated', { requestId });
        this.emitEvent(projectId, 'request.finished', { requestId, status: 'completed', finalText: replyText });
        return finalRecord;
      } catch (error) {
        return this.handleRequestFailure(projectId, requestId, error, workerId);
      } finally {
        if (runtime.activeRequest?.requestId === requestId) runtime.activeRequest = undefined;
      }
    });
    return { request: completed, deduplicated: false };
  }

  async resumePendingRequest(projectId: string, requestId: string): Promise<RequestRecord> {
    this.requireProject(projectId);
    return this.locks.run(`request:${projectId}`, async () => {
      const req = this.store.getRequest(projectId, requestId);
      if (!req) throw new Error(`요청을 찾을 수 없습니다: ${projectId}/${requestId}`);
      if (['completed', 'failed', 'timed_out', 'cancelled', 'waiting_user'].includes(req.status)) {
        return req;
      }
      const delegations = this.store.listDelegations(projectId, requestId);
      const latest = delegations.at(-1);
      if (!latest) return req;

      // 이미 검수 완료된 회신이면 중복 실행하지 않는다.
      if (latest.reviewedAt) return this.store.getRequest(projectId, requestId)!;

      const runtime = await this.ensureRuntime(projectId, true);
      const worker = this.store.getWorker(projectId, latest.workerId);
      if (!worker || !worker.hcomName) {
        return this.store.updateRequest(projectId, requestId, {
          status: 'needs_verification',
          error: '재접속 복구 중 대상 워커의 hcom 참가자 정보를 찾지 못했습니다.',
        });
      }

      // 이미 회신이 저장되었으나 검수 턴이 끝나지 않은 경우 바로 검수 턴으로 이어간다.
      if (latest.status === 'replied' && latest.replyEventId !== null) {
        const summary = latest.summaryText ?? summarizeWorkerReplyForCodex(latest.replyText ?? '');
        const reviewInput = this.buildReviewTurnInput(worker.name, latest.round, summary);
        return this.runCodexRequestLoop(projectId, requestId, reviewInput, latest);
      }

      // 워커 회신 대기 중(sent)에 백엔드가 재시작된 경우 같은 요청을 이어서 대기한다.
      if (latest.status === 'sent' && latest.requestEventId !== null) {
        const sender = await this.ensureCodexParticipant(projectId, runtime);
        const target: Participant = {
          projectId,
          name: worker.hcomName,
          sessionId: worker.conversationId ?? '',
          tool: 'agy',
          status: worker.status,
        };
        const pending: PendingDelegation = {
          delegation: latest,
          worker,
          target,
          receipt: { eventId: latest.requestEventId, deliveredTo: [worker.hcomName] },
          toolName: 'delegate_work',
        };
        return this.runCodexRequestLoop(projectId, requestId, undefined, undefined, pending);
      }
      return req;
    });
  }

  async resumePendingRequests(projectId: string): Promise<RequestRecord[]> {
    this.requireProject(projectId);
    const pending = this.store.listRequests(projectId).filter(req =>
      req.mode === 'codex' && (req.status === 'worker_working' || req.status === 'codex_reviewing'),
    );
    const results: RequestRecord[] = [];
    for (const req of pending) {
      results.push(await this.resumePendingRequest(projectId, req.requestId));
    }
    return results;
  }

  private formatDelegationWireTask(task: string, senderName: string): string {
    if (/--intent\s+inform/i.test(task)) return task;
    return [
      task,
      '',
      `[hcom 회신 규칙] 작업 완료 후 단순 접수(ack)가 아닌 최종 결과를 반드시 hcom send @${senderName} --intent inform --reply-to <요청ID> 형식으로 회신하세요.`,
      '회신은 아래 3항목 중심으로 간결하게 작성하세요:',
      '- 결과: 핵심 수행 내용',
      '- 변경 파일: 수정·생성한 파일 목록 (없으면 없음)',
      '- 테스트 요약: 실행한 검증과 결과 (없으면 미실행)',
    ].join('\n');
  }

  private buildReviewTurnInput(workerName: string, round: number, summaryText: string): { toolOutput: ToolOutput } {
    return {
      toolOutput: {
        name: 'delegate_work',
        output: [
          `워커(${workerName}, ${round}차) 회신 요약:`,
          summaryText,
          '',
          '[검수 지침] 결과를 검수하세요.',
          '- 충분하면 사용자에게 최종 답변을 한 번만 작성해 완료하세요.',
          '- 부족하거나 누락이 있으면 delegate_work 도구로 워커에게 구체적으로 보완 재지시하세요.',
          '- 사용자 판단이 필요하면 ask_user 도구로 질문하세요.',
        ].join('\n'),
      },
    };
  }

  private handleRequestFailure(projectId: string, requestId: string, error: unknown, fallbackWorkerId?: string): RequestRecord {
    const existing = this.store.getRequest(projectId, requestId);
    if (existing?.status === 'cancelled' || error instanceof RequestCancelledError) {
      const cancelled = this.store.updateRequest(projectId, requestId, {
        status: 'cancelled',
        pendingQuestion: null,
        pendingQuestionOptions: [],
        error: '사용자 요청에 의해 취소되었습니다.',
      });
      this.store.updateCodexSession(projectId, { status: 'ready', lastError: null });
      if (fallbackWorkerId) this.store.updateWorker(projectId, fallbackWorkerId, { status: 'ready', lastError: null });
      return cancelled;
    }

    const message = error instanceof Error ? error.message : String(error);
    const status: RequestRecord['status'] = error instanceof WorkerTimeoutError
      ? 'timed_out'
      : /대기 상태/.test(message)
        ? 'needs_attention'
        : /확인/.test(message)
          ? 'needs_verification'
          : 'failed';
    for (const del of this.store.listDelegations(projectId, requestId)) {
      if (del.status === 'sent' || del.status === 'replied') {
        const delStatus = status === 'timed_out' ? 'timed_out' : status === 'needs_attention' ? 'needs_attention' : 'failed';
        this.store.updateDelegation(projectId, del.delegationId, { status: delStatus });
        this.store.updateWorker(projectId, del.workerId, {
          status: status === 'needs_attention' ? 'needs_attention' : 'ready',
          lastError: message,
        });
      }
    }
    const updated = this.store.updateRequest(projectId, requestId, {
      status,
      pendingQuestion: null,
      pendingQuestionOptions: [],
      pendingApproval: null,
      progressSummary: this.snapshotRequestProgress(projectId, requestId),
      error: message,
    });
    this.store.updateCodexSession(projectId, { status: status === 'needs_attention' ? 'needs_attention' : 'ready', lastError: message });
    this.emitEvent(projectId, 'request.failed', { requestId, status, error: message });
    return updated;
  }

  private async runCodexRequestLoop(
    projectId: string,
    requestId: string,
    initialInput?: { text: string } | { toolOutput: ToolOutput },
    reviewingDelegation?: DelegationRecord,
    resumedPending?: PendingDelegation,
  ): Promise<RequestRecord> {
    const runtime = await this.ensureRuntime(projectId);
    const codex = await this.ensureCodexSession(projectId);
    const maxRounds = this.options.maxDelegationRounds ?? 8;
    const currentReq = this.store.getRequest(projectId, requestId)!;
    const abortController = new AbortController();
    const active: ActiveRequestState = {
      requestId,
      round: currentReq.round,
      abortController,
      delegation: resumedPending,
    };
    runtime.activeRequest = active;

    let nextInput = initialInput;
    let pendingReviewDelegation = reviewingDelegation;
    let lastWorkerReplyText: string | null = reviewingDelegation?.replyText ?? null;

    try {
      while (true) {
        if (abortController.signal.aborted || this.store.getRequest(projectId, requestId)?.status === 'cancelled') {
          throw new RequestCancelledError();
        }

        // 1. 대기 중인 워커 위임이 없으면 Codex 턴(판단 또는 검수)을 실행한다.
        if (!active.delegation) {
          if (!nextInput) {
            throw new Error('Codex 다음 턴 입력을 구성할 수 없습니다.');
          }
          const isReview = 'toolOutput' in nextInput;
          this.store.updateRequest(projectId, requestId, {
            status: isReview ? 'codex_reviewing' : 'codex_running',
            round: active.round,
            error: null,
          });
          this.store.updateCodexSession(projectId, { status: 'running', lastError: null });
          if (!isReview) {
            this.emitEvent(projectId, 'request.codex_running', { requestId, round: active.round });
          }

          active.delegation = undefined;
          active.pendingQuestion = undefined;
          const turn = await codex.runTurn(nextInput);

          if (abortController.signal.aborted || this.store.getRequest(projectId, requestId)?.status === 'cancelled') {
            throw new RequestCancelledError();
          }

          // codex.runTurn 내부 onToolCall 콜백이 active 상태를 갱신하므로 명시적으로 다시 읽는다.
          const asked = active.pendingQuestion as PendingUserQuestion | undefined;
          const delegated = active.delegation as PendingDelegation | undefined;
          const turnSucceededForTool = turn.status === 'completed' || (turn.status === 'needs_final_answer' && Boolean(delegated || asked));

          if (pendingReviewDelegation) {
            this.store.updateDelegation(projectId, pendingReviewDelegation.delegationId, {
              status: turnSucceededForTool ? 'reviewed' : 'failed',
              reviewedAt: new Date().toISOString(),
            });
            pendingReviewDelegation = undefined;
          }

          // 1-A. 사용자 판단 필요(ask_user) => 질문 저장 후 대기 상태로 일시 정지 (토큰 소모 0)
          if (asked && turnSucceededForTool) {
            const waitingRecord = this.store.updateRequest(projectId, requestId, {
              status: 'waiting_user',
              codexTurnId: isReview ? currentReq.codexTurnId : turn.turnId,
              reviewTurnId: isReview ? turn.turnId : currentReq.reviewTurnId,
              pendingQuestion: asked.question,
              pendingQuestionOptions: asked.options,
              pendingApproval: null,
              progressSummary: this.snapshotRequestProgress(projectId, requestId),
              error: null,
            });
            this.store.updateCodexSession(projectId, { status: 'ready', lastError: null });
            this.emitEvent(projectId, 'request.waiting_user', {
              requestId,
              round: active.round,
              question: asked.question,
              options: asked.options,
            });
            return waitingRecord;
          }

          // 1-B. 추가 위임이 없으면 Codex가 직접 답변했거나 검수를 통과한 최종 완료
          if (!delegated) {
            const finalStatus: RequestRecord['status'] = turn.status === 'completed'
              ? 'completed'
              : turn.status === 'needs_final_answer'
                ? 'needs_verification'
                : turn.status;
            const finalRecord = this.store.updateRequest(projectId, requestId, {
              status: finalStatus,
              round: active.round,
              codexTurnId: isReview ? this.store.getRequest(projectId, requestId)?.codexTurnId ?? turn.turnId : turn.turnId,
              reviewTurnId: isReview ? turn.turnId : this.store.getRequest(projectId, requestId)?.reviewTurnId ?? null,
              pendingQuestion: null,
              pendingQuestionOptions: [],
              pendingApproval: null,
              progressSummary: this.snapshotRequestProgress(projectId, requestId),
              finalText: turn.finalText ?? null,
              error: turn.reason ?? null,
            });
            this.store.updateCodexSession(projectId, { status: 'ready', lastError: null });
            if (finalStatus === 'completed') {
              const gitSnap = this.git.readSnapshot(this.store.getCodexSession(projectId)!.cwd);
              this.store.updateHandoff(projectId, {
                branchStatus: gitSnap.branchStatus,
                commitStatus: gitSnap.commitStatus,
                ...(lastWorkerReplyText ? { lastWorkerReport: lastWorkerReplyText } : {}),
                lastCodexReview: turn.finalText ?? null,
              });
              this.emitEvent(projectId, 'handoff.updated', { requestId });
            }
            this.emitEvent(projectId, 'request.finished', {
              requestId,
              status: finalRecord.status,
              round: finalRecord.round,
              finalText: finalRecord.finalText,
              error: finalRecord.error,
            });
            return finalRecord;
          }

          // 1-C. 위임 도구를 호출했으나 Codex 턴 자체가 비정상 종료된 경우 (중간 위임 턴의 final_answer 생략은 정상)
          if (!turnSucceededForTool) {
            const failStatus: RequestRecord['status'] = turn.status === 'needs_final_answer' ? 'needs_verification' : turn.status;
            const record = this.store.updateRequest(projectId, requestId, {
              status: failStatus,
              codexTurnId: turn.turnId,
              error: turn.reason ?? '위임 턴이 완료되지 않았습니다.',
            });
            this.store.updateCodexSession(projectId, { status: 'ready' });
            this.emitEvent(projectId, 'request.finished', { requestId, status: record.status, error: record.error });
            return record;
          }

          if (delegated.delegation.round > maxRounds) {
            throw new Error(`최대 위임 라운드(${maxRounds}회)를 초과했습니다.`);
          }
          this.store.updateRequest(projectId, requestId, {
            codexTurnId: this.store.getRequest(projectId, requestId)?.codexTurnId ?? turn.turnId,
            round: delegated.delegation.round,
          });
        }

        // 2. 워커 작업 대기 단계 (대기 중 Codex 턴 없음 → 토큰 소모 0)
        const pending = active.delegation as PendingDelegation;
        active.round = pending.delegation.round;
        this.store.updateRequest(projectId, requestId, { status: 'worker_working', round: active.round });
        this.store.updateCodexSession(projectId, { status: 'ready', lastError: null });
        this.emitEvent(projectId, 'request.worker_working', {
          requestId,
          round: active.round,
          workerId: pending.worker.workerId,
          workerName: pending.worker.name,
          requestEventId: pending.receipt.eventId,
        });

        const sender = await this.ensureCodexParticipant(projectId, runtime);
        const reply = await this.waitForWorkerReply(
          projectId,
          runtime,
          sender,
          pending.target,
          pending.receipt.eventId,
          abortController.signal,
          { requestId, workerId: pending.worker.workerId, workerName: pending.worker.name },
        );
        const replyText = String(reply.data.text).trim();
        const summaryText = summarizeWorkerReplyForCodex(replyText);

        // 같은 회신 이벤트가 중복 도착하거나 재접속 재생돼도 검수/재지시는 한 번만 실행한다.
        const claimed = this.store.claimDelegationReply(projectId, pending.delegation.delegationId, reply.id, replyText, summaryText);
        if (!claimed.claimed) {
          active.delegation = undefined;
          return this.store.getRequest(projectId, requestId)!;
        }

        const binding = await this.bindAfterReply(projectId, pending.worker.workerId, pending.worker, runtime);
        this.store.updateWorker(projectId, pending.worker.workerId, { status: 'ready', lastError: null });
        this.store.updateRequest(projectId, requestId, { status: 'codex_reviewing', round: active.round });
        this.emitEvent(projectId, 'request.codex_reviewing', {
          requestId,
          round: active.round,
          workerId: pending.worker.workerId,
          workerName: pending.worker.name,
          replyEventId: reply.id,
          replyText,
          summaryText,
          conversationId: binding.sessionId,
        });

        lastWorkerReplyText = replyText;
        pendingReviewDelegation = claimed.delegation;
        nextInput = this.buildReviewTurnInput(pending.worker.name, active.round, summaryText);
        active.delegation = undefined;
      }
    } catch (error) {
      const updated = this.handleRequestFailure(projectId, requestId, error);
      if (error instanceof RequestCancelledError || error instanceof WorkerTimeoutError) {
        return updated;
      }
      throw error;
    } finally {
      if (runtime.activeRequest === active) runtime.activeRequest = undefined;
    }
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
    if (project.gitCommonDirKey.startsWith('dir:')) {
      if (normalizePathKey(worktreePath) === normalizePathKey(project.rootPath)) {
        return project.rootPath;
      }
      throw new Error('Git 저장소가 아닌 일반 폴더 프로젝트에서는 worktree 전환을 지원하지 않습니다.');
    }
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
        eventWaiters: new Set(),
        reconciled: false,
      };
      this.runtimes.set(projectId, runtime);
      this.startFollowLoop(projectId, runtime);
      if (reconcile) await this.reconcileRuntime(projectId, runtime);
      return runtime;
    });
  }

  private startFollowLoop(projectId: string, runtime: ProjectRuntime): void {
    const savedCursor = this.store.getCursor(projectId)?.lastEventId ?? 0;
    const pendingSentIds = this.store.listDelegations(projectId)
      .filter(d => d.status === 'sent' && d.requestEventId !== null)
      .map(d => d.requestEventId as number);
    const cursor = pendingSentIds.length > 0
      ? Math.max(0, Math.min(savedCursor, Math.min(...pendingSentIds) - 1))
      : savedCursor;
    const seenEventIds = new Set<number>(runtime.events.map(e => e.id));
    runtime.eventError = undefined;
    runtime.stopFollow = runtime.hcom.follow(
      cursor,
      event => {
        if (seenEventIds.has(event.id)) return;
        seenEventIds.add(event.id);
        runtime.events.push(event);
        this.store.updateCursor(projectId, event.id);
        this.handleHcomEvent(projectId, runtime, event);
        this.notifyEventWaiters(runtime);
      },
      error => {
        runtime.eventError = error;
        this.notifyEventWaiters(runtime);
        if (/DB가 교체/.test(error.message)) {
          this.store.markDbReset(projectId);
          this.emitEvent(projectId, 'hcom.db_reset', { error: error.message });
        }
      },
    );
  }

  private notifyEventWaiters(runtime: ProjectRuntime): void {
    for (const wake of runtime.eventWaiters) {
      try { wake(); } catch {}
    }
    runtime.eventWaiters.clear();
  }

  private handleHcomEvent(projectId: string, runtime: ProjectRuntime, event: HcomEvent): void {
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
        const senderWorker = this.store.findWorkerByHcomName(projectId, event.data.from);
        if (senderWorker) {
          const preview = event.data.text.replace(/\s+/g, ' ').trim().slice(0, 120);
          this.pushWorkerProgress(projectId, senderWorker.workerId, {
            ts: new Date().toISOString(),
            source: 'worker',
            kind: 'message',
            summary: `회신 전송: ${preview}`,
            detail: event.data.text,
          });
        }
      }
      return;
    }
    if (event.type !== 'status' || !event.instance) return;
    runtime.participantsCache = undefined;
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
    const context = typeof event.data.context === 'string' ? event.data.context : '';
    const detail = typeof event.data.detail === 'string' ? event.data.detail : '';
    const progressSummary = rawStatus === 'blocked'
      ? `승인 대기 (${context || 'blocked'}): ${detail.replace(/\s+/g, ' ').trim().slice(0, 100)}`
      : rawStatus === 'active'
        ? `작업 중${context ? ` (${context})` : ''}${detail ? `: ${detail.replace(/\s+/g, ' ').trim().slice(0, 100)}` : ''}`
        : `상태 전환: ${rawStatus}${context ? ` (${context})` : ''}`;
    const entry: ProgressLogEntry = {
      ts: new Date().toISOString(),
      source: 'worker',
      kind: rawStatus === 'blocked' ? 'approval' : 'status',
      summary: progressSummary,
      ...(detail ? { detail } : {}),
    };
    this.pushWorkerProgress(projectId, worker.workerId, entry);
    if (runtime.activeRequest) {
      this.pushRequestProgress(projectId, runtime.activeRequest.requestId, entry);
    }

    const updated = this.store.updateWorker(projectId, worker.workerId, {
      status: mapped,
      ...(session && !worker.conversationId ? { conversationId: session } : {}),
      lastError: mapped === 'needs_attention' ? String(detail || context || 'blocked') : null,
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

  private workerSettingsPathFor(projectId: string, worker: WorkerRecord): string {
    const project = this.requireProject(projectId);
    return worker.isDefault
      ? join(project.hcomDir, 'agy-settings.json')
      : join(project.hcomDir, `agy-settings-${worker.workerId}.json`);
  }

  private async writeWorkerSettingsFile(
    projectId: string,
    settingsPath: string,
    extraPaths: readonly string[] = [],
    permissionMode?: WorkerPermissionMode,
  ): Promise<void> {
    const project = this.requireProject(projectId);
    const effectivePermission = permissionMode ?? this.store.getDefaultWorker(projectId)?.permissionMode ?? 'always-proceed';
    const base: Record<string, unknown> = { agentMode: '', ...(this.options.workerSettings ?? {}) };
    if (effectivePermission === 'always-proceed') {
      base.agentMode = '';
      base.toolPermission = 'always-proceed';
    } else if (effectivePermission === 'read-only') {
      base.agentMode = 'plan';
      delete base.toolPermission;
    } else {
      base.agentMode = '';
      if (!this.options.workerSettings || !('toolPermission' in this.options.workerSettings)) {
        delete base.toolPermission;
      }
    }
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

  private handleCodexProgress(projectId: string, runtime: ProjectRuntime, event: Progress): void {
    const active = runtime.activeRequest;
    if (!active) return;
    const method = event.method;
    const params = event.params;
    const now = new Date().toISOString();

    if (method === 'turn/started') {
      this.pushRequestProgress(projectId, active.requestId, {
        ts: now,
        source: 'codex',
        kind: 'status',
        summary: 'Codex 요청 분석 시작',
      });
      return;
    }

    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (!delta) return;
      this.pushRequestProgress(projectId, active.requestId, {
        ts: now,
        source: 'codex',
        kind: 'reasoning',
        summary: delta.replace(/\s+/g, ' ').trim().slice(0, 120) || '추론 중...',
        detail: delta,
      }, true);
      return;
    }

    if (method === 'item/commandExecution/outputDelta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (!delta) return;
      this.pushRequestProgress(projectId, active.requestId, {
        ts: now,
        source: 'codex',
        kind: 'command_output',
        summary: delta.split('\n').map(s => s.trim()).filter(Boolean).at(-1)?.slice(0, 120) || '명령 출력 수신 중...',
        detail: delta,
      }, true);
      return;
    }

    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item && typeof params.item === 'object' && !Array.isArray(params.item)
        ? params.item as Record<string, unknown>
        : undefined;
      if (!item) return;
      const itemType = typeof item.type === 'string' ? item.type : '';
      if (itemType === 'reasoning') {
        if (method === 'item/started') {
          this.pushRequestProgress(projectId, active.requestId, {
            ts: now,
            source: 'codex',
            kind: 'reasoning',
            summary: 'Codex 추론 중...',
          });
        } else {
          const summaryArr = Array.isArray(item.summary) ? item.summary.filter((s): s is string => typeof s === 'string') : [];
          const text = summaryArr.join('\n').trim() || (typeof item.text === 'string' ? item.text.trim() : '');
          if (text) {
            this.pushRequestProgress(projectId, active.requestId, {
              ts: now,
              source: 'codex',
              kind: 'reasoning_done',
              summary: text.split('\n')[0]!.trim().slice(0, 140),
              detail: text,
            });
          }
        }
      } else if (itemType === 'agentMessage' && item.phase === 'commentary') {
        if (method === 'item/completed' && typeof item.text === 'string' && item.text.trim()) {
          const text = item.text.trim();
          this.pushRequestProgress(projectId, active.requestId, {
            ts: now,
            source: 'codex',
            kind: 'commentary',
            summary: text.split('\n')[0]!.trim().slice(0, 140),
            detail: text,
          });
        }
      } else if (itemType === 'agentMessage' && item.phase === 'final_answer' && method === 'item/started') {
        this.pushRequestProgress(projectId, active.requestId, {
          ts: now,
          source: 'codex',
          kind: 'answer_streaming',
          summary: '최종 답변 작성 중...',
        });
      } else if (itemType === 'commandExecution') {
        const cmd = typeof item.command === 'string' ? item.command : '';
        const out = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(0, 1500) : '';
        this.pushRequestProgress(projectId, active.requestId, {
          ts: now,
          source: 'codex',
          kind: method === 'item/started' ? 'command_start' : 'command_done',
          summary: `${method === 'item/started' ? '명령 실행 중' : '명령 완료'}: ${cmd.slice(0, 100) || '(shell)'}`,
          detail: out ? `$ ${cmd}\n${out}` : `$ ${cmd}`,
        });
      } else if (itemType === 'fileChange') {
        this.pushRequestProgress(projectId, active.requestId, {
          ts: now,
          source: 'codex',
          kind: 'file_change',
          summary: method === 'item/started' ? '파일 변경 준비 중...' : '파일 변경 적용 완료',
          detail: JSON.stringify(item.changes ?? item).slice(0, 1200),
        });
      } else if (itemType === 'dynamicToolCall' || itemType === 'mcpToolCall') {
        const toolName = typeof item.tool === 'string' ? item.tool : (typeof item.name === 'string' ? item.name : itemType);
        this.pushRequestProgress(projectId, active.requestId, {
          ts: now,
          source: 'codex',
          kind: 'tool',
          summary: `${method === 'item/started' ? '도구 호출 중' : '도구 완료'}: ${toolName}`,
        });
      }
    }
  }

  private async connectCodexForCwd(project: ProjectRecord, runtime: ProjectRuntime, cwd: string): Promise<CodexClient> {
    const codexRec = this.store.getCodexSession(project.projectId);
    return this.createCodex({
      command: this.options.codexCommand,
      cwd,
      model: codexRec?.model ?? this.options.model,
      effort: codexRec?.reasoningEffort ?? this.options.codexEffort,
      sandbox: codexRec?.sandboxMode ?? this.options.codexSandbox ?? 'danger-full-access',
      env: this.options.env ?? process.env,
      hcomDir: project.hcomDir,
      dynamicTools: delegateTools,
      onToolCall: params => this.handleCodexToolCall(project.projectId, runtime, params),
      onProgress: event => this.handleCodexProgress(project.projectId, runtime, event),
    });
  }

  private async handleCodexToolCall(projectId: string, runtime: ProjectRuntime, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = asNonEmptyString(params.tool);
    if (tool === 'list_workers') {
      await this.syncStatusesFromHcom(projectId, runtime);
      const workers = this.store.listWorkers(projectId).map(worker => ({
        workerId: worker.workerId,
        name: worker.name,
        tool: 'agy',
        engine: 'Antigravity (agy)',
        isDefault: worker.isDefault,
        hcomName: worker.hcomName,
        status: worker.status,
        model: worker.model,
        reasoningEffort: worker.reasoningEffort,
        permissionMode: worker.permissionMode,
        cwd: worker.cwd,
      }));
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(workers) }] };
    }

    if (tool === 'ask_user') {
      const active = runtime.activeRequest;
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {};
      const question = asNonEmptyString(args.question);
      const options = Array.isArray(args.options)
        ? args.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
        : [];
      if (!active || !question) {
        return { success: false, contentItems: [{ type: 'inputText', text: '질문 내용(question)이 필요합니다.' }] };
      }
      if (active.delegation || active.pendingQuestion) {
        return { success: false, contentItems: [{ type: 'inputText', text: '한 턴에는 위임 또는 사용자 질문 중 하나만 요청할 수 있습니다.' }] };
      }
      active.pendingQuestion = { question, options };
      return {
        success: true,
        contentItems: [{ type: 'inputText', text: '사용자에게 질문을 전달하고 답변을 대기합니다. 답변이 도착하면 같은 요청에서 이어집니다.' }],
      };
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
      if (active.delegation || active.pendingQuestion) {
        return { success: false, contentItems: [{ type: 'inputText', text: '한 턴에는 한 워커에게 하나의 작업만 위임할 수 있습니다. 회신을 검수한 뒤 다음 라운드에서 재지시하세요.' }] };
      }
      const nextRound = active.round + 1;
      const maxRounds = this.options.maxDelegationRounds ?? 8;
      if (nextRound > maxRounds) {
        return { success: false, contentItems: [{ type: 'inputText', text: `최대 위임 라운드(${maxRounds}회)에 도달했습니다. 현재 결과로 정리하거나 ask_user로 사용자 판단을 요청하세요.` }] };
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
      const wireTask = this.formatDelegationWireTask(task, sender.name);
      const receipt = await runtime.hcom.send(sender, target, wireTask);
      const delegation = this.store.createDelegation({
        projectId,
        requestId: active.requestId,
        workerId: readyWorker.workerId,
        round: nextRound,
        toolCallId: callId,
        requestEventId: receipt.eventId,
        prompt: task,
      });
      active.delegation = { delegation, worker: readyWorker, target, receipt, toolName: tool };
      return {
        success: true,
        contentItems: [{ type: 'inputText', text: `워커(${readyWorker.name}, ${nextRound}차, event #${receipt.eventId})에게 작업을 전달했습니다. 실제 회신 요약은 이후 도구 출력으로 제공됩니다.` }],
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
    signal?: AbortSignal,
    requestContext?: { requestId: string; workerId: string; workerName: string },
  ): Promise<HcomEvent> {
    const timeoutMs = this.options.replyTimeoutMs ?? 180_000;
    const approvalDebounceMs = this.options.approvalDebounceMs ?? 2500;
    const basePollMs = this.options.pollIntervalMs ?? 2500;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let jammedSince: number | undefined;
    let blockedSince: number | undefined;
    let nextTermCheckAt = startedAt + 6000;
    let termBackoffMs = 4000;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new RequestCancelledError();
      if (runtime.eventError) throw runtime.eventError;
      const found = runtime.events.find(event => isWorkerReply(event, projectId, sender, target, requestEventId));
      if (found) {
        if (requestContext) {
          const req = this.store.getRequest(projectId, requestContext.requestId);
          if (req?.status === 'waiting_approval') {
            this.store.updateRequest(projectId, requestContext.requestId, { status: 'worker_working', pendingApproval: null });
          }
        }
        return found;
      }

      const status = runtime.events.findLast(event => event.id > requestEventId && event.type === 'status' && event.instance === target.name);
      if (status?.data.status === 'blocked') {
        const context = String(status.data.context ?? 'blocked');
        const detail = String(status.data.detail ?? '');
        if (!requestContext) {
          throw new Error(`워커가 대기 상태로 중단됐습니다 (${context}): ${detail}`);
        }
        blockedSince ??= Date.now();
        if (Date.now() - blockedSince >= approvalDebounceMs) {
          const req = this.store.getRequest(projectId, requestContext.requestId);
          if (req && req.status !== 'waiting_approval') {
            const pendingApproval: PendingApprovalRecord = {
              workerId: requestContext.workerId,
              workerName: requestContext.workerName,
              hcomName: target.name,
              context,
              detail,
              detectedAt: new Date().toISOString(),
            };
            this.store.updateRequest(projectId, requestContext.requestId, {
              status: 'waiting_approval',
              pendingApproval,
              error: null,
            });
            this.emitEvent(projectId, 'request.waiting_approval', {
              requestId: requestContext.requestId,
              ...pendingApproval,
            });
          }
        }
      } else {
        blockedSince = undefined;
        if (requestContext) {
          const req = this.store.getRequest(projectId, requestContext.requestId);
          if (req?.status === 'waiting_approval') {
            this.store.updateRequest(projectId, requestContext.requestId, {
              status: 'worker_working',
              pendingApproval: null,
            });
          }
        }
      }

      const started = runtime.events.some(event => event.id > requestEventId && event.type === 'status' && event.instance === target.name && event.data.status === 'active');
      const now = Date.now();
      if (!started && now >= nextTermCheckAt) {
        await runtime.hcom.clearBannerOverlay(target.name).catch(() => false);
        const term = await runtime.hcom.readTerminal(target.name).catch(() => undefined);
        if (term && isJammedTerminal(term, requestEventId)) {
          jammedSince ??= now;
          if (now - jammedSince >= 4000) {
            await runtime.hcom.clearJammedInput(target.name, requestEventId).catch(() => false);
            jammedSince = undefined;
          }
        } else {
          jammedSince = undefined;
        }
        nextTermCheckAt = now + termBackoffMs;
        termBackoffMs = Math.min(15_000, termBackoffMs * 2);
      }

      const waitBudget = Math.min(
        Math.max(10, deadline - Date.now()),
        blockedSince !== undefined ? Math.min(200, Math.max(20, approvalDebounceMs - (Date.now() - blockedSince))) : basePollMs,
      );
      await new Promise<void>(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          runtime.eventWaiters.delete(finish);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, waitBudget);
        runtime.eventWaiters.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
      });
    }
    throw new WorkerTimeoutError('워커 결과 회신 시간 초과');
  }
}
