export {};

interface BridgeConfig {
  baseUrl: string;
  token: string;
  version: string;
  dataDir: string;
}

interface HcomGuiBridge {
  getConfig(): Promise<BridgeConfig>;
  pickFolder(): Promise<string | null>;
  pickInstallerAndUpdate(): Promise<{ launched: boolean; cancelled?: boolean; error?: string }>;
}

declare global {
  interface Window {
    hcomGui?: HcomGuiBridge;
  }
}

interface ModelOption {
  id: string;
  displayName: string;
  efforts: string[];
  defaultEffort: string | null;
  isDefault: boolean;
}

interface ModelCatalog {
  codex: ModelOption[];
  agy: ModelOption[];
  cachedAt: string;
}

interface ProjectRecord {
  projectId: string;
  name: string;
  rootPath: string;
  hcomDir: string;
}

interface CodexRecord {
  projectId: string;
  cwd: string;
  threadId: string | null;
  hcomName: string | null;
  model: string | null;
  reasoningEffort: string | null;
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  status: string;
  lastError: string | null;
}

interface WorkerRecord {
  workerId: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  cwd: string;
  hcomName: string | null;
  conversationId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  permissionMode: 'always-proceed' | 'ask' | 'read-only';
  status: string;
  lastError: string | null;
}

interface HandoffRecord {
  projectId: string;
  goal: string;
  designDocs: string[];
  branchStatus: string;
  commitStatus: string;
  testCommand: string | null;
  testResult: string;
  nextSteps: string;
  lastWorkerReport: string | null;
  lastCodexReview: string | null;
}

interface ProjectSnapshot {
  project: ProjectRecord;
  codex: CodexRecord;
  workers: WorkerRecord[];
  handoff: HandoffRecord;
  selected: boolean;
}

interface UserReplyEntry {
  replyKey: string;
  question: string;
  answer: string;
  createdAt: string;
}

interface PendingApprovalRecord {
  workerId: string;
  workerName: string;
  hcomName: string;
  context: string;
  detail: string;
  detectedAt: string;
}

interface ProgressLogEntry {
  ts: string;
  source: 'codex' | 'worker';
  kind: string;
  summary: string;
  detail?: string;
}

interface RequestRecord {
  projectId: string;
  requestId: string;
  mode: 'codex' | 'direct_worker';
  targetWorkerId: string | null;
  prompt: string;
  status: string;
  round: number;
  codexTurnId: string | null;
  reviewTurnId: string | null;
  pendingQuestion: string | null;
  pendingQuestionOptions: string[];
  pendingApproval: PendingApprovalRecord | null;
  userReplies: UserReplyEntry[];
  progressSummary: ProgressLogEntry[];
  finalText: string | null;
  error: string | null;
}

interface DelegationRecord {
  delegationId: string;
  requestId: string;
  workerId: string;
  round: number;
  requestEventId: number | null;
  replyEventId: number | null;
  prompt: string;
  replyText: string | null;
  summaryText: string | null;
  status: string;
}

interface HcomMessageItem {
  seq: number;
  eventId: number;
  from: string;
  intent: string | null;
  replyTo: string | null;
  deliveredTo: string[];
  text: string;
  createdAt: string;
}

interface WorkerLogsState {
  progress: ProgressLogEntry[];
  transcript: unknown;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
}

interface CliCheck {
  ok: boolean;
  path: string | null;
  version: string | null;
  error?: string;
}

interface CliDiagnostics {
  codex: CliCheck;
  hcom: CliCheck;
  agy: CliCheck;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const FALLBACK_MODELS: ModelCatalog = {
  codex: [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', isDefault: true },
    { id: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low', isDefault: false },
  ],
  agy: [
    { id: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', isDefault: true },
    { id: 'gemini-4-carbon-high', displayName: 'Gemini 4 Carbon (High)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', isDefault: false },
    { id: 'claude-sonnet-5-5-high', displayName: 'Claude Sonnet 5.5 (High)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', isDefault: false },
  ],
  cachedAt: '',
};

const EFFORT_LABELS: Record<string, string> = {
  low: '빠름 (low)',
  medium: '균형 (medium)',
  high: '깊음 (high)',
  xhigh: '매우 깊음 (xhigh)',
  max: '최대 (max)',
  ultra: '울트라 (ultra)',
};

const PERMISSION_SHORT_LABELS: Record<string, string> = {
  'always-proceed': '자동진행',
  ask: '매번승인',
  'read-only': '읽기전용',
};

const ACTIVE_REQUEST_STATUSES = new Set([
  'accepted',
  'codex_running',
  'worker_working',
  'codex_reviewing',
  'waiting_approval',
]);

const state = {
  config: { baseUrl: window.location.origin, token: '', version: '1.0.0', dataDir: '' } as BridgeConfig,
  projects: [] as ProjectSnapshot[],
  selectedProjectId: null as string | null,
  activeDetail: null as {
    snapshot: ProjectSnapshot;
    requests: RequestRecord[];
    delegations: DelegationRecord[];
    progressByRequest: Record<string, ProgressLogEntry[]>;
    hcomMessages: HcomMessageItem[];
    latestSeq: number;
  } | null,
  models: FALLBACK_MODELS as ModelCatalog,
  diagnostics: null as CliDiagnostics | null,
  eventSource: null as EventSource | null,
  addWorkerTargetProjectId: null as string | null,
  expandedWorkers: new Set<string>(),
  expandedRequestLogs: new Set<string>(),
  workerLogs: new Map<string, WorkerLogsState>(),
  workerLatestProgress: new Map<string, ProgressLogEntry>(),
  workerChatDrafts: new Map<string, string>(),
  questionDrafts: new Map<string, string>(),
  dirtyWhileHidden: false,
  dirtyRequestSlots: new Set<string>(),
  dirtyWorkerSlots: new Set<string>(),
  dirtyHcom: false,
  partialRenderTimer: null as number | null,
  refreshTimer: null as number | null,
  refreshInFlight: false,
  refreshQueuedProjectId: null as string | null,
};

function statusDotClass(status: string): string {
  if (status === 'ready' || status === 'completed') return 'dot-ready';
  if (status === 'starting' || status === 'running' || status === 'working' || status === 'needs_attention' || status === 'waiting_approval') return 'dot-working';
  if (status === 'error' || status === 'failed') return 'dot-error';
  return 'dot-stopped';
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    stopped: '중지',
    starting: '시작 중',
    ready: '준비',
    running: '실행 중',
    working: '작업 중',
    needs_attention: '조치 필요',
    disconnected: '연결 끊김',
    error: '오류',
    accepted: '접수',
    codex_running: 'Codex 판단',
    worker_working: '워커 작업 중',
    codex_reviewing: 'Codex 검수',
    waiting_user: '사용자 답변 대기',
    waiting_approval: '워커 승인 대기',
    completed: '완료',
    failed: '실패',
    timed_out: '시간 초과',
    cancelled: '취소됨',
    interrupted: '중단',
    needs_verification: '확인 필요',
  };
  return labels[status] ?? status;
}

function progressKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    reasoning: '추론',
    reasoning_done: '추론 요약',
    commentary: '진행 설명',
    command: '명령',
    command_start: '명령 시작',
    command_output: '명령 출력',
    command_done: '명령 완료',
    fileChange: '파일',
    file_change: '파일 변경',
    answer_streaming: '답변 작성',
    tool: '도구',
    status: '상태',
    message: '메시지',
    approval: '승인',
  };
  return labels[kind] ?? kind;
}

function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function shortTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toTimeString().slice(0, 8);
  } catch {
    return '';
  }
}

function shortModelLabel(modelId: string | null, catalog: ModelOption[]): string {
  if (!modelId) return '기본 모델';
  const match = catalog.find(m => m.id === modelId);
  return match ? match.displayName : modelId;
}

