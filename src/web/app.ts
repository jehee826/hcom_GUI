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

interface RequestRecord {
  projectId: string;
  requestId: string;
  prompt: string;
  status: string;
  codexTurnId: string | null;
  reviewTurnId: string | null;
  finalText: string | null;
  error: string | null;
}

interface DelegationRecord {
  delegationId: string;
  requestId: string;
  workerId: string;
  requestEventId: number | null;
  replyEventId: number | null;
  prompt: string;
  replyText: string | null;
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

const state = {
  config: { baseUrl: window.location.origin, token: '', version: '1.0.0', dataDir: '' } as BridgeConfig,
  projects: [] as ProjectSnapshot[],
  selectedProjectId: null as string | null,
  activeDetail: null as {
    snapshot: ProjectSnapshot;
    requests: RequestRecord[];
    delegations: DelegationRecord[];
    hcomMessages: HcomMessageItem[];
    latestSeq: number;
  } | null,
  diagnostics: null as CliDiagnostics | null,
  eventSource: null as EventSource | null,
  addWorkerTargetProjectId: null as string | null,
  busyAction: false,
};

function statusDotClass(status: string): string {
  if (status === 'ready' || status === 'completed') return 'dot-ready';
  if (status === 'starting' || status === 'running' || status === 'working' || status === 'needs_attention') return 'dot-working';
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
    codex_running: 'Codex 실행',
    worker_working: '워커 작업 중',
    codex_reviewing: 'Codex 검토',
    completed: '완료',
    failed: '실패',
    interrupted: '중단',
    needs_verification: '확인 필요',
  };
  return labels[status] ?? status;
}

function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
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
    targetTag.classList.add('hidden');
    hint.textContent = '프로젝트를 먼저 선택하세요';
    addWorkerBtn.disabled = true;
    saveHandoffBtn.disabled = true;
    return;
  }

  const { project, codex, handoff } = detail.snapshot;
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

  emptyState.classList.add('hidden');
  feed.classList.remove('hidden');
  hcomStrip.classList.remove('hidden');

  input.disabled = false;
  sendBtn.disabled = false;
  targetTag.textContent = `대상: ${project.name}`;
  targetTag.classList.remove('hidden');
  hint.textContent = 'Enter 전송 · Shift+Enter 줄바꿈 · 프로젝트별 독립 세션';
  addWorkerBtn.disabled = false;
  saveHandoffBtn.disabled = false;
}

function renderPipeline(status: string): HTMLElement {
  const steps: Array<[string, string]> = [
    ['accepted', '접수'],
    ['codex_running', 'Codex 실행'],
    ['worker_working', '워커 작업 중'],
    ['codex_reviewing', 'Codex 검토'],
    ['completed', '완료'],
  ];
  const order = steps.map(([key]) => key);
  const currentIdx = order.indexOf(status);
  const wrap = document.createElement('div');
  wrap.className = 'stage-pipeline';
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
    badge.className = 'stage-step current';
    badge.textContent = statusLabel(status);
    wrap.appendChild(badge);
  }
  return wrap;
}

