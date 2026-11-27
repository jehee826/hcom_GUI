import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type CodexSessionStatus = 'stopped' | 'starting' | 'ready' | 'running' | 'needs_attention' | 'disconnected' | 'error';
export type WorkerSessionStatus = 'stopped' | 'starting' | 'ready' | 'working' | 'needs_attention' | 'disconnected' | 'error';
export type RequestMode = 'codex' | 'direct_worker';
export type RequestStatus =
  | 'accepted'
  | 'codex_running'
  | 'worker_working'
  | 'codex_reviewing'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'interrupted'
  | 'needs_attention'
  | 'needs_verification';
export type DelegationStatus = 'sent' | 'replied' | 'reviewed' | 'failed' | 'timed_out' | 'cancelled' | 'needs_attention';

export interface UserReplyEntry {
  readonly replyKey: string;
  readonly question: string;
  readonly answer: string;
  readonly createdAt: string;
}

export interface ProjectRecord {
  readonly projectId: string;
  readonly name: string;
  readonly rootPath: string;
  readonly gitCommonDir: string;
  readonly gitCommonDirKey: string;
  readonly hcomDir: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CodexSessionRecord {
  readonly projectId: string;
  readonly cwd: string;
  readonly threadId: string | null;
  readonly hcomName: string | null;
  readonly status: CodexSessionStatus;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export interface WorkerRecord {
  readonly workerId: string;
  readonly projectId: string;
  readonly requestKey: string | null;
  readonly name: string;
  readonly isDefault: boolean;
  readonly cwd: string;
  readonly hcomName: string | null;
  readonly conversationId: string | null;
  readonly status: WorkerSessionStatus;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RequestRecord {
  readonly projectId: string;
  readonly requestId: string;
  readonly mode: RequestMode;
  readonly targetWorkerId: string | null;
  readonly prompt: string;
  readonly status: RequestStatus;
  readonly round: number;
  readonly codexTurnId: string | null;
  readonly reviewTurnId: string | null;
  readonly pendingQuestion: string | null;
  readonly pendingQuestionOptions: string[];
  readonly userReplies: UserReplyEntry[];
  readonly finalText: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DelegationRecord {
  readonly delegationId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly workerId: string;
  readonly round: number;
  readonly toolCallId: string;
  readonly requestEventId: number | null;
  readonly replyEventId: number | null;
  readonly prompt: string;
  readonly replyText: string | null;
  readonly summaryText: string | null;
  readonly reviewedAt: string | null;
  readonly status: DelegationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HcomCursorRecord {
  readonly projectId: string;
  readonly lastEventId: number;
  readonly dbResetRequired: boolean;
  readonly updatedAt: string;
}

export interface HandoffRecord {
  readonly projectId: string;
  readonly goal: string;
  readonly designDocs: string[];
  readonly branchStatus: string;
  readonly commitStatus: string;
  readonly testCommand: string | null;
  readonly testResult: string;
  readonly nextSteps: string;
  readonly lastWorkerReport: string | null;
  readonly lastCodexReview: string | null;
  readonly updatedAt: string;
}

export interface ProjectEventRecord {
  readonly seq: number;
  readonly projectId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface RegisterProjectInput {
  readonly projectId?: string;
  readonly name: string;
  readonly rootPath: string;
  readonly gitCommonDir: string;
  readonly gitCommonDirKey: string;
  readonly hcomDir: string;
  readonly branchStatus: string;
  readonly commitStatus: string;
  readonly defaultWorkerName?: string;
}

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const asString = (value: unknown): string => typeof value === 'string' ? value : '';
const asNullableString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const asNumber = (value: unknown): number => typeof value === 'number' ? value : Number(value);
const asNullableNumber = (value: unknown): number | null => value === null || value === undefined ? null : asNumber(value);

function mapProject(row: Row): ProjectRecord {
  return {
    projectId: asString(row.project_id),
    name: asString(row.name),
    rootPath: asString(row.root_path),
    gitCommonDir: asString(row.git_common_dir_raw),
    gitCommonDirKey: asString(row.git_common_dir),
    hcomDir: asString(row.hcom_dir),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapCodex(row: Row): CodexSessionRecord {
  return {
    projectId: asString(row.project_id),
    cwd: asString(row.cwd),
    threadId: asNullableString(row.thread_id),
    hcomName: asNullableString(row.hcom_name),
    status: asString(row.status) as CodexSessionStatus,
    lastError: asNullableString(row.last_error),
    updatedAt: asString(row.updated_at),
  };
}

function mapWorker(row: Row): WorkerRecord {
  return {
    workerId: asString(row.worker_id),
    projectId: asString(row.project_id),
    requestKey: asNullableString(row.request_key),
    name: asString(row.name),
    isDefault: asNumber(row.is_default) === 1,
    cwd: asString(row.cwd),
    hcomName: asNullableString(row.hcom_name),
    conversationId: asNullableString(row.conversation_id),
    status: asString(row.status) as WorkerSessionStatus,
    lastError: asNullableString(row.last_error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function parseStringArray(raw: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(asString(raw) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseUserReplies(raw: unknown): UserReplyEntry[] {
  try {
    const parsed: unknown = JSON.parse(asString(raw) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(item => ({
        replyKey: asString(item.replyKey),
        question: asString(item.question),
        answer: asString(item.answer),
        createdAt: asString(item.createdAt),
      }))
      .filter(item => item.replyKey.length > 0);
  } catch {
    return [];
  }
}

function mapRequest(row: Row): RequestRecord {
  const rawMode = asString(row.mode);
  return {
    projectId: asString(row.project_id),
    requestId: asString(row.request_id),
    mode: rawMode === 'direct_worker' ? 'direct_worker' : 'codex',
    targetWorkerId: asNullableString(row.target_worker_id),
    prompt: asString(row.prompt),
    status: asString(row.status) as RequestStatus,
    round: row.round === undefined || row.round === null ? 0 : asNumber(row.round),
    codexTurnId: asNullableString(row.codex_turn_id),
    reviewTurnId: asNullableString(row.review_turn_id),
    pendingQuestion: asNullableString(row.pending_question),
    pendingQuestionOptions: parseStringArray(row.pending_question_options_json),
    userReplies: parseUserReplies(row.user_replies_json),
    finalText: asNullableString(row.final_text),
    error: asNullableString(row.error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapDelegation(row: Row): DelegationRecord {
  return {
    delegationId: asString(row.delegation_id),
    projectId: asString(row.project_id),
    requestId: asString(row.request_id),
    workerId: asString(row.worker_id),
    round: row.round === undefined || row.round === null ? 1 : asNumber(row.round),
    toolCallId: asString(row.tool_call_id),
    requestEventId: asNullableNumber(row.request_event_id),
    replyEventId: asNullableNumber(row.reply_event_id),
    prompt: asString(row.prompt),
    replyText: asNullableString(row.reply_text),
    summaryText: asNullableString(row.summary_text),
    reviewedAt: asNullableString(row.reviewed_at),
    status: asString(row.status) as DelegationStatus,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapHandoff(row: Row): HandoffRecord {
  let designDocs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(asString(row.design_docs_json) || '[]');
    if (Array.isArray(parsed)) designDocs = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    designDocs = [];
  }
  return {
    projectId: asString(row.project_id),
    goal: asString(row.goal) || '미설정',
    designDocs,
    branchStatus: asString(row.branch_status) || '확인 필요',
    commitStatus: asString(row.commit_status) || '커밋 없음',
    testCommand: asNullableString(row.test_command),
    testResult: asString(row.test_result) || '미실행',
    nextSteps: asString(row.next_steps) || '미설정',
    lastWorkerReport: asNullableString(row.last_worker_report),
    lastCodexReview: asNullableString(row.last_codex_review),
    updatedAt: asString(row.updated_at),
  };
}

function mapCursor(row: Row): HcomCursorRecord {
  return {
    projectId: asString(row.project_id),
    lastEventId: asNumber(row.last_event_id),
    dbResetRequired: asNumber(row.db_reset_required) === 1,
    updatedAt: asString(row.updated_at),
  };
}

function mapEvent(row: Row): ProjectEventRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(asString(row.payload_json) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    seq: asNumber(row.seq),
    projectId: asString(row.project_id),
    kind: asString(row.kind),
    payload,
    createdAt: asString(row.created_at),
  };
}

export class ProjectStore {
  private readonly db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.initSchema();
  }

  static projectHcomDir(dataDir: string, projectId: string): string {
    return join(dataDir, 'projects', projectId, 'hcom');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        git_common_dir TEXT NOT NULL UNIQUE,
        git_common_dir_raw TEXT NOT NULL,
        hcom_dir TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS codex_sessions (
        project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
        cwd TEXT NOT NULL,
        thread_id TEXT UNIQUE,
        hcom_name TEXT,
        status TEXT NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workers (
        worker_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        request_key TEXT,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        hcom_name TEXT,
        conversation_id TEXT UNIQUE,
        status TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, request_key)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_default_per_project
        ON workers(project_id) WHERE is_default = 1;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_hcom_name_per_project
        ON workers(project_id, hcom_name) WHERE hcom_name IS NOT NULL;

      CREATE TABLE IF NOT EXISTS requests (
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        codex_turn_id TEXT,
        review_turn_id TEXT,
        final_text TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, request_id)
      );

      CREATE TABLE IF NOT EXISTS delegations (
        delegation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        request_event_id INTEGER,
        reply_event_id INTEGER,
        prompt TEXT NOT NULL,
        reply_text TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hcom_cursors (
        project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
        last_event_id INTEGER NOT NULL DEFAULT 0,
        db_reset_required INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS handoffs (
        project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
        goal TEXT NOT NULL DEFAULT '미설정',
        design_docs_json TEXT NOT NULL DEFAULT '[]',
        branch_status TEXT NOT NULL DEFAULT '확인 필요',
        commit_status TEXT NOT NULL DEFAULT '커밋 없음',
        test_command TEXT,
        test_result TEXT NOT NULL DEFAULT '미실행',
        next_steps TEXT NOT NULL DEFAULT '미설정',
        last_worker_report TEXT,
        last_codex_review TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_project_events_project_seq
        ON project_events(project_id, seq);
    `);

    // 기존 DB 업그레이드 호환을 위한 컬럼 마이그레이션
    this.ensureColumn('requests', 'mode', "TEXT NOT NULL DEFAULT 'codex'");
    this.ensureColumn('requests', 'target_worker_id', 'TEXT');
    this.ensureColumn('requests', 'round', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('requests', 'pending_question', 'TEXT');
    this.ensureColumn('requests', 'pending_question_options_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('requests', 'user_replies_json', "TEXT NOT NULL DEFAULT '[]'");

    this.ensureColumn('delegations', 'round', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('delegations', 'summary_text', 'TEXT');
    this.ensureColumn('delegations', 'reviewed_at', 'TEXT');

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_project_reply_event
        ON delegations(project_id, reply_event_id) WHERE reply_event_id IS NOT NULL;
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (cols.some(col => asString(col.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  registerProject(input: RegisterProjectInput): { project: ProjectRecord; codex: CodexSessionRecord; defaultWorker: WorkerRecord; handoff: HandoffRecord } {
    return this.transaction(() => {
      const existing = this.findProjectByCommonDir(input.gitCommonDirKey) ?? this.findProjectByRootPath(input.rootPath);
      if (existing) {
        throw new Error(`이미 같은 프로젝트 폴더가 등록되어 있습니다 (${existing.name}, projectId=${existing.projectId}).`);
      }
      const now = nowIso();
      const projectId = input.projectId ?? randomUUID();
      const workerId = randomUUID();
      const workerName = input.defaultWorkerName?.trim() || '기본 워커';

      this.db.prepare(`
        INSERT INTO projects (project_id, name, root_path, git_common_dir, git_common_dir_raw, hcom_dir, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, input.name, input.rootPath, input.gitCommonDirKey, input.gitCommonDir, input.hcomDir, now, now);

      this.db.prepare(`
        INSERT INTO codex_sessions (project_id, cwd, thread_id, hcom_name, status, last_error, updated_at)
        VALUES (?, ?, NULL, NULL, 'stopped', NULL, ?)
      `).run(projectId, input.rootPath, now);

      this.db.prepare(`
        INSERT INTO workers (worker_id, project_id, request_key, name, is_default, cwd, hcom_name, conversation_id, status, last_error, created_at, updated_at)
        VALUES (?, ?, NULL, ?, 1, ?, NULL, NULL, 'stopped', NULL, ?, ?)
      `).run(workerId, projectId, workerName, input.rootPath, now, now);

      this.db.prepare(`
        INSERT INTO hcom_cursors (project_id, last_event_id, db_reset_required, updated_at)
        VALUES (?, 0, 0, ?)
      `).run(projectId, now);

      this.db.prepare(`
        INSERT INTO handoffs (project_id, goal, design_docs_json, branch_status, commit_status, test_command, test_result, next_steps, last_worker_report, last_codex_review, updated_at)
        VALUES (?, '미설정', '[]', ?, ?, NULL, '미실행', '미설정', NULL, NULL, ?)
      `).run(projectId, input.branchStatus || '확인 필요', input.commitStatus || '커밋 없음', now);

      const project = this.getProject(projectId)!;
      const codex = this.getCodexSession(projectId)!;
      const defaultWorker = this.getWorker(projectId, workerId)!;
      const handoff = this.getHandoff(projectId)!;
      return { project, codex, defaultWorker, handoff };
    });
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at ASC, project_id ASC').all() as Row[];
    return rows.map(mapProject);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as Row | undefined;
    return row ? mapProject(row) : undefined;
  }

  findProjectByCommonDir(gitCommonDirKey: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE git_common_dir = ?').get(gitCommonDirKey) as Row | undefined;
    return row ? mapProject(row) : undefined;
  }

  findProjectByRootPath(rootPath: string): ProjectRecord | undefined {
    const normalized = rootPath.replace(/[\\/]+$/, '').toLowerCase();
    return this.listProjects().find(project => project.rootPath.replace(/[\\/]+$/, '').toLowerCase() === normalized);
  }

  getSelectedProjectId(): string | null {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = 'selected_project_id'").get() as Row | undefined;
    return row ? asString(row.value) : null;
  }

  selectProject(projectId: string): ProjectRecord {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`등록되지 않은 프로젝트입니다: ${projectId}`);
    this.db.prepare(`
      INSERT INTO app_state (key, value) VALUES ('selected_project_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(projectId);
    return project;
  }

  getCodexSession(projectId: string): CodexSessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM codex_sessions WHERE project_id = ?').get(projectId) as Row | undefined;
    return row ? mapCodex(row) : undefined;
  }

  findCodexByThreadId(threadId: string): CodexSessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM codex_sessions WHERE thread_id = ?').get(threadId) as Row | undefined;
    return row ? mapCodex(row) : undefined;
  }

  updateCodexSession(
    projectId: string,
    patch: Partial<{ cwd: string; threadId: string | null; hcomName: string | null; status: CodexSessionStatus; lastError: string | null }>,
  ): CodexSessionRecord {
    return this.transaction(() => {
      const current = this.getCodexSession(projectId);
      if (!current) throw new Error(`프로젝트 Codex 세션이 없습니다: ${projectId}`);
      const nextThreadId = patch.threadId !== undefined ? patch.threadId : current.threadId;
      if (nextThreadId) {
        const owner = this.findCodexByThreadId(nextThreadId);
        if (owner && owner.projectId !== projectId) {
          throw new Error(`다른 프로젝트(${owner.projectId})에 귀속된 Codex 스레드 ID는 재사용할 수 없습니다.`);
        }
      }
      const next: CodexSessionRecord = {
        projectId,
        cwd: patch.cwd !== undefined ? patch.cwd : current.cwd,
        threadId: nextThreadId,
        hcomName: patch.hcomName !== undefined ? patch.hcomName : current.hcomName,
        status: patch.status !== undefined ? patch.status : current.status,
        lastError: patch.lastError !== undefined ? patch.lastError : current.lastError,
        updatedAt: nowIso(),
      };
      this.db.prepare(`
        UPDATE codex_sessions
        SET cwd = ?, thread_id = ?, hcom_name = ?, status = ?, last_error = ?, updated_at = ?
        WHERE project_id = ?
      `).run(next.cwd, next.threadId, next.hcomName, next.status, next.lastError, next.updatedAt, projectId);
      return next;
    });
  }

  listWorkers(projectId: string): WorkerRecord[] {
    const rows = this.db.prepare('SELECT * FROM workers WHERE project_id = ? ORDER BY is_default DESC, created_at ASC, worker_id ASC').all(projectId) as Row[];
    return rows.map(mapWorker);
  }

  getDefaultWorker(projectId: string): WorkerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workers WHERE project_id = ? AND is_default = 1').get(projectId) as Row | undefined;
    return row ? mapWorker(row) : undefined;
  }

  getWorker(projectId: string, workerId: string): WorkerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workers WHERE project_id = ? AND worker_id = ?').get(projectId, workerId) as Row | undefined;
    return row ? mapWorker(row) : undefined;
  }

  findWorkerByIdGlobal(workerId: string): WorkerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workers WHERE worker_id = ?').get(workerId) as Row | undefined;
    return row ? mapWorker(row) : undefined;
  }

  findWorkerByConversationId(conversationId: string): WorkerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workers WHERE conversation_id = ?').get(conversationId) as Row | undefined;
    return row ? mapWorker(row) : undefined;
  }

  findWorkerByHcomName(projectId: string, hcomName: string): WorkerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workers WHERE project_id = ? AND hcom_name = ?').get(projectId, hcomName) as Row | undefined;
    return row ? mapWorker(row) : undefined;
  }

  createAdditionalWorker(input: { projectId: string; name: string; requestKey: string; cwd: string }): { worker: WorkerRecord; created: boolean } {
    if (!input.name.trim()) throw new Error('워커 이름이 필요합니다.');
    if (!input.requestKey.trim()) throw new Error('워커 추가 요청 식별자(requestKey)가 필요합니다.');
    return this.transaction(() => {
      if (!this.getProject(input.projectId)) throw new Error(`등록되지 않은 프로젝트입니다: ${input.projectId}`);
      const existing = this.db.prepare('SELECT * FROM workers WHERE project_id = ? AND request_key = ?').get(input.projectId, input.requestKey) as Row | undefined;
      if (existing) return { worker: mapWorker(existing), created: false };
      const workerId = randomUUID();
      const now = nowIso();
      this.db.prepare(`
        INSERT INTO workers (worker_id, project_id, request_key, name, is_default, cwd, hcom_name, conversation_id, status, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, NULL, NULL, 'stopped', NULL, ?, ?)
      `).run(workerId, input.projectId, input.requestKey, input.name.trim(), input.cwd, now, now);
      return { worker: this.getWorker(input.projectId, workerId)!, created: true };
    });
  }

  updateWorker(
    projectId: string,
    workerId: string,
    patch: Partial<{ name: string; cwd: string; hcomName: string | null; conversationId: string | null; status: WorkerSessionStatus; lastError: string | null }>,
  ): WorkerRecord {
    return this.transaction(() => {
      const current = this.getWorker(projectId, workerId);
      if (!current) {
        const foreign = this.findWorkerByIdGlobal(workerId);
        if (foreign) throw new Error(`다른 프로젝트(${foreign.projectId}) 소속 워커입니다.`);
        throw new Error(`워커를 찾을 수 없습니다: ${workerId}`);
      }
      const nextConvId = patch.conversationId !== undefined ? patch.conversationId : current.conversationId;
      if (nextConvId) {
        const owner = this.findWorkerByConversationId(nextConvId);
        if (owner && (owner.projectId !== projectId || owner.workerId !== workerId)) {
          throw new Error(`다른 워커(${owner.projectId}/${owner.workerId})에 귀속된 대화 ID는 재사용할 수 없습니다.`);
        }
      }
      const next: WorkerRecord = {
        ...current,
        name: patch.name !== undefined ? patch.name : current.name,
        cwd: patch.cwd !== undefined ? patch.cwd : current.cwd,
        hcomName: patch.hcomName !== undefined ? patch.hcomName : current.hcomName,
        conversationId: nextConvId,
        status: patch.status !== undefined ? patch.status : current.status,
        lastError: patch.lastError !== undefined ? patch.lastError : current.lastError,
        updatedAt: nowIso(),
      };
      this.db.prepare(`
        UPDATE workers
        SET name = ?, cwd = ?, hcom_name = ?, conversation_id = ?, status = ?, last_error = ?, updated_at = ?
        WHERE project_id = ? AND worker_id = ?
      `).run(next.name, next.cwd, next.hcomName, next.conversationId, next.status, next.lastError, next.updatedAt, projectId, workerId);
      return next;
    });
  }

  acceptRequest(input: {
    projectId: string;
    requestId: string;
    prompt: string;
    mode?: RequestMode;
    targetWorkerId?: string | null;
  }): { request: RequestRecord; created: boolean } {
    if (!input.requestId.trim()) throw new Error('요청 ID(requestId)가 필요합니다.');
    if (!input.prompt.trim()) throw new Error('요청 내용이 비어 있습니다.');
    return this.transaction(() => {
      if (!this.getProject(input.projectId)) throw new Error(`등록되지 않은 프로젝트입니다: ${input.projectId}`);
      const existing = this.db.prepare('SELECT * FROM requests WHERE project_id = ? AND request_id = ?').get(input.projectId, input.requestId) as Row | undefined;
      if (existing) return { request: mapRequest(existing), created: false };
      const now = nowIso();
      this.db.prepare(`
        INSERT INTO requests (
          project_id, request_id, mode, target_worker_id, prompt, status, round,
          codex_turn_id, review_turn_id, pending_question, pending_question_options_json,
          user_replies_json, final_text, error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'accepted', 0, NULL, NULL, NULL, '[]', '[]', NULL, NULL, ?, ?)
      `).run(input.projectId, input.requestId, input.mode ?? 'codex', input.targetWorkerId ?? null, input.prompt, now, now);
      return { request: this.getRequest(input.projectId, input.requestId)!, created: true };
    });
  }

  getRequest(projectId: string, requestId: string): RequestRecord | undefined {
    const row = this.db.prepare('SELECT * FROM requests WHERE project_id = ? AND request_id = ?').get(projectId, requestId) as Row | undefined;
    return row ? mapRequest(row) : undefined;
  }

  listRequests(projectId: string): RequestRecord[] {
    const rows = this.db.prepare('SELECT * FROM requests WHERE project_id = ? ORDER BY created_at ASC, request_id ASC').all(projectId) as Row[];
    return rows.map(mapRequest);
  }

  updateRequest(
    projectId: string,
    requestId: string,
    patch: Partial<{
      status: RequestStatus;
      round: number;
      codexTurnId: string | null;
      reviewTurnId: string | null;
      pendingQuestion: string | null;
      pendingQuestionOptions: string[];
      userReplies: UserReplyEntry[];
      finalText: string | null;
      error: string | null;
    }>,
  ): RequestRecord {
    return this.transaction(() => {
      const current = this.getRequest(projectId, requestId);
      if (!current) throw new Error(`요청을 찾을 수 없습니다: ${projectId}/${requestId}`);
      const next: RequestRecord = {
        ...current,
        status: patch.status !== undefined ? patch.status : current.status,
        round: patch.round !== undefined ? patch.round : current.round,
        codexTurnId: patch.codexTurnId !== undefined ? patch.codexTurnId : current.codexTurnId,
        reviewTurnId: patch.reviewTurnId !== undefined ? patch.reviewTurnId : current.reviewTurnId,
        pendingQuestion: patch.pendingQuestion !== undefined ? patch.pendingQuestion : current.pendingQuestion,
        pendingQuestionOptions: patch.pendingQuestionOptions !== undefined ? patch.pendingQuestionOptions : current.pendingQuestionOptions,
        userReplies: patch.userReplies !== undefined ? patch.userReplies : current.userReplies,
        finalText: patch.finalText !== undefined ? patch.finalText : current.finalText,
        error: patch.error !== undefined ? patch.error : current.error,
        updatedAt: nowIso(),
      };
      this.db.prepare(`
        UPDATE requests
        SET status = ?, round = ?, codex_turn_id = ?, review_turn_id = ?,
            pending_question = ?, pending_question_options_json = ?, user_replies_json = ?,
            final_text = ?, error = ?, updated_at = ?
        WHERE project_id = ? AND request_id = ?
      `).run(
        next.status,
        next.round,
        next.codexTurnId,
        next.reviewTurnId,
        next.pendingQuestion,
        JSON.stringify(next.pendingQuestionOptions),
        JSON.stringify(next.userReplies),
        next.finalText,
        next.error,
        next.updatedAt,
        projectId,
        requestId,
      );
      return next;
    });
  }

  hasActiveRequest(projectId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS active FROM requests
      WHERE project_id = ? AND status IN ('accepted', 'codex_running', 'worker_working', 'codex_reviewing')
      LIMIT 1
    `).get(projectId) as Row | undefined;
    return Boolean(row);
  }

  createDelegation(input: {
    projectId: string;
    requestId: string;
    workerId: string;
    round?: number;
    toolCallId: string;
    requestEventId: number;
    prompt: string;
  }): DelegationRecord {
    return this.transaction(() => {
      const worker = this.getWorker(input.projectId, input.workerId);
      if (!worker) throw new Error('다른 프로젝트 소속이거나 존재하지 않는 워커에는 위임 기록을 만들 수 없습니다.');
      const delegationId = randomUUID();
      const now = nowIso();
      const round = input.round ?? (this.listDelegations(input.projectId, input.requestId).length + 1);
      this.db.prepare(`
        INSERT INTO delegations (
          delegation_id, project_id, request_id, worker_id, round, tool_call_id,
          request_event_id, reply_event_id, prompt, reply_text, summary_text, reviewed_at,
          status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 'sent', ?, ?)
      `).run(delegationId, input.projectId, input.requestId, input.workerId, round, input.toolCallId, input.requestEventId, input.prompt, now, now);
      const row = this.db.prepare('SELECT * FROM delegations WHERE delegation_id = ?').get(delegationId) as Row;
      return mapDelegation(row);
    });
  }

  findDelegationByReplyEventId(projectId: string, replyEventId: number): DelegationRecord | undefined {
    const row = this.db.prepare('SELECT * FROM delegations WHERE project_id = ? AND reply_event_id = ?').get(projectId, replyEventId) as Row | undefined;
    return row ? mapDelegation(row) : undefined;
  }

  claimDelegationReply(
    projectId: string,
    delegationId: string,
    replyEventId: number,
    replyText: string,
    summaryText: string,
  ): { claimed: boolean; delegation: DelegationRecord } {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM delegations WHERE project_id = ? AND delegation_id = ?').get(projectId, delegationId) as Row | undefined;
      if (!row) throw new Error(`위임 기록을 찾을 수 없습니다: ${projectId}/${delegationId}`);
      const current = mapDelegation(row);
      if (current.replyEventId !== null || current.reviewedAt !== null || current.status !== 'sent') {
        return { claimed: false, delegation: current };
      }
      const duplicate = this.findDelegationByReplyEventId(projectId, replyEventId);
      if (duplicate) {
        return { claimed: false, delegation: duplicate };
      }
      const now = nowIso();
      this.db.prepare(`
        UPDATE delegations
        SET reply_event_id = ?, reply_text = ?, summary_text = ?, status = 'replied', updated_at = ?
        WHERE project_id = ? AND delegation_id = ? AND reply_event_id IS NULL AND status = 'sent'
      `).run(replyEventId, replyText, summaryText, now, projectId, delegationId);
      const updated = mapDelegation(this.db.prepare('SELECT * FROM delegations WHERE delegation_id = ?').get(delegationId) as Row);
      return { claimed: updated.replyEventId === replyEventId, delegation: updated };
    });
  }

  updateDelegation(
    projectId: string,
    delegationId: string,
    patch: Partial<{ replyEventId: number | null; replyText: string | null; summaryText: string | null; reviewedAt: string | null; status: DelegationStatus }>,
  ): DelegationRecord {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM delegations WHERE project_id = ? AND delegation_id = ?').get(projectId, delegationId) as Row | undefined;
      if (!row) throw new Error(`위임 기록을 찾을 수 없습니다: ${projectId}/${delegationId}`);
      const current = mapDelegation(row);
      const next: DelegationRecord = {
        ...current,
        replyEventId: patch.replyEventId !== undefined ? patch.replyEventId : current.replyEventId,
        replyText: patch.replyText !== undefined ? patch.replyText : current.replyText,
        summaryText: patch.summaryText !== undefined ? patch.summaryText : current.summaryText,
        reviewedAt: patch.reviewedAt !== undefined ? patch.reviewedAt : current.reviewedAt,
        status: patch.status !== undefined ? patch.status : current.status,
        updatedAt: nowIso(),
      };
      this.db.prepare(`
        UPDATE delegations
        SET reply_event_id = ?, reply_text = ?, summary_text = ?, reviewed_at = ?, status = ?, updated_at = ?
        WHERE project_id = ? AND delegation_id = ?
      `).run(next.replyEventId, next.replyText, next.summaryText, next.reviewedAt, next.status, next.updatedAt, projectId, delegationId);
      return next;
    });
  }

  listDelegations(projectId: string, requestId?: string): DelegationRecord[] {
    const rows = (requestId
      ? this.db.prepare('SELECT * FROM delegations WHERE project_id = ? AND request_id = ? ORDER BY created_at ASC').all(projectId, requestId)
      : this.db.prepare('SELECT * FROM delegations WHERE project_id = ? ORDER BY created_at ASC').all(projectId)) as Row[];
    return rows.map(mapDelegation);
  }

  hasActiveDelegation(projectId: string, workerId?: string): boolean {
    const row = (workerId
      ? this.db.prepare("SELECT 1 AS active FROM delegations WHERE project_id = ? AND worker_id = ? AND status IN ('sent', 'replied') LIMIT 1").get(projectId, workerId)
      : this.db.prepare("SELECT 1 AS active FROM delegations WHERE project_id = ? AND status IN ('sent', 'replied') LIMIT 1").get(projectId)) as Row | undefined;
    return Boolean(row);
  }

  getCursor(projectId: string): HcomCursorRecord | undefined {
    const row = this.db.prepare('SELECT * FROM hcom_cursors WHERE project_id = ?').get(projectId) as Row | undefined;
    return row ? mapCursor(row) : undefined;
  }

  updateCursor(projectId: string, lastEventId: number): HcomCursorRecord {
    const now = nowIso();
    this.db.prepare(`
      UPDATE hcom_cursors
      SET last_event_id = CASE WHEN ? > last_event_id THEN ? ELSE last_event_id END, updated_at = ?
      WHERE project_id = ?
    `).run(lastEventId, lastEventId, now, projectId);
    const cursor = this.getCursor(projectId);
    if (!cursor) throw new Error(`프로젝트 커서가 없습니다: ${projectId}`);
    return cursor;
  }

  markDbReset(projectId: string): HcomCursorRecord {
    const now = nowIso();
    this.db.prepare('UPDATE hcom_cursors SET db_reset_required = 1, updated_at = ? WHERE project_id = ?').run(now, projectId);
    const cursor = this.getCursor(projectId);
    if (!cursor) throw new Error(`프로젝트 커서가 없습니다: ${projectId}`);
    return cursor;
  }

  getHandoff(projectId: string): HandoffRecord | undefined {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE project_id = ?').get(projectId) as Row | undefined;
    return row ? mapHandoff(row) : undefined;
  }

  updateHandoff(
    projectId: string,
    patch: Partial<{
      goal: string;
      designDocs: string[];
      branchStatus: string;
      commitStatus: string;
      testCommand: string | null;
      testResult: string;
      nextSteps: string;
      lastWorkerReport: string | null;
      lastCodexReview: string | null;
    }>,
  ): HandoffRecord {
    return this.transaction(() => {
      const current = this.getHandoff(projectId);
      if (!current) throw new Error(`프로젝트 인계 기록이 없습니다: ${projectId}`);
      const next: HandoffRecord = {
        projectId,
        goal: patch.goal !== undefined ? (patch.goal.trim() || '미설정') : current.goal,
        designDocs: patch.designDocs !== undefined ? [...patch.designDocs] : current.designDocs,
        branchStatus: patch.branchStatus !== undefined ? (patch.branchStatus.trim() || '확인 필요') : current.branchStatus,
        commitStatus: patch.commitStatus !== undefined ? (patch.commitStatus.trim() || '커밋 없음') : current.commitStatus,
        testCommand: patch.testCommand !== undefined ? patch.testCommand : current.testCommand,
        testResult: patch.testResult !== undefined ? (patch.testResult.trim() || '미실행') : current.testResult,
        nextSteps: patch.nextSteps !== undefined ? (patch.nextSteps.trim() || '미설정') : current.nextSteps,
        lastWorkerReport: patch.lastWorkerReport !== undefined ? patch.lastWorkerReport : current.lastWorkerReport,
        lastCodexReview: patch.lastCodexReview !== undefined ? patch.lastCodexReview : current.lastCodexReview,
        updatedAt: nowIso(),
      };
      this.db.prepare(`
        UPDATE handoffs
        SET goal = ?, design_docs_json = ?, branch_status = ?, commit_status = ?, test_command = ?, test_result = ?, next_steps = ?, last_worker_report = ?, last_codex_review = ?, updated_at = ?
        WHERE project_id = ?
      `).run(
        next.goal,
        JSON.stringify(next.designDocs),
        next.branchStatus,
        next.commitStatus,
        next.testCommand,
        next.testResult,
        next.nextSteps,
        next.lastWorkerReport,
        next.lastCodexReview,
        next.updatedAt,
        projectId,
      );
      return next;
    });
  }

  appendEvent(projectId: string, kind: string, payload: Record<string, unknown>): ProjectEventRecord {
    const now = nowIso();
    const result = this.db.prepare(`
      INSERT INTO project_events (project_id, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(projectId, kind, JSON.stringify(payload), now);
    return {
      seq: Number(result.lastInsertRowid),
      projectId,
      kind,
      payload,
      createdAt: now,
    };
  }

  listEvents(projectId: string, afterSeq = 0): ProjectEventRecord[] {
    const rows = this.db.prepare('SELECT * FROM project_events WHERE project_id = ? AND seq > ? ORDER BY seq ASC').all(projectId, afterSeq) as Row[];
    return rows.map(mapEvent);
  }

  close(): void {
    this.db.close();
  }
}