function clearChildren(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function showNotice(text: string | null, isError = false): void {
  const box = el<HTMLDivElement>('bannerNotice');
  if (!text) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.textContent = text;
  box.classList.toggle('error', isError);
  box.classList.remove('hidden');
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'x-hcom-token': state.config.token,
    ...(init?.body ? { 'content-type': 'application/json' } : {}),
  };
  const res = await fetch(`${state.config.baseUrl}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `요청 실패 (${res.status})`);
  }
  return data as T;
}

function populateModelSelect(select: HTMLSelectElement, options: ModelOption[], currentValue: string | null, defaultLabel = '기본값 (CLI 기본)'): void {
  clearChildren(select);
  const def = document.createElement('option');
  def.value = '';
  def.textContent = defaultLabel;
  select.appendChild(def);

  let found = !currentValue;
  for (const item of options) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.isDefault ? `${item.displayName} (기본)` : item.displayName;
    select.appendChild(opt);
    if (item.id === currentValue) found = true;
  }
  if (currentValue && !found) {
    const custom = document.createElement('option');
    custom.value = currentValue;
    custom.textContent = currentValue;
    select.appendChild(custom);
  }
  select.value = currentValue ?? '';
}

function effortsForModel(options: ModelOption[], modelId: string | null): string[] {
  const matched = modelId ? options.find(m => m.id === modelId) : options.find(m => m.isDefault) ?? options[0];
  return matched && matched.efforts.length > 0 ? matched.efforts : ['low', 'medium', 'high', 'xhigh', 'max'];
}

function populateEffortSelect(select: HTMLSelectElement, efforts: string[], currentValue: string | null): void {
  clearChildren(select);
  const def = document.createElement('option');
  def.value = '';
  def.textContent = '기본 추론';
  select.appendChild(def);

  let found = !currentValue;
  for (const eff of efforts) {
    const opt = document.createElement('option');
    opt.value = eff;
    opt.textContent = EFFORT_LABELS[eff] ?? eff;
    select.appendChild(opt);
    if (eff === currentValue) found = true;
  }
  if (currentValue && !found) {
    const custom = document.createElement('option');
    custom.value = currentValue;
    custom.textContent = currentValue;
    select.appendChild(custom);
  }
  select.value = currentValue ?? '';
}

function renderDiagnostics(): void {
  const diag = state.diagnostics;
  const dot = el<HTMLSpanElement>('diagDot');
  const summary = el<HTMLSpanElement>('diagSummary');
  const mini = el<HTMLDivElement>('cliMiniList');
  const detail = el<HTMLDivElement>('diagnosticsDetail');
  clearChildren(mini);
  clearChildren(detail);
  if (!diag) return;

  const entries: Array<[string, CliCheck]> = [
    ['Codex', diag.codex],
    ['hcom', diag.hcom],
    ['agy', diag.agy],
  ];
  const allOk = entries.every(([, item]) => item.ok);
  dot.className = `status-dot ${allOk ? 'dot-ready' : 'dot-working'}`;
  summary.textContent = allOk ? 'CLI 준비됨' : 'CLI 점검 필요';

  for (const [name, item] of entries) {
    const chip = document.createElement('span');
    chip.className = 'pill pill-subtle';
    const d = document.createElement('span');
    d.className = `status-dot ${item.ok ? 'dot-ready' : 'dot-error'}`;
    const label = document.createElement('span');
    label.textContent = name;
    chip.append(d, label);
    mini.appendChild(chip);

    const box = document.createElement('div');
    box.className = 'meta-box';
    const title = document.createElement('span');
    title.className = 'meta-label';
    title.textContent = `${name} · ${item.ok ? '정상' : '확인 필요'}`;
    const ver = document.createElement('span');
    ver.className = 'meta-value mono-text';
    ver.textContent = item.ok ? `${item.version ?? ''} (${item.path ?? ''})` : (item.error ?? '미설치');
    box.append(title, ver);
    detail.appendChild(box);
  }
}

function renderProjectList(): void {
  const container = el<HTMLDivElement>('projectList');
  clearChildren(container);
  if (state.projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted-text';
    empty.style.padding = '12px 6px';
    empty.textContent = '등록된 프로젝트가 없습니다.';
    container.appendChild(empty);
    return;
  }

  for (const snap of state.projects) {
    const btn = document.createElement('button');
    btn.className = `project-item${snap.project.projectId === state.selectedProjectId ? ' active' : ''}`;
    btn.dataset.projectId = snap.project.projectId;
    btn.addEventListener('click', () => { void selectProject(snap.project.projectId); });

    const top = document.createElement('div');
    top.className = 'project-item-row';
    const name = document.createElement('span');
    name.className = 'project-item-name';
    name.textContent = snap.project.name;
    const dot = document.createElement('span');
    dot.className = `status-dot ${statusDotClass(snap.codex.status)}`;
    dot.title = `Codex: ${statusLabel(snap.codex.status)}`;
    top.append(name, dot);

    const sub = document.createElement('div');
    sub.className = 'project-item-sub';
    const branch = document.createElement('span');
    branch.className = 'mono-text truncate';
    branch.textContent = snap.handoff.branchStatus;
    const workerCount = document.createElement('span');
    const activeWorkers = snap.workers.filter(w => w.status === 'ready' || w.status === 'working').length;
    workerCount.textContent = `워커 ${activeWorkers}/${snap.workers.length}`;
    sub.append(branch, workerCount);

    btn.append(top, sub);
    container.appendChild(btn);
  }
}

function renderHeaderAndBar(): void {
  const detail = state.activeDetail;
  const headerName = el<HTMLSpanElement>('headerProjectName');
  const branchBadge = el<HTMLSpanElement>('headerBranchBadge');
  const isoBadge = el<HTMLSpanElement>('headerIsolationBadge');
  const projectBar = el<HTMLDivElement>('projectBar');
  const emptyState = el<HTMLDivElement>('emptyState');
  const feed = el<HTMLDivElement>('messageFeed');
  const hcomStrip = el<HTMLElement>('hcomStrip');
  const input = el<HTMLTextAreaElement>('promptInput');
  const sendBtn = el<HTMLButtonElement>('sendBtn');
  const targetSelect = el<HTMLSelectElement>('composerTargetSelect');
  const targetTag = el<HTMLSpanElement>('targetProjectTag');
  const hint = el<HTMLSpanElement>('composerHint');
  const addWorkerBtn = el<HTMLButtonElement>('openAddWorkerBtn');
  const saveHandoffBtn = el<HTMLButtonElement>('saveHandoffBtn');

  if (!detail) {
    headerName.textContent = '프로젝트를 선택하세요';
    branchBadge.classList.add('hidden');
    isoBadge.classList.add('hidden');
    projectBar.classList.add('hidden');
    emptyState.classList.remove('hidden');
    feed.classList.add('hidden');
    hcomStrip.classList.add('hidden');
    input.disabled = true;
    sendBtn.disabled = true;
    targetSelect.disabled = true;
    targetTag.classList.add('hidden');
    hint.textContent = '프로젝트를 먼저 선택하세요';
    addWorkerBtn.disabled = true;
    saveHandoffBtn.disabled = true;
    return;
  }

  const { project, codex, handoff, workers } = detail.snapshot;
  headerName.textContent = project.name;
  branchBadge.textContent = handoff.branchStatus;
  branchBadge.classList.remove('hidden');
  isoBadge.textContent = `격리 ID · ${project.projectId.slice(0, 8)}`;
  isoBadge.title = `HCOM_DIR: ${project.hcomDir}`;
  isoBadge.classList.remove('hidden');

  projectBar.classList.remove('hidden');
  el<HTMLDivElement>('projectPathText').textContent = codex.cwd;
  el<HTMLSpanElement>('codexStatusChip').textContent = `Codex · ${statusLabel(codex.status)}`;

  const threadChip = el<HTMLSpanElement>('threadIdChip');
  if (codex.threadId) {
    threadChip.textContent = `thread ${shortId(codex.threadId)}`;
    threadChip.title = codex.threadId;
    threadChip.classList.remove('hidden');
  } else {
    threadChip.classList.add('hidden');
  }

  const hcomChip = el<HTMLSpanElement>('hcomDirChip');
  hcomChip.textContent = `hcom ${codex.hcomName ?? '대기'}`;
  hcomChip.title = project.hcomDir;
  hcomChip.classList.remove('hidden');

  // Codex 모델 · 추론 속도 · 권한 셀렉터 동기화
  const codexModelSelect = el<HTMLSelectElement>('codexModelSelect');
  const codexEffortSelect = el<HTMLSelectElement>('codexEffortSelect');
  const codexSandboxSelect = el<HTMLSelectElement>('codexSandboxSelect');
  if (document.activeElement !== codexModelSelect) {
    populateModelSelect(codexModelSelect, state.models.codex, codex.model);
  }
  if (document.activeElement !== codexEffortSelect) {
    populateEffortSelect(codexEffortSelect, effortsForModel(state.models.codex, codex.model), codex.reasoningEffort);
  }
  if (document.activeElement !== codexSandboxSelect) {
    codexSandboxSelect.value = codex.sandboxMode ?? 'workspace-write';
  }

  emptyState.classList.add('hidden');
  feed.classList.remove('hidden');
  hcomStrip.classList.remove('hidden');

  const prevTarget = targetSelect.value || 'codex';
  clearChildren(targetSelect);
  const codexOpt = document.createElement('option');
  codexOpt.value = 'codex';
  codexOpt.textContent = 'Codex (오케스트레이터)';
  targetSelect.appendChild(codexOpt);
  for (const w of workers) {
    const opt = document.createElement('option');
    opt.value = `worker:${w.workerId}`;
    opt.textContent = `직접 전송 · ${w.name}`;
    targetSelect.appendChild(opt);
  }
  const hasPrev = [...targetSelect.options].some(o => o.value === prevTarget);
  targetSelect.value = hasPrev ? prevTarget : 'codex';
  targetSelect.disabled = false;

  input.disabled = false;
  sendBtn.disabled = false;
  targetTag.textContent = `대상: ${project.name}`;
  targetTag.classList.remove('hidden');
  hint.textContent = targetSelect.value === 'codex'
    ? 'Enter 전송 · Shift+Enter 줄바꿈 · Codex 검수/재지시 자동 연결'
    : 'Enter 전송 · 선택한 워커에게 hcom으로 직접 메시지 전송';
  addWorkerBtn.disabled = false;
  saveHandoffBtn.disabled = false;
}

function renderPipeline(req: RequestRecord): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'stage-pipeline';

  if (req.mode === 'direct_worker') {
    const directTag = document.createElement('span');
    directTag.className = 'stage-step done';
    directTag.textContent = '워커 직접 전송';
    wrap.appendChild(directTag);
  }

  const roundSuffix = req.round > 1 ? ` · ${req.round}차` : '';
  const steps: Array<[string, string]> = req.mode === 'direct_worker'
    ? [
      ['accepted', '접수'],
      ['worker_working', '워커 작업 중'],
      ['completed', '완료'],
    ]
    : [
      ['accepted', '접수'],
      ['codex_running', 'Codex 판단'],
      ['worker_working', `워커 작업 중${roundSuffix}`],
      ['codex_reviewing', `Codex 검수${roundSuffix}`],
      ['completed', '완료'],
    ];

  const order = steps.map(([key]) => key);
  const currentIdx = order.indexOf(req.status);
  for (let i = 0; i < steps.length; i++) {
    const [, label] = steps[i]!;
    const span = document.createElement('span');
    span.className = 'stage-step';
    if (currentIdx >= 0) {
      if (i === currentIdx) span.classList.add('current');
      else if (i < currentIdx) span.classList.add('done');
    }
    span.textContent = label;
    wrap.appendChild(span);
  }

  if (currentIdx < 0) {
    const badge = document.createElement('span');
    const variant = req.status === 'waiting_user' || req.status === 'waiting_approval'
      ? 'waiting'
      : req.status === 'timed_out'
        ? 'timeout'
        : req.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    badge.className = `stage-step ${variant}`;
    badge.textContent = statusLabel(req.status);
    wrap.appendChild(badge);
  }
  return wrap;
}

function getRequestProgressEntries(req: RequestRecord): ProgressLogEntry[] {
  const live = state.activeDetail?.progressByRequest[req.requestId];
  if (live && live.length > 0) return live;
  return req.progressSummary ?? [];
}

function buildThinkingBox(req: RequestRecord): HTMLElement {
  const entries = getRequestProgressEntries(req);
  const isActive = ACTIVE_REQUEST_STATUSES.has(req.status);
  const isExpanded = state.expandedRequestLogs.has(req.requestId);
  const latest = entries.at(-1);

  const box = document.createElement('div');
  box.className = 'thinking-box';
  box.dataset.requestThinking = req.requestId;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'thinking-toggle';
  toggle.addEventListener('click', () => {
    if (state.expandedRequestLogs.has(req.requestId)) {
      state.expandedRequestLogs.delete(req.requestId);
    } else {
      state.expandedRequestLogs.add(req.requestId);
    }
    patchRequestThinkingSlot(req.requestId);
  });

  const left = document.createElement('div');
  left.className = 'thinking-left';
  const dot = document.createElement('span');
  dot.className = `thinking-dot ${isActive ? 'active' : (req.status === 'completed' ? 'done' : '')}`;
  const summary = document.createElement('span');
  summary.className = 'thinking-summary';
  summary.textContent = latest
    ? latest.summary
    : (isActive ? `${statusLabel(req.status)} 중...` : `${statusLabel(req.status)} · 기록된 생각 로그 없음`);
  left.append(dot, summary);

  const right = document.createElement('div');
  right.className = 'thinking-right';
  const countSpan = document.createElement('span');
  countSpan.textContent = entries.length > 0 ? `로그 ${entries.length}` : '상세';
  const chevron = document.createElement('span');
  chevron.textContent = isExpanded ? '▴' : '▾';
  right.append(countSpan, chevron);

  toggle.append(left, right);
  box.appendChild(toggle);

  if (isExpanded) {
    const panel = document.createElement('div');
    panel.className = 'thinking-log-panel';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted-text';
      empty.textContent = isActive
        ? 'AI 추론 및 도구 실행 로그를 수신 대기 중입니다...'
        : '저장된 추론·도구 로그가 없습니다.';
      panel.appendChild(empty);
    } else {
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'thinking-log-row';
        const meta = document.createElement('div');
        meta.className = 'thinking-log-meta';
        const src = document.createElement('span');
        src.textContent = `${entry.source === 'codex' ? 'Codex' : '워커'} · ${progressKindLabel(entry.kind)}`;
        const time = document.createElement('span');
        time.textContent = shortTime(entry.ts);
        meta.append(src, time);

        const sum = document.createElement('div');
        sum.className = 'thinking-log-summary';
        sum.textContent = entry.summary;
        row.append(meta, sum);

        if (entry.detail && entry.detail.trim() && entry.detail.trim() !== entry.summary.trim()) {
          const det = document.createElement('div');
          det.className = 'thinking-log-detail';
          det.textContent = entry.detail;
          row.appendChild(det);
        }
        panel.appendChild(row);
      }
      panel.scrollTop = panel.scrollHeight;
    }
    box.appendChild(panel);
  }
  return box;
}

function patchRequestThinkingSlot(requestId: string): void {
  const detail = state.activeDetail;
  if (!detail) return;
  const req = detail.requests.find(r => r.requestId === requestId);
  if (!req) return;
  const existing = document.querySelector<HTMLElement>(`[data-request-thinking="${CSS.escape(requestId)}"]`);
  if (!existing || !existing.parentElement) return;
  const replacement = buildThinkingBox(req);
  existing.parentElement.replaceChild(replacement, existing);
}

function renderMessages(): void {
  const feed = el<HTMLDivElement>('messageFeed');
  const scroller = el<HTMLElement>('conversationScroll');
  const wasNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 64;
  clearChildren(feed);
  const detail = state.activeDetail;
  if (!detail) return;

  if (detail.requests.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'assistant-card';
    const title = document.createElement('strong');
    title.textContent = `${detail.snapshot.project.name} 세션 준비`;
    const desc = document.createElement('div');
    desc.className = 'muted-text';
    desc.textContent = '상단에서 Codex 모델·추론 속도·권한을 선택하고 "시작 / 재개" 버튼으로 세션을 열거나, 아래 입력창에 바로 지시를 보낼 수 있습니다.';
    placeholder.append(title, desc);
    feed.appendChild(placeholder);
    return;
  }

  const projectId = detail.snapshot.project.projectId;
  const workerById = new Map(detail.snapshot.workers.map(w => [w.workerId, w]));
  for (const req of detail.requests) {
    const group = document.createElement('div');
    group.className = 'request-group';

    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.textContent = req.prompt;
    group.appendChild(bubble);

    const card = document.createElement('div');
    card.className = 'assistant-card';

    const header = document.createElement('div');
    header.className = 'assistant-header';
    header.appendChild(renderPipeline(req));
    const rightMeta = document.createElement('div');
    rightMeta.className = 'assistant-header-right';
    const isCancellable = ['accepted', 'codex_running', 'worker_working', 'codex_reviewing', 'waiting_user', 'waiting_approval'].includes(req.status);
    if (isCancellable) {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-subtle btn-xs';
      cancelBtn.type = 'button';
      cancelBtn.textContent = '취소';
      cancelBtn.addEventListener('click', () => { void handleCancelRequest(projectId, req.requestId); });
      rightMeta.appendChild(cancelBtn);
    }
    const reqTag = document.createElement('span');
    reqTag.className = 'mono-text muted-text';
    reqTag.textContent = shortId(req.requestId);
    rightMeta.appendChild(reqTag);
    header.appendChild(rightMeta);
    card.appendChild(header);

    // Codex 스타일 간략 추론 설명 + 화살표 펼침 상세 로그
    card.appendChild(buildThinkingBox(req));

    // 원격 워커 승인 대기 복구 카드
    if (req.status === 'waiting_approval' && req.pendingApproval) {
      const approval = req.pendingApproval;
      const appBox = document.createElement('div');
      appBox.className = 'approval-box';
      const appTitle = document.createElement('div');
      appTitle.className = 'approval-title';
      appTitle.textContent = `워커(${approval.workerName}) 승인 대기 중 · ${approval.context || '명령/도구 실행 확인'}`;
      appBox.appendChild(appTitle);

      if (approval.detail) {
        const appDet = document.createElement('div');
        appDet.className = 'approval-detail';
        appDet.textContent = approval.detail;
        appBox.appendChild(appDet);
      }

      const appActions = document.createElement('div');
      appActions.className = 'approval-actions';
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'btn btn-primary btn-xs';
      approveBtn.textContent = '승인하고 계속';
      approveBtn.addEventListener('click', () => { void handleResolveApproval(projectId, req.requestId, 'approve'); });
      const denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.className = 'btn btn-outline btn-xs';
      denyBtn.textContent = '거절';
      denyBtn.addEventListener('click', () => { void handleResolveApproval(projectId, req.requestId, 'deny'); });
      appActions.append(approveBtn, denyBtn);
      appBox.appendChild(appActions);
      card.appendChild(appBox);
    }

    const reqDelegations = detail.delegations.filter(d => d.requestId === req.requestId);
    for (const del of reqDelegations) {
      const worker = workerById.get(del.workerId);
      const box = document.createElement('div');
      box.className = 'delegation-box';
      const title = document.createElement('div');
      title.className = 'delegation-title';
      const left = document.createElement('span');
      left.textContent = `hcom ${req.mode === 'direct_worker' ? '직접 전달' : `위임 ${del.round}차`} → ${worker?.name ?? shortId(del.workerId)}`;
      const right = document.createElement('span');
      right.className = 'mono-text';
      right.textContent = `요청 #${del.requestEventId ?? '-'}${del.replyEventId ? ` · 회신 #${del.replyEventId}` : ''}`;
      title.append(left, right);
      box.appendChild(title);

      const reply = document.createElement('div');
      reply.className = 'delegation-reply';
      reply.textContent = del.replyText
        ? del.replyText
        : del.status === 'cancelled'
          ? '취소된 작업입니다.'
          : del.status === 'timed_out'
            ? '워커 회신 시간이 초과되었습니다.'
            : '워커 회신 대기 중...';
      box.appendChild(reply);
      card.appendChild(box);
    }

    for (const entry of req.userReplies) {
      const note = document.createElement('div');
      note.className = 'user-reply-note';
      note.textContent = `Q. ${entry.question}\nA. ${entry.answer}`;
      card.appendChild(note);
    }

    if (req.status === 'waiting_user' && req.pendingQuestion) {
      const qBox = document.createElement('div');
      qBox.className = 'question-box';
      const qTitle = document.createElement('div');
      qTitle.className = 'question-title';
      qTitle.textContent = '사용자 판단 필요 · 답변하면 같은 요청에서 이어집니다';
      const qText = document.createElement('div');
      qText.className = 'question-text';
      qText.textContent = req.pendingQuestion;
      qBox.append(qTitle, qText);

      if (req.pendingQuestionOptions.length > 0) {
        const optWrap = document.createElement('div');
        optWrap.className = 'question-options';
        for (const opt of req.pendingQuestionOptions) {
          const optBtn = document.createElement('button');
          optBtn.className = 'btn btn-outline btn-xs';
          optBtn.type = 'button';
          optBtn.textContent = opt;
          optBtn.addEventListener('click', () => { void handleReplyToRequest(projectId, req.requestId, opt); });
          optWrap.appendChild(optBtn);
        }
        qBox.appendChild(optWrap);
      }

      const replyRow = document.createElement('div');
      replyRow.className = 'question-reply-row';
      const replyInput = document.createElement('input');
      replyInput.className = 'input';
      replyInput.type = 'text';
      replyInput.placeholder = '판단 내용을 입력하고 Enter 또는 버튼을 누르세요';
      replyInput.value = state.questionDrafts.get(req.requestId) ?? '';
      replyInput.addEventListener('input', () => {
        state.questionDrafts.set(req.requestId, replyInput.value);
      });
      const replyBtn = document.createElement('button');
      replyBtn.className = 'btn btn-primary btn-xs';
      replyBtn.type = 'button';
      replyBtn.textContent = '답변하고 계속';
      const submitAnswer = () => {
        const ans = replyInput.value.trim();
        if (!ans) return;
        replyInput.value = '';
        state.questionDrafts.delete(req.requestId);
        void handleReplyToRequest(projectId, req.requestId, ans);
      };
      replyBtn.addEventListener('click', submitAnswer);
      replyInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          submitAnswer();
        }
      });
      replyRow.append(replyInput, replyBtn);
      qBox.appendChild(replyRow);
      card.appendChild(qBox);
    } else if (req.finalText) {
      const body = document.createElement('div');
      body.className = 'assistant-body';
      body.textContent = req.finalText;
      card.appendChild(body);
    } else if (req.error) {
      const err = document.createElement('div');
      err.className = 'assistant-error';
      err.textContent = `[${statusLabel(req.status)}] ${req.error}`;
      card.appendChild(err);
    } else if (req.status !== 'waiting_approval') {
      const pending = document.createElement('div');
      pending.className = 'muted-text';
      pending.textContent = `${statusLabel(req.status)} 진행 중...`;
      card.appendChild(pending);
    }

    group.appendChild(card);
    feed.appendChild(group);
  }

  if (wasNearBottom) {
    scroller.scrollTop = scroller.scrollHeight;
  }
}