function renderMessages(): void {
  const feed = el<HTMLDivElement>('messageFeed');
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
    desc.textContent = '상단의 "시작 / 재개" 버튼으로 이 프로젝트 전용 Codex와 기본 Antigravity 워커를 시작하거나, 아래 입력창에 바로 지시를 보낼 수 있습니다.';
    placeholder.append(title, desc);
    feed.appendChild(placeholder);
    return;
  }

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
    header.appendChild(renderPipeline(req.status));
    const reqTag = document.createElement('span');
    reqTag.className = 'mono-text muted-text';
    reqTag.textContent = shortId(req.requestId);
    header.appendChild(reqTag);
    card.appendChild(header);

    const reqDelegations = detail.delegations.filter(d => d.requestId === req.requestId);
    for (const del of reqDelegations) {
      const worker = workerById.get(del.workerId);
      const box = document.createElement('div');
      box.className = 'delegation-box';
      const title = document.createElement('div');
      title.className = 'delegation-title';
      const left = document.createElement('span');
      left.textContent = `hcom 위임 → ${worker?.name ?? shortId(del.workerId)}`;
      const right = document.createElement('span');
      right.className = 'mono-text';
      right.textContent = `요청 #${del.requestEventId ?? '-'}${del.replyEventId ? ` · 회신 #${del.replyEventId}` : ''}`;
      title.append(left, right);
      box.appendChild(title);

      const reply = document.createElement('div');
      reply.className = 'delegation-reply';
      reply.textContent = del.replyText ? del.replyText : '워커 회신 대기 중...';
      box.appendChild(reply);
      card.appendChild(box);
    }

    if (req.finalText) {
      const body = document.createElement('div');
      body.className = 'assistant-body';
      body.textContent = req.finalText;
      card.appendChild(body);
    } else if (req.error) {
      const err = document.createElement('div');
      err.className = 'assistant-error';
      err.textContent = req.error;
      card.appendChild(err);
    } else {
      const pending = document.createElement('div');
      pending.className = 'muted-text';
      pending.textContent = `${statusLabel(req.status)} 진행 중...`;
      card.appendChild(pending);
    }

    group.appendChild(card);
    feed.appendChild(group);
  }

  const scroller = el<HTMLElement>('conversationScroll');
  scroller.scrollTop = scroller.scrollHeight;
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
    const card = document.createElement('div');
    card.className = 'worker-card';

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
    const statusText = document.createElement('span');
    statusText.className = 'muted-text';
    statusText.style.fontSize = '11px';
    statusText.textContent = statusLabel(worker.status);
    top.append(nameWrap, statusText);

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

    const actions = document.createElement('div');
    actions.className = 'worker-actions';
    const startBtn = document.createElement('button');
    startBtn.className = 'btn btn-outline btn-xs';
    startBtn.textContent = worker.status === 'ready' || worker.status === 'working' ? '실행 중' : '시작 / 재개';
    startBtn.disabled = worker.status === 'ready' || worker.status === 'working' || worker.status === 'starting';
    startBtn.addEventListener('click', () => { void runWorkerAction(projectId, worker.workerId, 'start'); });

    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn btn-subtle btn-xs';
    stopBtn.textContent = '중지';
    stopBtn.disabled = worker.status === 'stopped';
    stopBtn.addEventListener('click', () => { void runWorkerAction(projectId, worker.workerId, 'stop'); });
    actions.append(startBtn, stopBtn);

    card.append(top, meta, actions);
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
    'codex.worktree_switched',
    'worker.added',
    'worker.started',
    'worker.stopped',
    'worker.status',
    'worker.worktree_switched',
    'request.accepted',
    'request.codex_running',
    'request.worker_working',
    'request.codex_reviewing',
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
      void refreshActiveProject(projectId, false);
    });
  }

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
      state.activeDetail.latestSeq = Math.max(state.activeDetail.latestSeq, parsed.seq);
      renderHcomMessages();
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
  const data = await api<{
    snapshot: ProjectSnapshot;
    requests: RequestRecord[];
    delegations: DelegationRecord[];
    latestSeq: number;
  }>(`/api/projects/${encodeURIComponent(projectId)}`);
  if (state.selectedProjectId !== projectId) return;

  const existingMessages = state.activeDetail?.snapshot.project.projectId === projectId
    ? state.activeDetail.hcomMessages
    : [];
  state.activeDetail = {
    snapshot: data.snapshot,
    requests: data.requests,
    delegations: data.delegations,
    hcomMessages: existingMessages,
    latestSeq: data.latestSeq,
  };
  await refreshProjectsList();
  renderAll();
  if (reconnectSse) connectSse(projectId, 0);
}

async function selectProject(projectId: string): Promise<void> {
  showNotice(null);
  state.selectedProjectId = projectId;
  await api(`/api/projects/${encodeURIComponent(projectId)}/select`, { method: 'POST' });
  await refreshActiveProject(projectId, true);
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

async function handleSendPrompt(): Promise<void> {
  const projectId = state.selectedProjectId;
  if (!projectId) return;
  const input = el<HTMLTextAreaElement>('promptInput');
  const prompt = input.value.trim();
  if (!prompt) return;

  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  input.value = '';
  try {
    showNotice(null);
    await api(`/api/projects/${encodeURIComponent(projectId)}/requests`, {
      method: 'POST',
      body: JSON.stringify({ requestId, prompt }),
    });
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

  el<HTMLButtonElement>('openAddWorkerBtn').addEventListener('click', () => {
    if (!state.activeDetail) return;
    state.addWorkerTargetProjectId = state.activeDetail.snapshot.project.projectId;
    el<HTMLElement>('addWorkerProjectLabel').textContent = state.activeDetail.snapshot.project.name;
    el<HTMLInputElement>('addWorkerNameInput').value = '';
    el<HTMLInputElement>('addWorkerCwdInput').value = '';
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
    const errBox = el<HTMLDivElement>('addWorkerError');
    const requestKey = `add-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      closeModal('addWorkerModal');
      showNotice(`워커(${name || '새 워커'})를 추가하고 시작하는 중입니다...`);
      await api(`/api/projects/${encodeURIComponent(targetProjectId)}/workers`, {
        method: 'POST',
        body: JSON.stringify({ name, requestKey, ...(cwd ? { cwd } : {}), start: true }),
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
      setTimeout(() => showNotice(null), 2000);
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
  if (state.selectedProjectId) {
    await refreshActiveProject(state.selectedProjectId, true);
  } else {
    renderAll();
  }
}

void bootstrap();