function renderHcomMessages(): void {
  const detail = state.activeDetail;
  const count = el<HTMLSpanElement>('hcomLogCount');
  const list = el<HTMLDivElement>('hcomLogList');
  clearChildren(list);
  const items = detail?.hcomMessages ?? [];
  count.textContent = String(items.length);

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted-text';
    empty.textContent = '이 프로젝트의 hcom 메시지가 아직 없습니다.';
    list.appendChild(empty);
    return;
  }

  for (const item of items.slice(-30).reverse()) {
    const row = document.createElement('div');
    row.className = 'hcom-log-item';
    const meta = document.createElement('div');
    meta.className = 'hcom-log-meta';
    const route = document.createElement('span');
    route.textContent = `#${item.eventId} ${item.from} → ${item.deliveredTo.join(', ') || '-'}`;
    const intent = document.createElement('span');
    intent.textContent = `${item.intent ?? 'message'}${item.replyTo ? ` (reply #${item.replyTo})` : ''}`;
    meta.append(route, intent);

    const text = document.createElement('div');
    text.textContent = item.text;
    row.append(meta, text);
    list.appendChild(row);
  }
}

function extractTranscriptEntries(transcript: unknown): Array<{ label: string; time: string; text: string }> {
  const out: Array<{ label: string; time: string; text: string }> = [];
  const rawList = Array.isArray(transcript)
    ? transcript
    : (transcript && typeof transcript === 'object' && Array.isArray((transcript as Record<string, unknown>).exchanges))
      ? (transcript as Record<string, unknown>).exchanges as unknown[]
      : [];

  for (const item of rawList.slice(-10)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const ts = typeof obj.timestamp === 'string' ? shortTime(obj.timestamp) : '';
    const userText = typeof obj.user === 'string' ? obj.user.trim() : '';
    const action = typeof obj.action === 'string' ? obj.action.trim() : '';
    const assistantText = typeof obj.assistant === 'string' ? obj.assistant.trim() : '';
    const tools = Array.isArray(obj.tools) ? obj.tools : [];
    const edits = Array.isArray(obj.edits) ? obj.edits : [];
    const errors = Array.isArray(obj.errors) ? obj.errors : [];

    if (userText) {
      out.push({ label: '요청', time: ts, text: userText.slice(0, 260) });
    }
    for (const tool of tools.slice(0, 6)) {
      if (tool && typeof tool === 'object') {
        const t = tool as Record<string, unknown>;
        const tName = typeof t.name === 'string' ? t.name : 'tool';
        const tDetail = typeof t.input === 'string'
          ? t.input
          : (typeof t.command === 'string' ? t.command : (typeof t.output === 'string' ? t.output : ''));
        out.push({ label: `도구 · ${tName}`, time: ts, text: (tDetail || tName).slice(0, 240) });
      }
    }
    if (edits.length > 0) {
      const files = edits
        .map(e => (e && typeof e === 'object' && typeof (e as Record<string, unknown>).file === 'string') ? String((e as Record<string, unknown>).file) : '')
        .filter(Boolean);
      if (files.length > 0) {
        out.push({ label: '파일 수정', time: ts, text: files.join(', ') });
      }
    }
    if (errors.length > 0) {
      out.push({ label: '오류', time: ts, text: errors.map(String).join('\n').slice(0, 240) });
    }
    const body = action || assistantText;
    if (body) {
      out.push({ label: '워커 생각·응답', time: ts, text: body.slice(0, 320) });
    }
  }
  return out;
}

function populateWorkerLogList(container: HTMLElement, projectId: string, workerId: string): void {
  clearChildren(container);
  const key = `${projectId}:${workerId}`;
  const logs = state.workerLogs.get(key);
  if (!logs || logs.loading) {
    const loading = document.createElement('div');
    loading.className = 'muted-text';
    loading.textContent = '워커 로그 불러오는 중...';
    container.appendChild(loading);
    return;
  }
  if (logs.error) {
    const err = document.createElement('div');
    err.className = 'error-text';
    err.textContent = logs.error;
    container.appendChild(err);
    return;
  }

  const transcriptEntries = extractTranscriptEntries(logs.transcript);
  if (logs.progress.length === 0 && transcriptEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted-text';
    empty.textContent = '아직 수집된 워커 생각·도구 로그가 없습니다.';
    container.appendChild(empty);
    return;
  }

  for (const t of transcriptEntries) {
    const row = document.createElement('div');
    row.className = 'worker-log-entry';
    const head = document.createElement('div');
    head.className = 'worker-log-entry-head';
    const lbl = document.createElement('span');
    lbl.textContent = t.label;
    const tm = document.createElement('span');
    tm.textContent = t.time;
    head.append(lbl, tm);
    const body = document.createElement('div');
    body.className = 'worker-log-entry-text';
    body.textContent = t.text;
    row.append(head, body);
    container.appendChild(row);
  }

  for (const p of logs.progress.slice(-25)) {
    const row = document.createElement('div');
    row.className = 'worker-log-entry';
    const head = document.createElement('div');
    head.className = 'worker-log-entry-head';
    const lbl = document.createElement('span');
    lbl.textContent = `실시간 · ${progressKindLabel(p.kind)}`;
    const tm = document.createElement('span');
    tm.textContent = shortTime(p.ts);
    head.append(lbl, tm);
    const body = document.createElement('div');
    body.className = 'worker-log-entry-text';
    body.textContent = p.detail && p.detail !== p.summary ? `${p.summary}\n${p.detail}` : p.summary;
    row.append(head, body);
    container.appendChild(row);
  }
  container.scrollTop = container.scrollHeight;
}

async function fetchWorkerLogs(projectId: string, workerId: string): Promise<void> {
  const key = `${projectId}:${workerId}`;
  const existing = state.workerLogs.get(key);
  state.workerLogs.set(key, {
    progress: existing?.progress ?? [],
    transcript: existing?.transcript ?? [],
    loading: true,
    error: null,
    loadedAt: existing?.loadedAt ?? null,
  });
  patchWorkerLogSlot(projectId, workerId);
  try {
    const data = await api<{ progress: ProgressLogEntry[]; transcript: unknown }>(
      `/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/logs?last=8`,
    );
    state.workerLogs.set(key, {
      progress: data.progress ?? [],
      transcript: data.transcript ?? [],
      loading: false,
      error: null,
      loadedAt: Date.now(),
    });
  } catch (error) {
    state.workerLogs.set(key, {
      progress: existing?.progress ?? [],
      transcript: existing?.transcript ?? [],
      loading: false,
      error: error instanceof Error ? error.message : String(error),
      loadedAt: Date.now(),
    });
  }
  patchWorkerLogSlot(projectId, workerId);
}

function patchWorkerLiveSlot(projectId: string, workerId: string): void {
  const key = `${projectId}:${workerId}`;
  const latest = state.workerLatestProgress.get(key);
  const slot = document.querySelector<HTMLElement>(`[data-worker-live-slot="${CSS.escape(workerId)}"]`);
  if (!slot) return;
  if (!latest) {
    slot.classList.add('hidden');
    return;
  }
  slot.classList.remove('hidden');
  const txt = slot.querySelector<HTMLElement>('.worker-live-text');
  if (txt) txt.textContent = latest.summary;
}

function patchWorkerLogSlot(projectId: string, workerId: string): void {
  const list = document.querySelector<HTMLElement>(`[data-worker-log-list="${CSS.escape(workerId)}"]`);
  if (!list) return;
  populateWorkerLogList(list, projectId, workerId);
}

function renderWorkersAndHandoff(): void {
  const workerList = el<HTMLDivElement>('workerList');
  clearChildren(workerList);
  const detail = state.activeDetail;
  const goalInput = el<HTMLInputElement>('handoffGoal');
  const testInput = el<HTMLInputElement>('handoffTestResult');
  const nextInput = el<HTMLTextAreaElement>('handoffNextSteps');

  if (!detail) {
    const empty = document.createElement('div');
    empty.className = 'muted-text';
    empty.textContent = '프로젝트를 선택하면 워커가 표시됩니다.';
    workerList.appendChild(empty);
    el<HTMLSpanElement>('handoffBranch').textContent = '-';
    el<HTMLSpanElement>('handoffCommit').textContent = '-';
    el<HTMLDivElement>('handoffWorkerReport').textContent = '-';
    el<HTMLDivElement>('handoffCodexReview').textContent = '-';
    goalInput.value = '';
    testInput.value = '';
    nextInput.value = '';
    goalInput.disabled = true;
    testInput.disabled = true;
    nextInput.disabled = true;
    return;
  }

  const projectId = detail.snapshot.project.projectId;
  for (const worker of detail.snapshot.workers) {
    const workerKey = `${projectId}:${worker.workerId}`;
    const isExpanded = state.expandedWorkers.has(workerKey);
    const latestProgress = state.workerLatestProgress.get(workerKey);

    const card = document.createElement('div');
    card.className = `worker-card${isExpanded ? ' expanded' : ''}`;

    // 기본 접힘 상태에서도 한 줄 요약 + 아래 화살표(▾)로 펼침
    const headerBtn = document.createElement('button');
    headerBtn.type = 'button';
    headerBtn.className = 'worker-card-header';
    headerBtn.setAttribute('aria-expanded', String(isExpanded));
    headerBtn.addEventListener('click', () => {
      if (state.expandedWorkers.has(workerKey)) {
        state.expandedWorkers.delete(workerKey);
        renderWorkersAndHandoff();
      } else {
        state.expandedWorkers.add(workerKey);
        renderWorkersAndHandoff();
        void fetchWorkerLogs(projectId, worker.workerId);
      }
    });

    const top = document.createElement('div');
    top.className = 'worker-card-top';
    const nameWrap = document.createElement('div');
    nameWrap.className = 'worker-name-wrap';
    const dot = document.createElement('span');
    dot.className = `status-dot ${statusDotClass(worker.status)}`;
    const nameText = document.createElement('span');
    nameText.className = 'truncate';
    nameText.textContent = worker.name;
    nameWrap.append(dot, nameText);
    if (worker.isDefault) {
      const def = document.createElement('span');
      def.className = 'chip';
      def.textContent = '기본';
      nameWrap.appendChild(def);
    }

    const rightWrap = document.createElement('div');
    rightWrap.className = 'worker-card-right';
    const statusText = document.createElement('span');
    statusText.className = 'muted-text';
    statusText.style.fontSize = '11px';
    statusText.textContent = statusLabel(worker.status);
    const chevron = document.createElement('span');
    chevron.className = 'worker-chevron';
    chevron.textContent = '▾';
    rightWrap.append(statusText, chevron);
    top.append(nameWrap, rightWrap);

    const compactSub = document.createElement('div');
    compactSub.className = 'worker-compact-sub';
    const modelSummary = document.createElement('span');
    modelSummary.className = 'truncate';
    const effPart = worker.reasoningEffort ? ` · ${worker.reasoningEffort}` : '';
    modelSummary.textContent = `${shortModelLabel(worker.model, state.models.agy)}${effPart}`;
    const permBadge = document.createElement('span');
    permBadge.className = 'mono-text';
    permBadge.textContent = PERMISSION_SHORT_LABELS[worker.permissionMode] ?? worker.permissionMode;
    compactSub.append(modelSummary, permBadge);

    headerBtn.append(top, compactSub);

    const liveLine = document.createElement('div');
    liveLine.className = `worker-live-line${latestProgress && worker.status === 'working' ? '' : ' hidden'}`;
    liveLine.dataset.workerLiveSlot = worker.workerId;
    const liveDot = document.createElement('span');
    liveDot.className = 'thinking-dot active';
    const liveTxt = document.createElement('span');
    liveTxt.className = 'truncate worker-live-text';
    liveTxt.textContent = latestProgress?.summary ?? '';
    liveLine.append(liveDot, liveTxt);
    headerBtn.appendChild(liveLine);

    card.appendChild(headerBtn);

    if (isExpanded) {
      const body = document.createElement('div');
      body.className = 'worker-body';

      const meta = document.createElement('div');
      meta.className = 'worker-meta mono-text';
      const line1 = document.createElement('span');
      line1.textContent = `hcom: ${worker.hcomName ?? '미연결'} · conv: ${shortId(worker.conversationId)}`;
      line1.title = worker.conversationId ?? '';
      const line2 = document.createElement('span');
      line2.className = 'truncate';
      line2.textContent = worker.cwd;
      line2.title = worker.cwd;
      meta.append(line1, line2);
      if (worker.lastError) {
        const err = document.createElement('span');
        err.className = 'error-text';
        err.textContent = worker.lastError;
        meta.appendChild(err);
      }
      body.appendChild(meta);

      // 워커 모델 · 추론 속도 · 권한 설정
      const settingsGrid = document.createElement('div');
      settingsGrid.className = 'worker-settings-grid';

      const modelRow = document.createElement('label');
      modelRow.className = 'worker-setting-row';
      const modelLbl = document.createElement('span');
      modelLbl.className = 'inline-control-label';
      modelLbl.textContent = '모델';
      const modelSel = document.createElement('select');
      modelSel.className = 'select-compact';
      populateModelSelect(modelSel, state.models.agy, worker.model);
      modelRow.append(modelLbl, modelSel);

      const effortRow = document.createElement('label');
      effortRow.className = 'worker-setting-row';
      const effortLbl = document.createElement('span');
      effortLbl.className = 'inline-control-label';
      effortLbl.textContent = '추론';
      const effortSel = document.createElement('select');
      effortSel.className = 'select-compact';
      populateEffortSelect(effortSel, effortsForModel(state.models.agy, worker.model), worker.reasoningEffort);
      effortRow.append(effortLbl, effortSel);

      const permRow = document.createElement('label');
      permRow.className = 'worker-setting-row';
      const permLbl = document.createElement('span');
      permLbl.className = 'inline-control-label';
      permLbl.textContent = '권한';
      const permSel = document.createElement('select');
      permSel.className = 'select-compact';
      for (const [val, txt] of [
        ['always-proceed', '자동 진행 (권장)'],
        ['ask', '매번 승인'],
        ['read-only', '읽기 전용'],
      ]) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = txt;
        permSel.appendChild(o);
      }
      permSel.value = worker.permissionMode ?? 'always-proceed';
      permRow.append(permLbl, permSel);

      const saveWorkerSettings = (applyNow: boolean) => {
        void handleUpdateWorkerSettings(projectId, worker.workerId, {
          model: modelSel.value || null,
          reasoningEffort: effortSel.value || null,
          permissionMode: permSel.value as WorkerRecord['permissionMode'],
          applyNow,
        });
      };

      modelSel.addEventListener('change', () => {
        populateEffortSelect(effortSel, effortsForModel(state.models.agy, modelSel.value || null), effortSel.value || null);
        saveWorkerSettings(false);
      });
      effortSel.addEventListener('change', () => saveWorkerSettings(false));
      permSel.addEventListener('change', () => saveWorkerSettings(false));

      settingsGrid.append(modelRow, effortRow, permRow);
      body.appendChild(settingsGrid);

      const actions = document.createElement('div');
      actions.className = 'worker-actions';
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'btn btn-outline btn-xs';
      startBtn.textContent = worker.status === 'ready' || worker.status === 'working' ? '실행 중' : '시작 / 재개';
      startBtn.disabled = worker.status === 'ready' || worker.status === 'working' || worker.status === 'starting';
      startBtn.addEventListener('click', () => { void runWorkerAction(projectId, worker.workerId, 'start'); });

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'btn btn-subtle btn-xs';
      stopBtn.textContent = '중지';
      stopBtn.disabled = worker.status === 'stopped';
      stopBtn.addEventListener('click', () => { void runWorkerAction(projectId, worker.workerId, 'stop'); });

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'btn btn-subtle btn-xs';
      applyBtn.textContent = '설정 재적용';
      applyBtn.title = '대화 ID를 유지한 채 변경된 모델·추론·권한으로 워커를 재개합니다';
      applyBtn.disabled = worker.status === 'working' || worker.status === 'starting' || worker.status === 'stopped';
      applyBtn.addEventListener('click', () => saveWorkerSettings(true));

      actions.append(startBtn, stopBtn, applyBtn);
      body.appendChild(actions);

      // 온디맨드 워커 생각·도구 로그 섹션
      const logSec = document.createElement('div');
      logSec.className = 'worker-log-section';
      const logHead = document.createElement('div');
      logHead.className = 'worker-log-head';
      const logTitle = document.createElement('span');
      logTitle.textContent = '생각 · 도구 로그';
      const logRefreshBtn = document.createElement('button');
      logRefreshBtn.type = 'button';
      logRefreshBtn.className = 'btn btn-subtle btn-xs';
      logRefreshBtn.textContent = '새로고침';
      logRefreshBtn.addEventListener('click', () => { void fetchWorkerLogs(projectId, worker.workerId); });
      logHead.append(logTitle, logRefreshBtn);

      const logList = document.createElement('div');
      logList.className = 'worker-log-list';
      logList.dataset.workerLogList = worker.workerId;
      populateWorkerLogList(logList, projectId, worker.workerId);
      logSec.append(logHead, logList);
      body.appendChild(logSec);

      // 워커 전용 직접 대화 입력창
      const chatRow = document.createElement('div');
      chatRow.className = 'worker-chat-row';
      const chatInput = document.createElement('input');
      chatInput.className = 'input';
      chatInput.type = 'text';
      chatInput.placeholder = `${worker.name}에게 직접 지시 (Enter 전송)`;
      chatInput.value = state.workerChatDrafts.get(workerKey) ?? '';
      chatInput.addEventListener('input', () => {
        state.workerChatDrafts.set(workerKey, chatInput.value);
      });
      const chatBtn = document.createElement('button');
      chatBtn.type = 'button';
      chatBtn.className = 'btn btn-primary btn-xs';
      chatBtn.textContent = '전송';
      const sendDirect = () => {
        const text = chatInput.value.trim();
        if (!text) return;
        chatInput.value = '';
        state.workerChatDrafts.delete(workerKey);
        void handleDirectWorkerChat(projectId, worker.workerId, text);
      };
      chatBtn.addEventListener('click', sendDirect);
      chatInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          sendDirect();
        }
      });
      chatRow.append(chatInput, chatBtn);
      body.appendChild(chatRow);

      card.appendChild(body);
    }

    workerList.appendChild(card);
  }

  const h = detail.snapshot.handoff;
  el<HTMLSpanElement>('handoffBranch').textContent = h.branchStatus;
  el<HTMLSpanElement>('handoffCommit').textContent = h.commitStatus;
  el<HTMLSpanElement>('handoffCommit').title = h.commitStatus;
  el<HTMLDivElement>('handoffWorkerReport').textContent = h.lastWorkerReport ?? '-';
  el<HTMLDivElement>('handoffCodexReview').textContent = h.lastCodexReview ?? '-';
  goalInput.disabled = false;
  testInput.disabled = false;
  nextInput.disabled = false;
  if (document.activeElement !== goalInput) goalInput.value = h.goal === '미설정' ? '' : h.goal;
  if (document.activeElement !== testInput) testInput.value = h.testResult;
  if (document.activeElement !== nextInput) nextInput.value = h.nextSteps === '미설정' ? '' : h.nextSteps;
}

function renderAll(): void {
  renderProjectList();
  renderHeaderAndBar();
  renderMessages();
  renderHcomMessages();
  renderWorkersAndHandoff();
}

function flushPartialRenders(): void {
  state.partialRenderTimer = null;
  if (document.hidden) {
    state.dirtyWhileHidden = true;
    return;
  }
  const projectId = state.selectedProjectId;
  const reqIds = [...state.dirtyRequestSlots];
  const workerIds = [...state.dirtyWorkerSlots];
  const hcomDirty = state.dirtyHcom;
  state.dirtyRequestSlots.clear();
  state.dirtyWorkerSlots.clear();
  state.dirtyHcom = false;

  window.requestAnimationFrame(() => {
    for (const reqId of reqIds) {
      patchRequestThinkingSlot(reqId);
    }
    if (projectId) {
      for (const workerId of workerIds) {
        patchWorkerLiveSlot(projectId, workerId);
        if (state.expandedWorkers.has(`${projectId}:${workerId}`)) {
          patchWorkerLogSlot(projectId, workerId);
        }
      }
    }
    if (hcomDirty) {
      renderHcomMessages();
    }
  });
}

function schedulePartialRender(): void {
  if (document.hidden) {
    state.dirtyWhileHidden = true;
    return;
  }
  if (state.partialRenderTimer !== null) return;
  state.partialRenderTimer = window.setTimeout(flushPartialRenders, 120);
}

function scheduleProjectRefresh(projectId: string): void {
  if (document.hidden) {
    state.dirtyWhileHidden = true;
    return;
  }
  state.refreshQueuedProjectId = projectId;
  if (state.refreshTimer !== null) return;
  state.refreshTimer = window.setTimeout(() => {
    state.refreshTimer = null;
    const target = state.refreshQueuedProjectId;
    state.refreshQueuedProjectId = null;
    if (target && target === state.selectedProjectId) {
      void refreshActiveProject(target, false);
    }
  }, 150);
}

function closeSse(): void {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function connectSse(projectId: string, afterSeq: number): void {
  closeSse();
  const url = `${state.config.baseUrl}/api/projects/${encodeURIComponent(projectId)}/events?token=${encodeURIComponent(state.config.token)}&afterSeq=${afterSeq}`;
  const source = new EventSource(url);
  state.eventSource = source;

  const refreshKinds = [
    'project.registered',
    'project.stopped',
    'codex.started',
    'codex.settings_updated',
    'codex.worktree_switched',
    'worker.added',
    'worker.started',
    'worker.stopped',
    'worker.status',
    'worker.settings_updated',
    'worker.worktree_switched',
    'request.accepted',
    'request.codex_running',
    'request.worker_working',
    'request.codex_reviewing',
    'request.waiting_user',
    'request.waiting_approval',
    'request.approval_resolved',
    'request.user_replied',
    'request.cancelled',
    'request.finished',
    'request.failed',
    'handoff.updated',
    'hcom.db_reset',
  ];

  for (const kind of refreshKinds) {
    source.addEventListener(kind, event => {
      if (state.selectedProjectId !== projectId) return;
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as { seq?: number; projectId?: string };
        if (parsed.projectId !== projectId) return;
        if (state.activeDetail && typeof parsed.seq === 'number' && parsed.seq > state.activeDetail.latestSeq) {
          state.activeDetail.latestSeq = parsed.seq;
        }
      } catch {}
      scheduleProjectRefresh(projectId);
    });
  }

  // 실시간 추론·도구 로그 (HTTP 재조회 없이 메모리 직접 패치 + 120ms 배치 렌더)
  source.addEventListener('request.progress', event => {
    if (state.selectedProjectId !== projectId || !state.activeDetail) return;
    try {
      const parsed = JSON.parse((event as MessageEvent<string>).data) as {
        projectId: string;
        requestId?: string;
        entry?: ProgressLogEntry;
      };
      if (parsed.projectId !== projectId || !parsed.requestId || !parsed.entry) return;
      const list = state.activeDetail.progressByRequest[parsed.requestId] ?? [];
      list.push(parsed.entry);
      if (list.length > 200) list.splice(0, list.length - 200);
      state.activeDetail.progressByRequest[parsed.requestId] = list;
      state.dirtyRequestSlots.add(parsed.requestId);
      schedulePartialRender();
    } catch {}
  });

  source.addEventListener('worker.progress', event => {
    if (state.selectedProjectId !== projectId) return;
    try {
      const parsed = JSON.parse((event as MessageEvent<string>).data) as {
        projectId: string;
        workerId?: string;
        entry?: ProgressLogEntry;
      };
      if (parsed.projectId !== projectId || !parsed.workerId || !parsed.entry) return;
      const key = `${projectId}:${parsed.workerId}`;
      state.workerLatestProgress.set(key, parsed.entry);
      const logs = state.workerLogs.get(key);
      if (logs) {
        logs.progress.push(parsed.entry);
        if (logs.progress.length > 120) logs.progress.splice(0, logs.progress.length - 120);
      }
      state.dirtyWorkerSlots.add(parsed.workerId);
      schedulePartialRender();
    } catch {}
  });

  source.addEventListener('hcom.message', event => {
    if (state.selectedProjectId !== projectId || !state.activeDetail) return;
    try {
      const parsed = JSON.parse((event as MessageEvent<string>).data) as {
        seq: number;
        projectId: string;
        createdAt: string;
        payload: { eventId: number; from: string; intent: string | null; replyTo: string | null; deliveredTo: string[]; text: string };
      };
      if (parsed.projectId !== projectId) return;
      if (state.activeDetail.hcomMessages.some(m => m.seq === parsed.seq)) return;
      state.activeDetail.hcomMessages.push({
        seq: parsed.seq,
        eventId: parsed.payload.eventId,
        from: parsed.payload.from,
        intent: parsed.payload.intent,
        replyTo: parsed.payload.replyTo,
        deliveredTo: parsed.payload.deliveredTo ?? [],
        text: parsed.payload.text,
        createdAt: parsed.createdAt,
      });
      if (state.activeDetail.hcomMessages.length > 100) {
        state.activeDetail.hcomMessages.splice(0, state.activeDetail.hcomMessages.length - 100);
      }
      state.activeDetail.latestSeq = Math.max(state.activeDetail.latestSeq, parsed.seq);
      state.dirtyHcom = true;
      schedulePartialRender();
    } catch {}
  });
}

async function refreshProjectsList(): Promise<void> {
  const data = await api<{ projects: ProjectSnapshot[]; selectedProjectId: string | null }>('/api/projects');
  state.projects = data.projects;
  if (!state.selectedProjectId) {
    state.selectedProjectId = data.selectedProjectId ?? data.projects[0]?.project.projectId ?? null;
  }
}

async function refreshActiveProject(projectId: string, reconnectSse: boolean): Promise<void> {
  if (state.refreshInFlight && !reconnectSse) {
    state.refreshQueuedProjectId = projectId;
    return;
  }
  state.refreshInFlight = true;
  try {
    const data = await api<{
      snapshot: ProjectSnapshot;
      requests: RequestRecord[];
      delegations: DelegationRecord[];
      progressByRequest?: Record<string, ProgressLogEntry[]>;
      latestSeq: number;
    }>(`/api/projects/${encodeURIComponent(projectId)}`);
    if (state.selectedProjectId !== projectId) return;

    const existingMessages = state.activeDetail?.snapshot.project.projectId === projectId
      ? state.activeDetail.hcomMessages
      : [];
    const mergedProgress: Record<string, ProgressLogEntry[]> = {
      ...(state.activeDetail?.snapshot.project.projectId === projectId ? state.activeDetail.progressByRequest : {}),
      ...(data.progressByRequest ?? {}),
    };
    state.activeDetail = {
      snapshot: data.snapshot,
      requests: data.requests,
      delegations: data.delegations,
      progressByRequest: mergedProgress,
      hcomMessages: existingMessages,
      latestSeq: data.latestSeq,
    };
    // 좌측 프로젝트 목록 스냅샷을 추가 API 호출 없이 로컬 패치 (목록 길이가 바뀌었거나 없으면 재조회)
    const idx = state.projects.findIndex(p => p.project.projectId === projectId);
    if (idx >= 0) {
      state.projects[idx] = data.snapshot;
    } else {
      await refreshProjectsList();
    }
    if (!document.hidden) {
      renderAll();
    } else {
      state.dirtyWhileHidden = true;
    }
    if (reconnectSse) connectSse(projectId, 0);
  } finally {
    state.refreshInFlight = false;
    const queued = state.refreshQueuedProjectId;
    if (queued && queued === state.selectedProjectId && !document.hidden) {
      state.refreshQueuedProjectId = null;
      void refreshActiveProject(queued, false);
    }
  }
}

async function selectProject(projectId: string): Promise<void> {
  showNotice(null);
  state.selectedProjectId = projectId;
  await api(`/api/projects/${encodeURIComponent(projectId)}/select`, { method: 'POST' });
  await refreshActiveProject(projectId, true);
}

async function loadModels(refresh = false): Promise<void> {
  try {
    const catalog = await api<ModelCatalog>(`/api/models${refresh ? '?refresh=1' : ''}`);
    if (Array.isArray(catalog.codex) && catalog.codex.length > 0) {
      state.models = catalog;
      renderHeaderAndBar();
      renderWorkersAndHandoff();
    }
  } catch {}
}

async function handleUpdateCodexSettings(): Promise<void> {
  const projectId = state.selectedProjectId;
  if (!projectId) return;
  const model = el<HTMLSelectElement>('codexModelSelect').value || null;
  const reasoningEffort = el<HTMLSelectElement>('codexEffortSelect').value || null;
  const sandboxMode = el<HTMLSelectElement>('codexSandboxSelect').value as CodexRecord['sandboxMode'];
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/codex/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ model, reasoningEffort, sandboxMode }),
    });
    showNotice('Codex 모델·추론·권한 설정을 저장했습니다 (다음 턴부터 즉시 적용).');
    window.setTimeout(() => showNotice(null), 2200);
    await refreshActiveProject(projectId, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleUpdateWorkerSettings(
  projectId: string,
  workerId: string,
  payload: { model: string | null; reasoningEffort: string | null; permissionMode: WorkerRecord['permissionMode']; applyNow: boolean },
): Promise<void> {
  try {
    if (payload.applyNow) {
      showNotice('변경된 설정으로 워커를 재개하는 중입니다...');
    }
    await api(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    showNotice(payload.applyNow ? '워커에 새 설정을 적용했습니다.' : '워커 설정을 저장했습니다 (시작·재적용 시 반영).');
    window.setTimeout(() => showNotice(null), 2200);
    await refreshActiveProject(projectId, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function runWorkerAction(projectId: string, workerId: string, action: 'start' | 'stop'): Promise<void> {
  try {
    showNotice(action === 'start' ? '워커를 시작·재개하는 중입니다...' : '워커를 중지하는 중입니다...');
    await api(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/${action}`, { method: 'POST' });
    showNotice(null);
    await refreshActiveProject(projectId, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

function openModal(id: string): void {
  el<HTMLElement>(id).classList.remove('hidden');
}

function closeModal(id: string): void {
  el<HTMLElement>(id).classList.add('hidden');
}

async function handleDirectWorkerChat(projectId: string, workerId: string, prompt: string): Promise<void> {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    showNotice(null);
    await api(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ requestId, prompt }),
    });
    await refreshActiveProject(projectId, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleSendPrompt(): Promise<void> {
  const projectId = state.selectedProjectId;
  if (!projectId) return;
  const input = el<HTMLTextAreaElement>('promptInput');
  const prompt = input.value.trim();
  if (!prompt) return;

  const target = el<HTMLSelectElement>('composerTargetSelect').value || 'codex';
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  input.value = '';
  try {
    showNotice(null);
    if (target.startsWith('worker:')) {
      const workerId = target.slice('worker:'.length);
      await api(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ requestId, prompt }),
      });
    } else {
      await api(`/api/projects/${encodeURIComponent(projectId)}/requests`, {
        method: 'POST',
        body: JSON.stringify({ requestId, prompt }),
      });
    }
    await refreshActiveProject(projectId, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleReplyToRequest(projectId: string, requestId: string, answer: string): Promise<void> {
  const replyKey = `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    showNotice(null);
    await api(`/api/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ replyKey, answer }),
    });
    await refreshActiveProject(projectId, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleResolveApproval(projectId: string, requestId: string, decision: 'approve' | 'deny'): Promise<void> {
  try {
    showNotice(decision === 'approve' ? '워커에게 승인을 전달하는 중입니다...' : '워커 작업을 거절하는 중입니다...');
    await api(`/api/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/approval`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    showNotice(null);
    await refreshActiveProject(projectId, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleCancelRequest(projectId: string, requestId: string): Promise<void> {
  try {
    showNotice('요청을 취소하는 중입니다...');
    await api(`/api/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/cancel`, {
      method: 'POST',
    });
    showNotice(null);
    await refreshActiveProject(projectId, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function loadDiagnostics(): Promise<void> {
  try {
    state.diagnostics = await api<CliDiagnostics>('/api/diagnostics');
    renderDiagnostics();
  } catch {}
}

function bindEvents(): void {
  // 창이 백그라운드(트레이 등)로 숨겨지면 DOM 렌더링을 일시 중지하고 복귀 시 1회만 동기화
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.dirtyWhileHidden) {
      state.dirtyWhileHidden = false;
      if (state.selectedProjectId) {
        void refreshActiveProject(state.selectedProjectId, false);
      } else {
        renderAll();
      }
    }
  });

  el<HTMLButtonElement>('toggleLeftBtn').addEventListener('click', () => {
    el<HTMLElement>('leftSidebar').classList.toggle('collapsed');
  });
  el<HTMLButtonElement>('toggleRightBtn').addEventListener('click', () => {
    el<HTMLElement>('rightSidebar').classList.toggle('collapsed');
  });
  el<HTMLButtonElement>('toggleHcomLogBtn').addEventListener('click', () => {
    el<HTMLDivElement>('hcomLogList').classList.toggle('hidden');
  });

  for (const btn of document.querySelectorAll<HTMLElement>('.modal-close')) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.close;
      if (target) closeModal(target);
    });
  }

  // Codex 모델 · 추론 속도 · 권한 변경 이벤트
  const codexModelSelect = el<HTMLSelectElement>('codexModelSelect');
  const codexEffortSelect = el<HTMLSelectElement>('codexEffortSelect');
  const codexSandboxSelect = el<HTMLSelectElement>('codexSandboxSelect');
  codexModelSelect.addEventListener('change', () => {
    populateEffortSelect(codexEffortSelect, effortsForModel(state.models.codex, codexModelSelect.value || null), codexEffortSelect.value || null);
    void handleUpdateCodexSettings();
  });
  codexEffortSelect.addEventListener('change', () => { void handleUpdateCodexSettings(); });
  codexSandboxSelect.addEventListener('change', () => { void handleUpdateCodexSettings(); });
  el<HTMLButtonElement>('refreshModelsBtn').addEventListener('click', async () => {
    showNotice('CLI 모델 목록을 새로고침하는 중입니다...');
    await loadModels(true);
    showNotice('최신 CLI 모델 목록을 불러왔습니다.');
    window.setTimeout(() => showNotice(null), 1800);
  });

  const openRegister = () => {
    el<HTMLInputElement>('registerPathInput').value = '';
    el<HTMLInputElement>('registerNameInput').value = '';
    el<HTMLDivElement>('registerError').classList.add('hidden');
    openModal('registerModal');
  };
  el<HTMLButtonElement>('openRegisterBtn').addEventListener('click', openRegister);
  el<HTMLButtonElement>('emptyRegisterBtn').addEventListener('click', openRegister);

  el<HTMLButtonElement>('browseFolderBtn').addEventListener('click', async () => {
    const picked = await window.hcomGui?.pickFolder();
    if (picked) el<HTMLInputElement>('registerPathInput').value = picked;
  });

  el<HTMLButtonElement>('confirmRegisterBtn').addEventListener('click', async () => {
    const folderPath = el<HTMLInputElement>('registerPathInput').value.trim();
    const name = el<HTMLInputElement>('registerNameInput').value.trim();
    const errBox = el<HTMLDivElement>('registerError');
    try {
      const created = await api<{ snapshot: ProjectSnapshot }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ folderPath, ...(name ? { name } : {}) }),
      });
      closeModal('registerModal');
      await refreshProjectsList();
      await selectProject(created.snapshot.project.projectId);
    } catch (error) {
      errBox.textContent = error instanceof Error ? error.message : String(error);
      errBox.classList.remove('hidden');
    }
  });

  el<HTMLButtonElement>('startProjectBtn').addEventListener('click', async () => {
    const projectId = state.selectedProjectId;
    if (!projectId) return;
    try {
      showNotice('프로젝트 전용 Codex와 기본 워커를 시작하는 중입니다...');
      await api(`/api/projects/${encodeURIComponent(projectId)}/start`, { method: 'POST' });
      showNotice(null);
      await refreshActiveProject(projectId, false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), true);
    }
  });

  el<HTMLButtonElement>('stopProjectBtn').addEventListener('click', async () => {
    const projectId = state.selectedProjectId;
    if (!projectId) return;
    try {
      showNotice('프로젝트 세션을 종료하는 중입니다...');
      await api(`/api/projects/${encodeURIComponent(projectId)}/stop`, { method: 'POST' });
      showNotice(null);
      await refreshActiveProject(projectId, false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), true);
    }
  });

  const addWorkerModelSel = el<HTMLSelectElement>('addWorkerModelSelect');
  const addWorkerEffortSel = el<HTMLSelectElement>('addWorkerEffortSelect');
  addWorkerModelSel.addEventListener('change', () => {
    populateEffortSelect(addWorkerEffortSel, effortsForModel(state.models.agy, addWorkerModelSel.value || null), addWorkerEffortSel.value || null);
  });

  el<HTMLButtonElement>('openAddWorkerBtn').addEventListener('click', () => {
    if (!state.activeDetail) return;
    state.addWorkerTargetProjectId = state.activeDetail.snapshot.project.projectId;
    el<HTMLElement>('addWorkerProjectLabel').textContent = state.activeDetail.snapshot.project.name;
    el<HTMLInputElement>('addWorkerNameInput').value = '';
    el<HTMLInputElement>('addWorkerCwdInput').value = '';
    populateModelSelect(addWorkerModelSel, state.models.agy, null);
    populateEffortSelect(addWorkerEffortSel, effortsForModel(state.models.agy, null), null);
    el<HTMLSelectElement>('addWorkerPermissionSelect').value = 'always-proceed';
    el<HTMLDivElement>('addWorkerError').classList.add('hidden');
    openModal('addWorkerModal');
  });

  el<HTMLButtonElement>('browseWorkerCwdBtn').addEventListener('click', async () => {
    const picked = await window.hcomGui?.pickFolder();
    if (picked) el<HTMLInputElement>('addWorkerCwdInput').value = picked;
  });

  el<HTMLButtonElement>('confirmAddWorkerBtn').addEventListener('click', async () => {
    const targetProjectId = state.addWorkerTargetProjectId;
    if (!targetProjectId) return;
    const name = el<HTMLInputElement>('addWorkerNameInput').value.trim();
    const cwd = el<HTMLInputElement>('addWorkerCwdInput').value.trim();
    const model = addWorkerModelSel.value || null;
    const reasoningEffort = addWorkerEffortSel.value || null;
    const permissionMode = el<HTMLSelectElement>('addWorkerPermissionSelect').value as WorkerRecord['permissionMode'];
    const errBox = el<HTMLDivElement>('addWorkerError');
    const requestKey = `add-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      closeModal('addWorkerModal');
      showNotice(`워커(${name || '새 워커'})를 추가하고 시작하는 중입니다...`);
      await api(`/api/projects/${encodeURIComponent(targetProjectId)}/workers`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          requestKey,
          ...(cwd ? { cwd } : {}),
          model,
          reasoningEffort,
          permissionMode,
          start: true,
        }),
      });
      showNotice(null);
      if (state.selectedProjectId === targetProjectId) {
        await refreshActiveProject(targetProjectId, false);
      } else {
        await refreshProjectsList();
        renderProjectList();
      }
    } catch (error) {
      errBox.textContent = error instanceof Error ? error.message : String(error);
      errBox.classList.remove('hidden');
      showNotice(errBox.textContent, true);
    }
  });

  el<HTMLButtonElement>('saveHandoffBtn').addEventListener('click', async () => {
    const projectId = state.selectedProjectId;
    if (!projectId) return;
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/handoff`, {
        method: 'PATCH',
        body: JSON.stringify({
          goal: el<HTMLInputElement>('handoffGoal').value,
          testResult: el<HTMLInputElement>('handoffTestResult').value,
          nextSteps: el<HTMLTextAreaElement>('handoffNextSteps').value,
        }),
      });
      showNotice('인계 기록을 저장했습니다.');
      window.setTimeout(() => showNotice(null), 2000);
      await refreshActiveProject(projectId, false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), true);
    }
  });

  const promptInput = el<HTMLTextAreaElement>('promptInput');
  promptInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void handleSendPrompt();
    }
  });
  el<HTMLSelectElement>('composerTargetSelect').addEventListener('change', () => {
    renderHeaderAndBar();
  });
  el<HTMLButtonElement>('sendBtn').addEventListener('click', () => { void handleSendPrompt(); });

  el<HTMLButtonElement>('diagnosticsBtn').addEventListener('click', () => {
    openModal('diagnosticsModal');
    void loadDiagnostics();
  });
  el<HTMLButtonElement>('refreshDiagBtn').addEventListener('click', () => { void loadDiagnostics(); });

  el<HTMLButtonElement>('updateBtn').addEventListener('click', () => {
    el<HTMLSpanElement>('updateCurrentVersion').textContent = `v${state.config.version}`;
    el<HTMLSpanElement>('updateDataDir').textContent = state.config.dataDir || '-';
    el<HTMLDivElement>('updateError').classList.add('hidden');
    openModal('updateModal');
  });

  el<HTMLButtonElement>('runInstallerUpdateBtn').addEventListener('click', async () => {
    const errBox = el<HTMLDivElement>('updateError');
    if (!window.hcomGui) {
      errBox.textContent = '설치형 데스크톱 앱에서만 설치 파일 실행 업데이트를 지원합니다.';
      errBox.classList.remove('hidden');
      return;
    }
    const result = await window.hcomGui.pickInstallerAndUpdate();
    if (result.error) {
      errBox.textContent = result.error;
      errBox.classList.remove('hidden');
    }
  });
}

async function bootstrap(): Promise<void> {
  bindEvents();
  if (window.hcomGui) {
    state.config = await window.hcomGui.getConfig();
  } else {
    const params = new URLSearchParams(window.location.search);
    state.config.token = params.get('token') ?? '';
  }
  el<HTMLSpanElement>('versionLabel').textContent = `v${state.config.version}`;
  await Promise.all([loadDiagnostics(), refreshProjectsList()]);
  // 모델 목록은 비동기로 불러와 초기 화면 렌더링을 지연시키지 않음
  void loadModels(false);
  if (state.selectedProjectId) {
    await refreshActiveProject(state.selectedProjectId, true);
  } else {
    renderAll();
  }
}

void bootstrap();
