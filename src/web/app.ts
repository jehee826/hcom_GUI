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
  effortModelMap?: Record<string, string>;
}

interface ModelCatalog {
  codex: ModelOption[];
  agy: ModelOption[];
  codexLive?: boolean;
  agyLive?: boolean;
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
  serviceTier?: string | null;
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  customInstructions: string;
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
  branchStatus: string;
  commitStatus: string;
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
  eventId?: number;
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
  createdAt: string;
  updatedAt: string;
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

interface EventDelta {
  codex?: CodexRecord;
  worker?: WorkerRecord;
  request?: RequestRecord;
  delegations?: DelegationRecord[];
  handoff?: HandoffRecord;
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

interface WorkerTerminalSnapshot {
  ready: boolean;
  blocked: boolean;
  status: string;
  lines: string[];
}

interface WorkerLogsState {
  progress: ProgressLogEntry[];
  transcript: unknown;
  terminal: WorkerTerminalSnapshot | null;
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

interface OptionChoice {
  value: string;
  title: string;
  subtitle?: string;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const FALLBACK_MODELS: ModelCatalog = {
  codex: [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium', isDefault: true },
    { id: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', isDefault: false },
  ],
  agy: [
    { id: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', isDefault: true },
    { id: 'gemini-4-carbon-high', displayName: 'Gemini 4 Carbon (High)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', isDefault: false },
    { id: 'claude-sonnet-5-5-high', displayName: 'Claude Sonnet 5.5 (High)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', isDefault: false },
  ],
  codexLive: false,
  agyLive: false,
  cachedAt: '',
};

const EFFORT_SHORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};

const CODEX_PERMISSION_OPTIONS: OptionChoice[] = [
  { value: 'workspace-write', title: '작업폴더 쓰기', subtitle: '프로젝트 폴더 내부 수정·실행 허용' },
  { value: 'read-only', title: '읽기 전용', subtitle: '분석·조회만 허용, 파일 쓰기 차단' },
  { value: 'danger-full-access', title: '전체 허용', subtitle: '샌드박스 제한 없이 모든 명령 허용' },
];

const WORKER_PERMISSION_OPTIONS: OptionChoice[] = [
  { value: 'always-proceed', title: '자동 진행', subtitle: '등록 폴더 신뢰 · 승인 프롬프트 자동 통과 (권장)' },
  { value: 'ask', title: '매번 승인', subtitle: '명령 실행 시 앱에서 승인/거절 확인' },
  { value: 'read-only', title: '읽기 전용', subtitle: '계획·분석 전용 (파일 수정 제한)' },
];

const PERMISSION_SHORT_LABELS: Record<string, string> = {
  'always-proceed': '자동진행',
  ask: '매번승인',
  'read-only': '읽기전용',
};

const CODEX_SANDBOX_LABELS: Record<string, string> = {
  'workspace-write': '작업폴더 쓰기',
  'read-only': '읽기 전용',
  'danger-full-access': '전체 허용',
};

const ACTIVE_REQUEST_STATUSES = new Set([
  'accepted',
  'codex_running',
  'worker_working',
  'codex_reviewing',
  'waiting_approval',
]);

const PAGE_LIMIT = 30;

const state = {
  config: { baseUrl: window.location.origin, token: '', version: '1.0.0', dataDir: '' } as BridgeConfig,
  projects: [] as ProjectSnapshot[],
  projectSearch: '',
  selectedProjectId: null as string | null,
  composerTarget: 'codex',
  activeDetail: null as {
    snapshot: ProjectSnapshot;
    requests: RequestRecord[];
    delegations: DelegationRecord[];
    progressByRequest: Record<string, ProgressLogEntry[]>;
    hcomMessages: HcomMessageItem[];
    latestSeq: number;
    hasMoreRequests: boolean;
    totalRequests: number;
  } | null,
  models: FALLBACK_MODELS as ModelCatalog,
  modelsLoading: true,
  diagnostics: null as CliDiagnostics | null,
  eventSource: null as EventSource | null,
  addWorkerDraft: {
    projectId: null as string | null,
    model: null as string | null,
    effort: null as string | null,
    permissionMode: 'always-proceed' as WorkerRecord['permissionMode'],
  },
  activePopoverAnchor: null as HTMLElement | null,
  activePopoverRerender: null as (() => void) | null,
  expandedWorkers: new Set<string>(),
  expandedWorkerInternalLogs: new Set<string>(),
  expandedWorkerPrompts: new Set<string>(),
  expandedRequestLogs: new Set<string>(),
  expandedDelegations: new Set<string>(),
  workerLogs: new Map<string, WorkerLogsState>(),
  workerLatestProgress: new Map<string, ProgressLogEntry>(),
  workerChatDrafts: new Map<string, string>(),
  workerAutoApplyTimers: new Map<string, number>(),
  workerLogTabs: new Map<string, 'terminal' | 'events'>(),
  questionDrafts: new Map<string, string>(),
  loadingOlder: false,
  dirtyWhileHidden: false,
  dirtyRequestThinking: new Set<string>(),
  dirtyRequestGroups: new Set<string>(),
  dirtyWorkerSlots: new Set<string>(),
  dirtyWorkersPanel: false,
  dirtyHeader: false,
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

function workerStatusLabel(status: string): string {
  if (status === 'ready' || status === 'working') return '작동 중';
  if (status === 'starting') return '시작 중';
  if (status === 'needs_attention') return '승인 필요';
  if (status === 'error') return '오류';
  return '정지';
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    stopped: '정지',
    starting: '시작 중',
    ready: '작동 중',
    running: '작동 중',
    working: '작업 중',
    needs_attention: '승인/확인 필요',
    disconnected: '연결 끊김',
    error: '오류',
    accepted: '접수',
    codex_running: 'Codex 판단',
    worker_working: '워커 작업 중',
    codex_reviewing: 'Codex 검수',
    waiting_user: '답변 대기',
    waiting_approval: '승인 대기',
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

function shortTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toTimeString().slice(0, 8);
  } catch {
    return '';
  }
}

function koreanClockTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const period = h < 12 ? '오전' : '오후';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${period} ${hour12}:${m}`;
  } catch {
    return '';
  }
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function groupAgyModels(raw: ModelOption[]): ModelOption[] {
  const groups = new Map<string, {
    baseId: string;
    displayName: string;
    effortModelMap: Record<string, string>;
    efforts: string[];
    defaultId: string;
    defaultEffort: string | null;
    isDefault: boolean;
  }>();

  for (const item of raw) {
    const match = item.id.match(/^(.+)-(low|medium|high|xhigh|max|ultra)$/i);
    const effort = match ? match[2]!.toLowerCase() : null;
    const baseId = match ? match[1]! : item.id;
    const cleanName = effort
      ? item.displayName.replace(/\s*\((?:Low|Medium|High|XHigh|Max|Ultra)\)\s*$/i, '').trim()
      : item.displayName;

    let grp = groups.get(baseId);
    if (!grp) {
      grp = {
        baseId,
        displayName: cleanName || baseId,
        effortModelMap: {},
        efforts: [],
        defaultId: item.id,
        defaultEffort: effort ?? item.defaultEffort,
        isDefault: item.isDefault,
      };
      groups.set(baseId, grp);
    }
    if (item.isDefault) {
      grp.isDefault = true;
      grp.defaultId = item.id;
      if (effort) grp.defaultEffort = effort;
    }
    if (effort) {
      grp.effortModelMap[effort] = item.id;
      if (!grp.efforts.includes(effort)) grp.efforts.push(effort);
    }
  }

  const AGY_ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  return [...groups.values()].map(grp => {
    const variantEfforts = [...grp.efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    // agy CLI는 --effort (low|medium|high|xhigh|max)를 모든 세션에서 지원하므로 전체 5단계를 제공한다.
    const fullEfforts = AGY_ALL_EFFORTS;
    const defEffort = grp.defaultEffort && fullEfforts.includes(grp.defaultEffort)
      ? grp.defaultEffort
      : (variantEfforts.at(-1) ?? 'high');
    const defId = (defEffort && grp.effortModelMap[defEffort]) ? grp.effortModelMap[defEffort]! : grp.defaultId;
    return {
      id: defId,
      displayName: grp.displayName,
      efforts: fullEfforts,
      defaultEffort: defEffort,
      isDefault: grp.isDefault,
      ...(Object.keys(grp.effortModelMap).length > 0 ? { effortModelMap: grp.effortModelMap } : {}),
    };
  });
}

function getAgyCatalog(): ModelOption[] {
  return groupAgyModels(state.models.agy);
}

function resolveModelOption(catalog: ModelOption[], modelId: string | null): ModelOption | undefined {
  if (modelId) {
    const exact = catalog.find(m => m.id === modelId);
    if (exact) return exact;
    const byVariant = catalog.find(m => m.effortModelMap && Object.values(m.effortModelMap).includes(modelId));
    if (byVariant) return byVariant;
  }
  return catalog.find(m => m.isDefault) ?? catalog[0];
}

function resolveModelIdForEffort(option: ModelOption | undefined, fallbackModelId: string | null, effort: string | null): string | null {
  if (!option) return fallbackModelId;
  if (option.effortModelMap && effort && option.effortModelMap[effort]) {
    return option.effortModelMap[effort]!;
  }
  return fallbackModelId === null && !option.effortModelMap ? null : option.id;
}

function shortModelLabel(modelId: string | null, catalog: ModelOption[]): string {
  const match = resolveModelOption(catalog, modelId);
  if (modelId) return match ? match.displayName : modelId;
  return match ? match.displayName : '기본 모델';
}

function effortDisplay(effort: string | null, catalog: ModelOption[], modelId: string | null): string {
  if (effort) return EFFORT_LABELS[effort] ?? effort;
  if (modelId) {
    const suffix = modelId.match(/-(low|medium|high|xhigh|max|ultra)$/i)?.[1]?.toLowerCase();
    if (suffix) return EFFORT_LABELS[suffix] ?? suffix;
  }
  const resolved = resolveModelOption(catalog, modelId)?.defaultEffort ?? 'medium';
  return EFFORT_LABELS[resolved] ?? resolved;
}

function effortsForModel(catalog: ModelOption[], modelId: string | null): string[] {
  const matched = resolveModelOption(catalog, modelId);
  return matched && matched.efforts.length > 0 ? matched.efforts : ['low', 'medium', 'high', 'xhigh', 'max'];
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

function createCopySvg(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const front = document.createElementNS(ns, 'rect');
  front.setAttribute('x', '3.5');
  front.setAttribute('y', '6.5');
  front.setAttribute('width', '9.5');
  front.setAttribute('height', '9.5');
  front.setAttribute('rx', '2.4');
  front.setAttribute('stroke', 'currentColor');
  front.setAttribute('stroke-width', '1.5');
  const back = document.createElementNS(ns, 'path');
  back.setAttribute('d', 'M7 6.5V5.9C7 4.57 8.07 3.5 9.4 3.5H14.1C15.43 3.5 16.5 4.57 16.5 5.9V10.6C16.5 11.93 15.43 13 14.1 13H13');
  back.setAttribute('stroke', 'currentColor');
  back.setAttribute('stroke-width', '1.5');
  back.setAttribute('stroke-linecap', 'round');
  svg.append(back, front);
  return svg;
}

function createCheckSvg(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M4.5 10.5L8.2 14.2L15.8 6.4');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.7');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

async function copyText(text: string, btn?: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      if (btn.classList.contains('copy-icon-btn')) {
        clearChildren(btn);
        btn.appendChild(createCheckSvg());
        btn.classList.add('is-copied');
        const prevTitle = btn.title;
        btn.title = '복사됨';
        window.setTimeout(() => {
          clearChildren(btn);
          btn.appendChild(createCopySvg());
          btn.classList.remove('is-copied');
          btn.title = prevTitle || '복사';
        }, 1400);
      } else {
        const prev = btn.textContent;
        btn.textContent = '복사됨';
        window.setTimeout(() => { btn.textContent = prev; }, 1400);
      }
    }
  } catch {}
}

function createCopyIconButton(text: string, title = '복사'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-icon-btn';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(createCopySvg());
  btn.addEventListener('click', event => {
    event.stopPropagation();
    void copyText(text, btn);
  });
  return btn;
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

/* ============================================================================
 * Sleek Custom Popover System (Effort Pill Slider + Clean Option Menus)
 * ========================================================================== */

function closePopover(): void {
  const portal = el<HTMLDivElement>('popoverPortal');
  portal.classList.add('hidden');
  clearChildren(portal);
  state.activePopoverRerender = null;
  if (state.activePopoverAnchor) {
    state.activePopoverAnchor.classList.remove('is-open');
    state.activePopoverAnchor = null;
  }
}

function positionPopover(rect: DOMRect, preferAbove = true): void {
  const portal = el<HTMLDivElement>('popoverPortal');
  portal.classList.remove('hidden');
  const popRect = portal.getBoundingClientRect();
  const margin = 10;

  let top = preferAbove ? rect.top - popRect.height - 8 : rect.bottom + 8;
  if (top < margin) top = rect.bottom + 8;
  if (top + popRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - popRect.height - 8);
  }

  let left = rect.left;
  if (left + popRect.width > window.innerWidth - margin) {
    left = Math.max(margin, rect.right - popRect.width);
  }
  if (left < margin) left = margin;

  portal.style.top = `${Math.round(top)}px`;
  portal.style.left = `${Math.round(left)}px`;
}

function createBoltSvg(filled = false): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M11.2 2.5L4.8 11H10L8.8 17.5L15.2 9H10L11.2 2.5Z');
  p.setAttribute('fill', filled ? 'currentColor' : 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.45');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

function openOptionPopover(config: {
  anchor: HTMLElement;
  title?: string;
  options: OptionChoice[];
  currentValue: string;
  preferAbove?: boolean;
  onSelect: (value: string) => void;
}): void {
  if (state.activePopoverAnchor === config.anchor) {
    closePopover();
    return;
  }
  closePopover();
  state.activePopoverAnchor = config.anchor;
  config.anchor.classList.add('is-open');

  const portal = el<HTMLDivElement>('popoverPortal');
  clearChildren(portal);

  if (config.title) {
    const head = document.createElement('div');
    head.className = 'pop-list-head';
    const lbl = document.createElement('span');
    lbl.className = 'inspector-title';
    lbl.textContent = config.title;
    head.appendChild(lbl);
    portal.appendChild(head);
  }

  const list = document.createElement('div');
  list.className = 'pop-list';
  for (const opt of config.options) {
    const item = document.createElement('button');
    item.type = 'button';
    const isSel = opt.value === config.currentValue;
    item.className = `pop-item${isSel ? ' is-selected' : ''}`;
    item.addEventListener('click', () => {
      closePopover();
      config.onSelect(opt.value);
    });

    const main = document.createElement('div');
    main.className = 'pop-item-main';
    const title = document.createElement('span');
    title.className = 'pop-item-title';
    title.textContent = opt.title;
    main.appendChild(title);
    if (opt.subtitle) {
      const sub = document.createElement('span');
      sub.className = 'pop-item-sub';
      sub.textContent = opt.subtitle;
      main.appendChild(sub);
    }
    item.appendChild(main);

    if (isSel) {
      const chk = document.createElement('span');
      chk.className = 'pop-item-check';
      chk.textContent = '✓';
      item.appendChild(chk);
    }
    list.appendChild(item);
  }
  portal.appendChild(list);
  positionPopover(config.anchor.getBoundingClientRect(), config.preferAbove ?? true);
}

function openModelEffortPopover(config: {
  anchor: HTMLElement;
  source: 'codex' | 'agy';
  currentModel: string | null;
  currentEffort: string | null;
  currentFast?: boolean;
  preferAbove?: boolean;
  onChange: (next: { model: string | null; effort: string | null }) => void;
  onToggleFast?: (fast: boolean) => void;
  applyAction?: { label: string; hint?: string; onApply: (next: { model: string | null; effort: string | null }) => void };
}): void {
  if (state.activePopoverAnchor === config.anchor) {
    closePopover();
    return;
  }
  const anchorRect = config.anchor.getBoundingClientRect();
  closePopover();
  state.activePopoverAnchor = config.anchor;
  config.anchor.classList.add('is-open');

  let view: 'effort' | 'models' = 'effort';
  let selModel = config.currentModel;
  let selEffort = config.currentEffort
    ?? (config.currentModel?.match(/-(low|medium|high|xhigh|max|ultra)$/i)?.[1]?.toLowerCase() ?? null);
  let isFast = Boolean(config.currentFast);
  let hasChanged = false;

  const getLiveCatalog = (): ModelOption[] => (config.source === 'codex' ? state.models.codex : getAgyCatalog());

  const emitChange = (model: string | null, effort: string | null) => {
    selModel = model;
    selEffort = effort;
    hasChanged = true;
    config.onChange({ model: selModel, effort: selEffort });
  };

  const renderInner = () => {
    const portal = el<HTMLDivElement>('popoverPortal');
    clearChildren(portal);
    const catalog = getLiveCatalog();

    if (view === 'models') {
      const head = document.createElement('div');
      head.className = 'pop-list-head';
      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'pop-back-btn';
      backBtn.textContent = '‹ 추론 강도';
      backBtn.addEventListener('click', () => {
        view = 'effort';
        renderInner();
      });
      head.appendChild(backBtn);
      portal.appendChild(head);

      const list = document.createElement('div');
      list.className = 'pop-list';

      const defaultItem = document.createElement('button');
      defaultItem.type = 'button';
      defaultItem.className = `pop-item${!selModel ? ' is-selected' : ''}`;
      defaultItem.addEventListener('click', () => {
        emitChange(null, selEffort);
        view = 'effort';
        renderInner();
      });
      const defMain = document.createElement('div');
      defMain.className = 'pop-item-main';
      const defTitle = document.createElement('span');
      defTitle.className = 'pop-item-title';
      defTitle.textContent = 'CLI 기본 모델';
      defMain.appendChild(defTitle);
      defaultItem.appendChild(defMain);
      if (!selModel) {
        const chk = document.createElement('span');
        chk.className = 'pop-item-check';
        chk.textContent = '✓';
        defaultItem.appendChild(chk);
      }
      list.appendChild(defaultItem);

      const currentFamily = resolveModelOption(catalog, selModel);
      for (const m of catalog) {
        const item = document.createElement('button');
        item.type = 'button';
        const isSel = Boolean(selModel && currentFamily?.id === m.id);
        item.className = `pop-item${isSel ? ' is-selected' : ''}`;
        item.addEventListener('click', () => {
          const allowed = m.efforts;
          const nextEff = selEffort && allowed.includes(selEffort)
            ? selEffort
            : (m.defaultEffort ?? allowed[0] ?? null);
          const nextModelId = resolveModelIdForEffort(m, m.id, nextEff);
          emitChange(nextModelId, nextEff);
          view = 'effort';
          renderInner();
        });
        const main = document.createElement('div');
        main.className = 'pop-item-main';
        const title = document.createElement('span');
        title.className = 'pop-item-title';
        title.textContent = m.displayName;
        const sub = document.createElement('span');
        sub.className = 'pop-item-sub';
        sub.textContent = m.efforts.map(e => EFFORT_SHORT_LABELS[e] ?? e).join(' · ');
        main.append(title, sub);
        item.appendChild(main);
        if (isSel) {
          const chk = document.createElement('span');
          chk.className = 'pop-item-check';
          chk.textContent = '✓';
          item.appendChild(chk);
        }
        list.appendChild(item);
      }
      portal.appendChild(list);
      positionPopover(anchorRect, config.preferAbove ?? true);
      return;
    }

    // Effort Stepped Pill Slider View
    const activeOpt = resolveModelOption(catalog, selModel);
    const efforts = effortsForModel(catalog, selModel);
    const effectiveEffort = selEffort && efforts.includes(selEffort)
      ? selEffort
      : (activeOpt?.defaultEffort ?? efforts[Math.floor(efforts.length / 2)] ?? efforts[0]!);
    const activeIdx = Math.max(0, efforts.indexOf(effectiveEffort));

    const card = document.createElement('div');
    card.className = 'effort-card';

    const head = document.createElement('div');
    head.className = 'effort-card-head';

    if (config.onToggleFast) {
      const fastBtn = document.createElement('button');
      fastBtn.type = 'button';
      fastBtn.className = `effort-fast-btn${isFast ? ' is-active' : ''}`;
      fastBtn.setAttribute('aria-pressed', String(isFast));
      fastBtn.title = isFast ? 'Fast 모드 켜짐 (클릭하여 끄기)' : 'Fast 모드 꺼짐 (클릭하여 켜기)';
      fastBtn.appendChild(createBoltSvg(isFast));
      fastBtn.addEventListener('click', () => {
        isFast = !isFast;
        config.onToggleFast?.(isFast);
        renderInner();
      });
      head.appendChild(fastBtn);
    } else {
      const leftSpacer = document.createElement('span');
      leftSpacer.className = 'effort-head-spacer';
      head.appendChild(leftSpacer);
    }

    const center = document.createElement('div');
    center.className = 'effort-head-center';
    const title = document.createElement('div');
    title.className = 'effort-current-title';
    title.textContent = EFFORT_LABELS[effectiveEffort] ?? effectiveEffort;
    const modelBtn = document.createElement('button');
    modelBtn.type = 'button';
    modelBtn.className = 'effort-model-link';
    modelBtn.textContent = `${shortModelLabel(selModel, catalog)} ›`;
    modelBtn.addEventListener('click', () => {
      view = 'models';
      renderInner();
    });
    center.append(title, modelBtn);

    const rightSpacer = document.createElement('span');
    rightSpacer.className = 'effort-head-spacer';
    head.append(center, rightSpacer);

    const applyEffortChoice = (chosen: string) => {
      const nextModelId = activeOpt?.effortModelMap
        ? resolveModelIdForEffort(activeOpt, selModel, chosen)
        : selModel;
      emitChange(nextModelId, chosen);
      renderInner();
    };

    const track = document.createElement('div');
    track.className = `effort-track${isFast ? ' is-fast' : ''}`;
    const fill = document.createElement('div');
    fill.className = `effort-track-fill${isFast ? ' is-fast' : ''}`;
    const ratio = efforts.length > 1 ? activeIdx / (efforts.length - 1) : 1;
    fill.style.width = `calc(${Math.round(ratio * 100)}% + ${Math.round((1 - ratio) * 28)}px)`;
    track.appendChild(fill);

    for (let i = 0; i < efforts.length; i++) {
      const eff = efforts[i]!;
      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = `effort-stop${i < activeIdx ? ' is-filled' : ''}${i === activeIdx ? ' is-active' : ''}`;
      stopBtn.title = EFFORT_LABELS[eff] ?? eff;
      const dot = document.createElement('span');
      dot.className = 'effort-stop-dot';
      stopBtn.appendChild(dot);
      stopBtn.addEventListener('click', event => {
        event.stopPropagation();
        applyEffortChoice(eff);
      });
      track.appendChild(stopBtn);
    }

    track.addEventListener('click', event => {
      const rect = track.getBoundingClientRect();
      const rel = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const idx = Math.round(rel * (efforts.length - 1));
      const chosen = efforts[idx];
      if (chosen) applyEffortChoice(chosen);
    });

    card.append(head, track);

    if (config.applyAction && hasChanged) {
      const applyRow = document.createElement('div');
      applyRow.className = 'pop-apply-row';
      const hint = document.createElement('span');
      hint.className = 'pop-apply-hint';
      hint.textContent = config.applyAction.hint ?? '실행 중 워커에 바로 반영';
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'btn btn-accent btn-xs';
      applyBtn.textContent = config.applyAction.label;
      applyBtn.addEventListener('click', () => {
        const next = { model: selModel, effort: selEffort };
        closePopover();
        config.applyAction!.onApply(next);
      });
      applyRow.append(hint, applyBtn);
      card.appendChild(applyRow);
    }

    portal.appendChild(card);
    positionPopover(anchorRect, config.preferAbove ?? true);
  };

  state.activePopoverRerender = renderInner;
  renderInner();
}

/* ============================================================================
 * 100% XSS-safe Lightweight Markdown + Codex-style Code Block Renderer
 * ========================================================================== */

function appendInlineMarkdown(parent: HTMLElement, text: string): void {
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0]!;
    if (token.startsWith('**') && token.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      const code = document.createElement('code');
      code.className = 'md-inline-code';
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function renderMarkdownSafe(text: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'assistant-body';

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^```([a-zA-Z0-9._+-]*)\s*$/);
    if (fence) {
      const lang = fence[1]?.trim() || '일반 텍스트';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      const codeText = codeLines.join('\n');

      const card = document.createElement('div');
      card.className = 'md-code-card';
      const head = document.createElement('div');
      head.className = 'md-code-head';
      const langLabel = document.createElement('span');
      langLabel.className = 'md-code-lang';
      langLabel.textContent = `</> ${lang}`;
      const copyBtn = createCopyIconButton(codeText, '코드 복사');
      head.append(langLabel, copyBtn);

      const pre = document.createElement('pre');
      pre.className = 'md-code-pre';
      const code = document.createElement('code');
      code.textContent = codeText;
      pre.appendChild(code);
      card.append(head, pre);
      root.appendChild(card);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const h = document.createElement('div');
      h.className = `md-h md-h${level}`;
      appendInlineMarkdown(h, heading[2]!.trim());
      root.appendChild(h);
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const ul = document.createElement('ul');
      ul.className = 'md-ul';
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        const li = document.createElement('li');
        appendInlineMarkdown(li, lines[i]!.replace(/^\s*[-*]\s+/, ''));
        ul.appendChild(li);
        i++;
      }
      root.appendChild(ul);
      continue;
    }

    // Markdown table: header row | ... | followed by separator row | --- | --- |
    if (
      line.includes('|')
      && i + 1 < lines.length
      && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1]!)
    ) {
      const parseCells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const headers = parseCells(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
        bodyRows.push(parseCells(lines[i]!));
        i++;
      }
      const wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';
      const table = document.createElement('table');
      table.className = 'md-table';
      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      for (const hCell of headers) {
        const th = document.createElement('th');
        appendInlineMarkdown(th, hCell);
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      table.appendChild(thead);
      if (bodyRows.length > 0) {
        const tbody = document.createElement('tbody');
        for (const rCells of bodyRows) {
          const tr = document.createElement('tr');
          for (let c = 0; c < headers.length; c++) {
            const td = document.createElement('td');
            appendInlineMarkdown(td, rCells[c] ?? '');
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
      }
      wrap.appendChild(table);
      root.appendChild(wrap);
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length
      && lines[i]!.trim()
      && !lines[i]!.startsWith('```')
      && !/^#{1,3}\s+/.test(lines[i]!)
      && !/^\s*[-*]\s+/.test(lines[i]!)
      && !(lines[i]!.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1]!))
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    const p = document.createElement('p');
    p.className = 'md-p';
    for (let j = 0; j < paraLines.length; j++) {
      if (j > 0) p.appendChild(document.createElement('br'));
      appendInlineMarkdown(p, paraLines[j]!);
    }
    root.appendChild(p);
  }
  return root;
}

/* ============================================================================
 * Renderers
 * ========================================================================== */

function renderDiagnostics(): void {
  const diag = state.diagnostics;
  const dot = el<HTMLSpanElement>('diagDot');
  const mini = el<HTMLDivElement>('cliMiniList');
  const detail = el<HTMLDivElement>('diagnosticsDetail');
  clearChildren(mini);
  clearChildren(detail);
  if (!diag) {
    const wait = document.createElement('span');
    wait.className = 'muted-text';
    wait.style.fontSize = '11px';
    wait.textContent = 'CLI 확인 중...';
    mini.appendChild(wait);
    return;
  }

  const entries: Array<[string, CliCheck]> = [
    ['Codex', diag.codex],
    ['hcom', diag.hcom],
    ['agy', diag.agy],
  ];
  const allOk = entries.every(([, item]) => item.ok);
  dot.className = `rail-dot ${allOk ? 'dot-ready' : 'dot-working'}`;

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

function createFolderSvg(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('class', 'project-folder-svg');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2 4.8C2 3.9 2.7 3.2 3.6 3.2H6.4L7.7 4.6H12.4C13.3 4.6 14 5.3 14 6.2V11.4C14 12.3 13.3 13 12.4 13H3.6C2.7 13 2 12.3 2 11.4V4.8Z');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.35');
  svg.appendChild(path);
  return svg;
}

function renderProjectList(): void {
  const container = el<HTMLDivElement>('projectList');
  clearChildren(container);
  const query = state.projectSearch.trim().toLowerCase();
  const filtered = query
    ? state.projects.filter(s =>
      s.project.name.toLowerCase().includes(query)
      || s.project.rootPath.toLowerCase().includes(query)
      || s.handoff.branchStatus.toLowerCase().includes(query),
    )
    : state.projects;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted-text';
    empty.style.padding = '12px 8px';
    empty.style.fontSize = '12px';
    empty.textContent = query ? '검색된 프로젝트가 없습니다.' : '등록된 프로젝트가 없습니다.';
    container.appendChild(empty);
    return;
  }

  for (const snap of filtered) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `project-item${snap.project.projectId === state.selectedProjectId ? ' active' : ''}`;
    btn.dataset.projectId = snap.project.projectId;
    btn.addEventListener('click', () => { void selectProject(snap.project.projectId); });

    const top = document.createElement('div');
    top.className = 'project-item-row';
    const left = document.createElement('div');
    left.className = 'project-item-left';
    const name = document.createElement('span');
    name.className = 'project-item-name';
    name.textContent = snap.project.name;
    left.append(createFolderSvg(), name);

    const dot = document.createElement('span');
    dot.className = `status-dot ${statusDotClass(snap.codex.status)}`;
    dot.title = `Codex: ${statusLabel(snap.codex.status)}`;
    top.append(left, dot);

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

function renderHeaderAndComposer(): void {
  const detail = state.activeDetail;
  const headerName = el<HTMLSpanElement>('headerProjectName');
  const emptyState = el<HTMLDivElement>('emptyState');
  const feedContainer = el<HTMLDivElement>('feedContainer');
  const input = el<HTMLTextAreaElement>('promptInput');
  const sendBtn = el<HTMLButtonElement>('sendBtn');
  const targetBtn = el<HTMLButtonElement>('targetPickerBtn');
  const permBtn = el<HTMLButtonElement>('codexPermPickerBtn');
  const modelBtn = el<HTMLButtonElement>('codexModelEffortBtn');
  const addWorkerBtn = el<HTMLButtonElement>('openAddWorkerBtn');
  const instBtn = el<HTMLButtonElement>('instructionsModalBtn');
  const instDot = el<HTMLSpanElement>('instructionsDot');

  if (!detail) {
    headerName.textContent = '프로젝트를 선택하세요';
    emptyState.classList.remove('hidden');
    feedContainer.classList.add('hidden');
    el<HTMLDivElement>('turnMinimap').classList.add('hidden');
    input.disabled = true;
    sendBtn.disabled = true;
    targetBtn.disabled = true;
    permBtn.disabled = true;
    modelBtn.disabled = true;
    addWorkerBtn.disabled = true;
    instBtn.disabled = true;
    instDot.classList.add('hidden');
    return;
  }

  const { project, codex, workers } = detail.snapshot;
  headerName.textContent = project.name;
  headerName.title = codex.cwd;

  emptyState.classList.add('hidden');
  feedContainer.classList.remove('hidden');

  // Ensure selected composer target still exists
  if (state.composerTarget.startsWith('worker:')) {
    const wid = state.composerTarget.slice('worker:'.length);
    if (!workers.some(w => w.workerId === wid)) state.composerTarget = 'codex';
  }
  const activeTargetWorker = state.composerTarget.startsWith('worker:')
    ? workers.find(w => `worker:${w.workerId}` === state.composerTarget)
    : undefined;

  targetBtn.disabled = false;
  el<HTMLSpanElement>('targetPickerLabel').textContent = activeTargetWorker ? `직접 · ${activeTargetWorker.name}` : 'Codex';

  permBtn.disabled = false;
  el<HTMLSpanElement>('codexPermPickerLabel').textContent = CODEX_SANDBOX_LABELS[codex.sandboxMode] ?? codex.sandboxMode;

  modelBtn.disabled = false;
  const isFastOn = codex.serviceTier === 'priority' || codex.serviceTier === 'fast';
  document.getElementById('codexFastIcon')?.classList.toggle('hidden', !isFastOn);
  el<HTMLSpanElement>('codexModelLabel').textContent = shortModelLabel(codex.model, state.models.codex);
  el<HTMLSpanElement>('codexEffortLabel').textContent = effortDisplay(codex.reasoningEffort, state.models.codex, codex.model);

  input.disabled = false;
  sendBtn.disabled = false;
  input.placeholder = activeTargetWorker
    ? `${activeTargetWorker.name}에게 직접 메시지를 보내세요`
    : 'Codex와 함께 작업하세요';

  addWorkerBtn.disabled = false;
  instBtn.disabled = false;
  instDot.classList.toggle('hidden', !codex.customInstructions?.trim());
}

function getRequestProgressEntries(req: RequestRecord): ProgressLogEntry[] {
  const live = state.activeDetail?.progressByRequest[req.requestId];
  if (live && live.length > 0) return live;
  return req.progressSummary ?? [];
}

function buildThinkingBox(req: RequestRecord): HTMLElement {
  const allEntries = getRequestProgressEntries(req);
  // commentary(사용자에게 직접 안내하는 진행 문구)는 본문에 상시 표시하므로 접히는 내부 로그에서는 제외한다.
  const entries = allEntries.filter(entry => entry.kind !== 'commentary');
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
    if (state.expandedRequestLogs.has(req.requestId)) state.expandedRequestLogs.delete(req.requestId);
    else state.expandedRequestLogs.add(req.requestId);
    patchRequestThinkingSlot(req.requestId);
  });

  const dot = document.createElement('span');
  dot.className = `thinking-dot ${isActive ? 'active' : (req.status === 'completed' ? 'done' : '')}`;

  const summary = document.createElement('span');
  summary.className = 'thinking-summary';
  summary.textContent = latest
    ? latest.summary
    : (isActive ? `${statusLabel(req.status)} 중...` : `${statusLabel(req.status)}`);

  const meta = document.createElement('span');
  meta.className = 'thinking-meta';
  meta.textContent = `${entries.length > 0 ? `로그 ${entries.length} ` : ''}${isExpanded ? '▴' : '▾'}`;

  toggle.append(dot, summary, meta);
  box.appendChild(toggle);

  if (isExpanded) {
    const panel = document.createElement('div');
    panel.className = 'thinking-log-panel';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted-text';
      empty.style.fontSize = '12px';
      empty.textContent = isActive
        ? 'AI 추론 및 도구 실행 로그를 수신 대기 중입니다...'
        : '저장된 추론·도구 로그가 없습니다.';
      panel.appendChild(empty);
    } else {
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'thinking-log-row';
        const rowMeta = document.createElement('div');
        rowMeta.className = 'thinking-log-meta';
        const src = document.createElement('span');
        src.textContent = `${entry.source === 'codex' ? 'Codex' : '워커'} · ${progressKindLabel(entry.kind)}`;
        const time = document.createElement('span');
        time.textContent = shortTime(entry.ts);
        rowMeta.append(src, time);

        const sum = document.createElement('div');
        sum.className = 'thinking-log-summary';
        sum.textContent = entry.summary;
        row.append(rowMeta, sum);

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

function buildRequestGroupElement(req: RequestRecord, projectId: string, _workerById: Map<string, WorkerRecord>): HTMLElement {
  const group = document.createElement('div');
  group.className = 'request-group';
  group.dataset.requestGroup = req.requestId;

  const userWrap = document.createElement('div');
  userWrap.className = 'user-bubble-wrap';
  const bubble = document.createElement('div');
  bubble.className = 'user-bubble';
  bubble.textContent = req.prompt;
  const userActions = document.createElement('div');
  userActions.className = 'user-bubble-actions';
  const userTime = document.createElement('span');
  userTime.className = 'user-bubble-time';
  userTime.textContent = koreanClockTime(req.createdAt);
  userActions.append(userTime, createCopyIconButton(req.prompt, '메시지 복사'));
  userWrap.append(bubble, userActions);
  group.appendChild(userWrap);

  const turn = document.createElement('div');
  turn.className = 'assistant-turn';
  turn.appendChild(buildThinkingBox(req));

  // 오케스트레이터의 사용자 안내 문구(commentary)는 로그가 닫혀 있어도 본문에 바로 표시한다.
  const commentaryEntries = getRequestProgressEntries(req).filter(e => e.kind === 'commentary');
  if (commentaryEntries.length > 0) {
    const commentaryWrap = document.createElement('div');
    commentaryWrap.className = 'assistant-commentary';
    const seenTexts = new Set<string>();
    for (const c of commentaryEntries) {
      const text = (c.detail ?? c.summary).trim();
      if (!text || seenTexts.has(text)) continue;
      seenTexts.add(text);
      commentaryWrap.appendChild(renderMarkdownSafe(text));
    }
    if (commentaryWrap.childNodes.length > 0) {
      turn.appendChild(commentaryWrap);
    }
  }

  if (req.status === 'waiting_approval' && req.pendingApproval) {
    const approval = req.pendingApproval;
    const appBox = document.createElement('div');
    appBox.className = 'approval-box';
    const appTitle = document.createElement('div');
    appTitle.className = 'approval-title';
    appTitle.textContent = `워커(${approval.workerName}) 승인 대기 · ${approval.context || '명령/도구 실행 확인'}`;
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
    turn.appendChild(appBox);
  }

  for (const entry of req.userReplies) {
    const note = document.createElement('div');
    note.className = 'user-reply-note';
    note.textContent = `Q. ${entry.question}\nA. ${entry.answer}`;
    turn.appendChild(note);
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
    turn.appendChild(qBox);
  } else if (req.finalText) {
    turn.appendChild(renderMarkdownSafe(req.finalText));
  } else if (req.error) {
    const err = document.createElement('div');
    err.className = 'assistant-error';
    err.textContent = `[${statusLabel(req.status)}] ${req.error}`;
    turn.appendChild(err);
  }

  const footer = document.createElement('div');
  footer.className = 'assistant-footer';

  const copyPayload = req.finalText
    || commentaryEntries.map(c => (c.detail ?? c.summary).trim()).filter(Boolean).join('\n\n')
    || '';
  if (copyPayload) {
    footer.appendChild(createCopyIconButton(copyPayload, '응답 복사'));
  }

  const isCancellable = ['accepted', 'codex_running', 'worker_working', 'codex_reviewing', 'waiting_user', 'waiting_approval'].includes(req.status);
  if (isCancellable) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'footer-icon-btn';
    cancelBtn.textContent = '취소';
    cancelBtn.addEventListener('click', () => { void handleCancelRequest(projectId, req.requestId); });
    footer.appendChild(cancelBtn);
  }

  const stagePill = document.createElement('span');
  const pillVariant = req.status === 'waiting_user' || req.status === 'waiting_approval'
    ? 'waiting'
    : req.status === 'failed' || req.status === 'timed_out'
      ? 'failed'
      : '';
  stagePill.className = `stage-pill${pillVariant ? ` ${pillVariant}` : ''}`;
  stagePill.textContent = `${req.mode === 'direct_worker' ? '직접 · ' : ''}${statusLabel(req.status)}${req.round > 1 ? ` (${req.round}차)` : ''}`;
  footer.appendChild(stagePill);

  const timeSpan = document.createElement('span');
  timeSpan.textContent = koreanClockTime(req.updatedAt || req.createdAt);
  footer.appendChild(timeSpan);

  turn.appendChild(footer);
  group.appendChild(turn);
  return group;
}

function renderTurnMinimap(): void {
  const minimap = el<HTMLDivElement>('turnMinimap');
  clearChildren(minimap);
  const detail = state.activeDetail;
  const codexRequests = detail ? detail.requests.filter(r => r.mode !== 'direct_worker') : [];
  if (!detail || codexRequests.length < 2) {
    minimap.classList.add('hidden');
    return;
  }
  minimap.classList.remove('hidden');
  for (const req of codexRequests.slice(-24)) {
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'minimap-tick';
    tick.title = req.prompt.slice(0, 60);
    tick.addEventListener('click', () => {
      const target = document.querySelector<HTMLElement>(`[data-request-group="${CSS.escape(req.requestId)}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    minimap.appendChild(tick);
  }
}

function patchRequestThinkingSlot(requestId: string): void {
  const detail = state.activeDetail;
  if (!detail) return;
  const req = detail.requests.find(r => r.requestId === requestId);
  if (!req || req.mode === 'direct_worker') return;
  const existing = document.querySelector<HTMLElement>(`[data-request-thinking="${CSS.escape(requestId)}"]`);
  if (!existing || !existing.parentElement) return;
  existing.parentElement.replaceChild(buildThinkingBox(req), existing);
}

function patchRequestGroup(requestId: string): void {
  const detail = state.activeDetail;
  if (!detail) return;
  const req = detail.requests.find(r => r.requestId === requestId);
  if (!req || req.mode === 'direct_worker') return;
  const feed = el<HTMLDivElement>('messageFeed');
  const scroller = el<HTMLElement>('conversationScroll');
  const wasNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 72;
  const projectId = detail.snapshot.project.projectId;
  const workerById = new Map(detail.snapshot.workers.map(w => [w.workerId, w]));
  const nextEl = buildRequestGroupElement(req, projectId, workerById);
  const existing = feed.querySelector<HTMLElement>(`[data-request-group="${CSS.escape(requestId)}"]`);
  if (existing) {
    existing.replaceWith(nextEl);
  } else {
    const emptyCard = feed.querySelector('.welcome-placeholder');
    if (emptyCard) emptyCard.remove();
    feed.appendChild(nextEl);
    renderTurnMinimap();
  }
  if (wasNearBottom) scroller.scrollTop = scroller.scrollHeight;
}

function renderMessages(): void {
  const feed = el<HTMLDivElement>('messageFeed');
  const scroller = el<HTMLElement>('conversationScroll');
  const loadOlderWrap = el<HTMLDivElement>('loadOlderWrap');
  const loadOlderBtn = el<HTMLButtonElement>('loadOlderBtn');
  const wasNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 72;
  clearChildren(feed);
  const detail = state.activeDetail;
  if (!detail) return;

  if (detail.hasMoreRequests) {
    loadOlderWrap.classList.remove('hidden');
    loadOlderBtn.disabled = state.loadingOlder;
    loadOlderBtn.textContent = state.loadingOlder
      ? '불러오는 중...'
      : `이전 대화 더 불러오기 (${detail.requests.length}/${detail.totalRequests})`;
  } else {
    loadOlderWrap.classList.add('hidden');
  }

  const codexRequests = detail.requests.filter(r => r.mode !== 'direct_worker');
  if (codexRequests.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'empty-card welcome-placeholder';
    placeholder.style.margin = '48px auto 0';
    const title = document.createElement('h1');
    title.textContent = `${detail.snapshot.project.name}`;
    const desc = document.createElement('p');
    desc.textContent = '아래 입력창에서 바로 Codex에게 지시하거나, 우측 워커를 펼쳐 직접 대화 및 로그 확인을 진행할 수 있습니다.';
    placeholder.append(title, desc);
    feed.appendChild(placeholder);
    renderTurnMinimap();
    return;
  }

  const projectId = detail.snapshot.project.projectId;
  const workerById = new Map(detail.snapshot.workers.map(w => [w.workerId, w]));
  for (const req of codexRequests) {
    feed.appendChild(buildRequestGroupElement(req, projectId, workerById));
  }
  renderTurnMinimap();
  if (wasNearBottom) scroller.scrollTop = scroller.scrollHeight;
}

function renderHcomMessages(): void {
  const detail = state.activeDetail;
  const count = el<HTMLSpanElement>('hcomLogCount');
  const list = el<HTMLDivElement>('hcomLogList');
  const actDot = el<HTMLSpanElement>('activityDot');
  const actTxt = el<HTMLSpanElement>('activitySummaryText');
  clearChildren(list);

  const items = detail?.hcomMessages ?? [];
  count.textContent = String(items.length);

  if (detail) {
    const workingCount = detail.snapshot.workers.filter(w => w.status === 'working').length;
    const readyCount = detail.snapshot.workers.filter(w => w.status === 'ready').length;
    actDot.className = `status-dot ${workingCount > 0 ? 'dot-working' : (readyCount > 0 ? 'dot-ready' : 'dot-stopped')}`;
    actTxt.textContent = workingCount > 0 ? `hcom · 작업 중 ${workingCount}` : 'hcom 활동';
  } else {
    actDot.className = 'status-dot dot-stopped';
    actTxt.textContent = 'hcom 활동';
  }

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted-text';
    empty.style.fontSize = '11.5px';
    empty.style.padding = '4px 2px';
    empty.textContent = 'hcom 메시지가 아직 없습니다.';
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
    intent.textContent = `${item.intent ?? 'msg'}${item.replyTo ? ` (#${item.replyTo})` : ''}`;
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

  for (const item of rawList.slice(-8)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const ts = typeof obj.timestamp === 'string' ? shortTime(obj.timestamp) : '';
    const action = typeof obj.action === 'string' ? obj.action.trim() : '';
    const assistantText = typeof obj.assistant === 'string' ? obj.assistant.trim() : '';
    const tools = Array.isArray(obj.tools) ? obj.tools : [];
    const edits = Array.isArray(obj.edits) ? obj.edits : [];
    const errors = Array.isArray(obj.errors) ? obj.errors : [];

    for (const tool of tools.slice(0, 5)) {
      if (tool && typeof tool === 'object') {
        const t = tool as Record<string, unknown>;
        const tName = typeof t.name === 'string' ? t.name : 'tool';
        const tDetail = typeof t.input === 'string'
          ? t.input
          : (typeof t.command === 'string' ? t.command : (typeof t.output === 'string' ? t.output : ''));
        out.push({ label: `도구 · ${tName}`, time: ts, text: (tDetail || tName).slice(0, 200) });
      }
    }
    if (edits.length > 0) {
      const files = edits
        .map(e => (e && typeof e === 'object' && typeof (e as Record<string, unknown>).file === 'string') ? String((e as Record<string, unknown>).file) : '')
        .filter(Boolean);
      if (files.length > 0) out.push({ label: '파일 수정', time: ts, text: files.join(', ') });
    }
    if (errors.length > 0) out.push({ label: '오류', time: ts, text: errors.map(String).join('\n').slice(0, 200) });
    const body = action || assistantText;
    if (body) out.push({ label: '워커 생각·응답', time: ts, text: body.slice(0, 280) });
  }
  return out;
}

function extractTranscriptReports(transcript: unknown): Array<{ prompt: string; report: string; time: string }> {
  const out: Array<{ prompt: string; report: string; time: string }> = [];
  const rawList = Array.isArray(transcript)
    ? transcript
    : (transcript && typeof transcript === 'object' && Array.isArray((transcript as Record<string, unknown>).exchanges))
      ? (transcript as Record<string, unknown>).exchanges as unknown[]
      : [];

  for (const item of rawList.slice(-6)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const ts = typeof obj.timestamp === 'string' ? shortTime(obj.timestamp) : '';
    const userPrompt = typeof obj.user === 'string'
      ? obj.user.trim()
      : (typeof obj.prompt === 'string' ? obj.prompt.trim() : '');
    const assistantText = typeof obj.assistant === 'string' ? obj.assistant.trim() : '';
    const action = typeof obj.action === 'string' ? obj.action.trim() : '';
    const report = assistantText || action;
    if (!report) continue;
    out.push({ prompt: userPrompt, report, time: ts });
  }
  return out;
}

interface WorkerReportItem {
  id: string;
  sender: 'codex' | 'user' | 'unknown';
  status: string;
  time: string;
  prompt: string;
  report: string | null;
  requestEventId: number | null;
  replyEventId: number | null;
  sortKey: number;
}

function collectWorkerReports(projectId: string, workerId: string): WorkerReportItem[] {
  const detail = state.activeDetail;
  const items: WorkerReportItem[] = [];
  if (detail && detail.snapshot.project.projectId === projectId) {
    const reqById = new Map(detail.requests.map(r => [r.requestId, r]));
    const delegationByReqId = new Map<string, DelegationRecord>();
    for (const del of detail.delegations) {
      if (del.workerId === workerId) delegationByReqId.set(del.requestId, del);
    }

    for (const del of detail.delegations) {
      if (del.workerId !== workerId) continue;
      const parentReq = reqById.get(del.requestId);
      if (parentReq?.mode === 'direct_worker') continue;
      const ts = parentReq?.updatedAt ?? parentReq?.createdAt ?? '';
      items.push({
        id: `del:${del.delegationId}`,
        sender: 'codex',
        status: del.status === 'replied' || del.status === 'reviewed'
          ? 'completed'
          : (del.status === 'sent' ? 'working' : del.status),
        time: ts ? shortTime(ts) : '',
        prompt: del.prompt,
        report: del.replyText ?? del.summaryText ?? null,
        requestEventId: del.requestEventId,
        replyEventId: del.replyEventId,
        sortKey: (parentReq?.createdAt ? Date.parse(parentReq.createdAt) : 0) + del.round * 10,
      });
    }

    for (const req of detail.requests) {
      if (req.mode !== 'direct_worker' || req.targetWorkerId !== workerId) continue;
      const linkedDel = delegationByReqId.get(req.requestId);
      items.push({
        id: `req:${req.requestId}`,
        sender: 'user',
        status: req.status,
        time: shortTime(req.updatedAt || req.createdAt),
        prompt: req.prompt,
        report: req.finalText ?? req.error ?? null,
        requestEventId: linkedDel?.requestEventId ?? null,
        replyEventId: linkedDel?.replyEventId ?? null,
        sortKey: Date.parse(req.createdAt) || 0,
      });
    }
  }

  if (items.length > 0) {
    items.sort((a, b) => a.sortKey - b.sortKey);
    return items.slice(-20);
  }

  // 앱 이력이 아직 없으면 transcript의 최근 대화를 같은 채팅 흐름으로 표시
  const logs = state.workerLogs.get(`${projectId}:${workerId}`);
  const fromTranscript = extractTranscriptReports(logs?.transcript);
  return fromTranscript.map((entry, idx) => ({
    id: `tr:${idx}`,
    sender: 'unknown',
    status: 'completed',
    time: entry.time,
    prompt: entry.prompt,
    report: entry.report,
    requestEventId: null,
    replyEventId: null,
    sortKey: idx,
  }));
}

function filterWorkerStepsForTurn(
  logs: WorkerLogsState | undefined,
  item?: Pick<WorkerReportItem, 'requestEventId' | 'replyEventId'>,
): ProgressLogEntry[] {
  const all = logs?.progress ?? [];
  if (!item || item.requestEventId === null) {
    return all.slice(-30);
  }
  const minId = item.requestEventId;
  const maxId = item.replyEventId;
  const scoped = all.filter(entry =>
    typeof entry.eventId === 'number'
    && entry.eventId >= minId
    && (maxId === null || entry.eventId <= maxId),
  );
  return scoped.length > 0 ? scoped : all.slice(-20);
}

function buildWorkerInternalLogPanel(
  projectId: string,
  workerId: string,
  logKey: string,
  logs: WorkerLogsState | undefined,
  turnScope?: Pick<WorkerReportItem, 'requestEventId' | 'replyEventId'>,
): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'thinking-log-panel worker-inline-log-panel';

  if (!logs || logs.loading) {
    const loading = document.createElement('div');
    loading.className = 'muted-text';
    loading.style.fontSize = '11.5px';
    loading.textContent = '도구·명령·파일 변경 로그 불러오는 중...';
    panel.appendChild(loading);
    return panel;
  }

  if (logs.error) {
    const err = document.createElement('div');
    err.className = 'error-text';
    err.textContent = logs.error;
    panel.appendChild(err);
    return panel;
  }

  // 오케스트레이터 thinking-log-panel과 동일한 구조화 단계 목록 (도구 호출 · 명령어 입력 · 파일 변경 · 승인)
  const steps = filterWorkerStepsForTurn(logs, turnScope);
  const transcriptEntries = extractTranscriptEntries(logs.transcript);

  if (steps.length === 0 && transcriptEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted-text';
    empty.style.fontSize = '11.5px';
    empty.textContent = '기록된 도구 호출 · 명령어 · 파일 변경 로그가 없습니다.';
    panel.appendChild(empty);
  } else {
    for (const step of steps) {
      const row = document.createElement('div');
      row.className = 'thinking-log-row';
      const rowMeta = document.createElement('div');
      rowMeta.className = 'thinking-log-meta';
      const kindSpan = document.createElement('span');
      kindSpan.textContent = `워커 · ${progressKindLabel(step.kind)}`;
      const timeSpan = document.createElement('span');
      timeSpan.textContent = shortTime(step.ts);
      rowMeta.append(kindSpan, timeSpan);

      const sum = document.createElement('div');
      sum.className = 'thinking-log-summary';
      sum.textContent = step.summary;
      row.append(rowMeta, sum);

      if (step.detail && step.detail.trim() && step.detail.trim() !== step.summary.trim() && !step.summary.includes(step.detail.trim())) {
        const det = document.createElement('div');
        det.className = 'thinking-log-detail';
        det.textContent = step.detail;
        row.appendChild(det);
      }
      panel.appendChild(row);
    }

    if (steps.length === 0) {
      for (const t of transcriptEntries) {
        const row = document.createElement('div');
        row.className = 'thinking-log-row';
        const rowMeta = document.createElement('div');
        rowMeta.className = 'thinking-log-meta';
        const lbl = document.createElement('span');
        lbl.textContent = t.label;
        const tm = document.createElement('span');
        tm.textContent = t.time;
        rowMeta.append(lbl, tm);
        const sum = document.createElement('div');
        sum.className = 'thinking-log-summary';
        sum.textContent = t.text;
        row.append(rowMeta, sum);
        panel.appendChild(row);
      }
    }
  }

  // 조용한 하단 유틸리티 (새로고침 + 필요할 때만 펼쳐보는 원본 터미널)
  const showRawTerm = state.workerLogTabs.get(logKey) === 'terminal';
  const toolsFoot = document.createElement('div');
  toolsFoot.className = 'worker-log-foot';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'footer-icon-btn';
  refreshBtn.textContent = '새로고침';
  refreshBtn.addEventListener('click', () => { void fetchWorkerLogs(projectId, workerId); });
  toolsFoot.appendChild(refreshBtn);

  if (logs.terminal && logs.terminal.lines.length > 0) {
    const rawBtn = document.createElement('button');
    rawBtn.type = 'button';
    rawBtn.className = 'footer-icon-btn';
    rawBtn.textContent = showRawTerm ? '원본 터미널 숨기기 ▴' : '원본 터미널 보기 ▾';
    rawBtn.addEventListener('click', () => {
      state.workerLogTabs.set(logKey, showRawTerm ? 'events' : 'terminal');
      patchWorkerLogSlot(projectId, workerId, false);
    });
    toolsFoot.appendChild(rawBtn);
  }
  panel.appendChild(toolsFoot);

  if (showRawTerm && logs.terminal && logs.terminal.lines.length > 0) {
    const termBox = document.createElement('pre');
    termBox.className = 'worker-terminal-box';
    termBox.textContent = logs.terminal.lines.join('\n');
    panel.appendChild(termBox);
    window.requestAnimationFrame(() => {
      termBox.scrollTop = termBox.scrollHeight;
    });
  }

  return panel;
}

function populateWorkerReportAndLogs(
  slot: HTMLElement,
  projectId: string,
  workerId: string,
  autoScroll = true,
): void {
  const prevThread = slot.querySelector<HTMLElement>('.worker-chat-thread');
  const prevScrollTop = prevThread?.scrollTop ?? 0;

  clearChildren(slot);
  const key = `${projectId}:${workerId}`;
  const logs = state.workerLogs.get(key);
  const worker = state.activeDetail?.snapshot.project.projectId === projectId
    ? state.activeDetail.snapshot.workers.find(w => w.workerId === workerId)
    : undefined;
  const latestProgress = state.workerLatestProgress.get(key) ?? logs?.progress.at(-1);
  const isWorking = worker?.status === 'working';

  const toggleInlineLog = (logKey: string) => {
    if (state.expandedWorkerInternalLogs.has(logKey)) {
      state.expandedWorkerInternalLogs.delete(logKey);
    } else {
      state.expandedWorkerInternalLogs.add(logKey);
      if (!logs || logs.loadedAt === null) {
        void fetchWorkerLogs(projectId, workerId);
      }
    }
    patchWorkerLogSlot(projectId, workerId, false);
  };

  // 1. 승인 대기 상태이면 최상단에 즉시 승인/거절 배너 노출
  if (logs?.terminal?.blocked) {
    const blockedBar = document.createElement('div');
    blockedBar.className = 'worker-blocked-bar';
    const bTxt = document.createElement('div');
    bTxt.className = 'worker-blocked-text';
    bTxt.textContent = '워커가 명령 승인 대기 중입니다';
    const bActs = document.createElement('div');
    bActs.className = 'worker-blocked-actions';
    const appBtn = document.createElement('button');
    appBtn.type = 'button';
    appBtn.className = 'btn btn-primary btn-xs';
    appBtn.textContent = '승인 (Enter)';
    appBtn.addEventListener('click', () => { void handleWorkerTerminalInput(projectId, workerId, 'approve'); });
    const denyBtn = document.createElement('button');
    denyBtn.type = 'button';
    denyBtn.className = 'btn btn-outline btn-xs';
    denyBtn.textContent = '거절 (Esc)';
    denyBtn.addEventListener('click', () => { void handleWorkerTerminalInput(projectId, workerId, 'deny'); });
    bActs.append(appBtn, denyBtn);
    blockedBar.append(bTxt, bActs);
    slot.appendChild(blockedBar);
  }

  // 2. Codex 대화 세션과 동일한 채팅 흐름 (오른쪽 수신 말풍선 ↔ 왼쪽 워커 응답 + 그 자리에서 바로 펼쳐지는 내부 로그)
  const reports = collectWorkerReports(projectId, workerId);
  const thread = document.createElement('div');
  thread.className = 'worker-chat-thread';

  if (reports.length === 0) {
    const emptyWrap = document.createElement('div');
    emptyWrap.className = 'worker-reply-wrap';

    const empty = document.createElement('div');
    empty.className = 'worker-thread-empty';
    if (isWorking) {
      const dot = document.createElement('span');
      dot.className = 'thinking-dot active';
      const txt = document.createElement('span');
      txt.textContent = latestProgress?.summary ? `작업 중 · ${latestProgress.summary}` : '작업을 진행하고 있습니다...';
      empty.append(dot, txt);
    } else if (worker?.status === 'ready') {
      empty.textContent = '작동 중 · Codex가 위임하거나 직접 메시지를 보내면 대화가 여기에 표시됩니다.';
    } else if (worker?.status === 'starting') {
      empty.textContent = '워커를 시작하는 중입니다...';
    } else {
      empty.textContent = '대화 기록이 없습니다.';
    }
    emptyWrap.appendChild(empty);

    // 대화가 아직 없을 때도 내부 로그 화살표를 누르면 그 자리에서 바로 펼쳐짐
    const emptyLogKey = `${key}:empty`;
    const isEmptyLogOpen = state.expandedWorkerInternalLogs.has(emptyLogKey);
    const emptyToggle = document.createElement('button');
    emptyToggle.type = 'button';
    emptyToggle.className = 'worker-work-toggle';
    emptyToggle.setAttribute('aria-expanded', String(isEmptyLogOpen));
    emptyToggle.textContent = isEmptyLogOpen ? '내부 로그 ▾' : '내부 로그 ›';
    emptyToggle.addEventListener('click', () => toggleInlineLog(emptyLogKey));
    emptyWrap.appendChild(emptyToggle);

    if (isEmptyLogOpen) {
      emptyWrap.appendChild(buildWorkerInternalLogPanel(projectId, workerId, emptyLogKey, logs));
    }

    thread.appendChild(emptyWrap);
  } else {
    for (let idx = 0; idx < reports.length; idx++) {
      const item = reports[idx]!;
      const isLast = idx === reports.length - 1;
      const isPending = item.status === 'working' || item.status === 'worker_working' || item.status === 'accepted';

      const turnGroup = document.createElement('div');
      turnGroup.className = 'worker-turn-group';

      // 오른쪽 수신 메시지 말풍선 (Codex가 보냄 / 직접 지시)
      if (item.prompt) {
        const incomingWrap = document.createElement('div');
        incomingWrap.className = 'worker-incoming-wrap';

        if (item.sender === 'codex') {
          const origin = document.createElement('div');
          origin.className = 'worker-incoming-origin';
          origin.textContent = '↗ Codex가 보냄';
          incomingWrap.appendChild(origin);
        }

        const bubble = document.createElement('div');
        bubble.className = 'worker-incoming-bubble';
        const promptKey = `${key}:${item.id}`;
        const isLong = item.prompt.length > 130 || item.prompt.split('\n').length > 3;
        const isPromptOpen = state.expandedWorkerPrompts.has(promptKey);

        const promptText = document.createElement('div');
        promptText.className = `worker-incoming-text${isLong && !isPromptOpen ? ' is-clamped' : ''}`;
        promptText.textContent = item.prompt;
        bubble.appendChild(promptText);

        if (isLong) {
          const moreBtn = document.createElement('button');
          moreBtn.type = 'button';
          moreBtn.className = 'worker-more-btn';
          moreBtn.textContent = isPromptOpen ? '접기 ▴' : '더 보기 ▾';
          moreBtn.addEventListener('click', () => {
            if (state.expandedWorkerPrompts.has(promptKey)) state.expandedWorkerPrompts.delete(promptKey);
            else state.expandedWorkerPrompts.add(promptKey);
            patchWorkerLogSlot(projectId, workerId, false);
          });
          bubble.appendChild(moreBtn);
        }

        incomingWrap.appendChild(bubble);

        const incomingActions = document.createElement('div');
        incomingActions.className = 'user-bubble-actions worker-incoming-actions';
        if (item.time) {
          const tSpan = document.createElement('span');
          tSpan.className = 'user-bubble-time';
          tSpan.textContent = item.time;
          incomingActions.appendChild(tSpan);
        }
        incomingActions.appendChild(createCopyIconButton(item.prompt, '메시지 복사'));
        incomingWrap.appendChild(incomingActions);
        turnGroup.appendChild(incomingWrap);
      }

      // 왼쪽 워커 응답 영역 (Codex처럼 플랫한 본문 + 클릭 시 그 자리에서 쫘르륵 펼쳐지는 내부 로그)
      const replyWrap = document.createElement('div');
      replyWrap.className = 'worker-reply-wrap';

      const turnLogKey = `${key}:${item.id}`;
      const isTurnLogOpen = state.expandedWorkerInternalLogs.has(turnLogKey);
      const workToggle = document.createElement('button');
      workToggle.type = 'button';
      workToggle.className = 'worker-work-toggle';
      workToggle.setAttribute('aria-expanded', String(isTurnLogOpen));
      workToggle.addEventListener('click', () => toggleInlineLog(turnLogKey));

      const turnStepsCount = filterWorkerStepsForTurn(logs, item).length;
      const arrow = isTurnLogOpen ? '▾' : '›';
      if (isPending || (isLast && isWorking)) {
        const dot = document.createElement('span');
        dot.className = 'thinking-dot active';
        const lbl = document.createElement('span');
        lbl.textContent = latestProgress?.summary ? `작업 중 · ${latestProgress.summary} ${arrow}` : `작업 중... ${arrow}`;
        workToggle.append(dot, lbl);
      } else {
        const lbl = document.createElement('span');
        const stepBadge = turnStepsCount > 0 ? ` (${turnStepsCount}단계)` : '';
        lbl.textContent = item.status === 'completed'
          ? `작업 완료${stepBadge} ${arrow}`
          : `${statusLabel(item.status)}${stepBadge} ${arrow}`;
        workToggle.appendChild(lbl);
      }
      replyWrap.appendChild(workToggle);

      // 화살표 클릭 시 바로 이 자리 아래에 도구·명령·파일 변경 로그가 펼쳐짐
      if (isTurnLogOpen) {
        replyWrap.appendChild(buildWorkerInternalLogPanel(projectId, workerId, turnLogKey, logs, item));
      }

      if (item.report) {
        const mdWrap = document.createElement('div');
        mdWrap.className = 'worker-report-md';
        mdWrap.appendChild(renderMarkdownSafe(item.report));
        replyWrap.appendChild(mdWrap);

        const foot = document.createElement('div');
        foot.className = 'worker-reply-footer';
        foot.appendChild(createCopyIconButton(item.report, '응답 복사'));
        if (item.time) {
          const tm = document.createElement('span');
          tm.textContent = item.time;
          foot.appendChild(tm);
        }
        replyWrap.appendChild(foot);
      } else if (!isPending) {
        const note = document.createElement('div');
        note.className = 'muted-text';
        note.style.fontSize = '12px';
        note.textContent = statusLabel(item.status);
        replyWrap.appendChild(note);
      }

      turnGroup.appendChild(replyWrap);
      thread.appendChild(turnGroup);
    }
  }

  slot.appendChild(thread);
  if (autoScroll) {
    window.requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight;
    });
  } else {
    thread.scrollTop = prevScrollTop;
  }
}

async function fetchWorkerLogs(projectId: string, workerId: string): Promise<void> {
  const key = `${projectId}:${workerId}`;
  const existing = state.workerLogs.get(key);
  state.workerLogs.set(key, {
    progress: existing?.progress ?? [],
    transcript: existing?.transcript ?? [],
    terminal: existing?.terminal ?? null,
    loading: true,
    error: null,
    loadedAt: existing?.loadedAt ?? null,
  });
  patchWorkerLogSlot(projectId, workerId);
  try {
    const data = await api<{
      progress: ProgressLogEntry[];
      transcript: unknown;
      terminal: WorkerTerminalSnapshot | null;
    }>(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/logs?last=8`);
    state.workerLogs.set(key, {
      progress: data.progress ?? [],
      transcript: data.transcript ?? [],
      terminal: data.terminal ?? null,
      loading: false,
      error: null,
      loadedAt: Date.now(),
    });
  } catch (error) {
    state.workerLogs.set(key, {
      progress: existing?.progress ?? [],
      transcript: existing?.transcript ?? [],
      terminal: existing?.terminal ?? null,
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

function patchWorkerLogSlot(projectId: string, workerId: string, autoScroll = true): void {
  const slot = document.querySelector<HTMLElement>(`[data-worker-log-list="${CSS.escape(workerId)}"]`);
  if (!slot) return;
  populateWorkerReportAndLogs(slot, projectId, workerId, autoScroll);
}

function renderWorkersPanel(): void {
  const workerList = el<HTMLDivElement>('workerList');
  clearChildren(workerList);
  const detail = state.activeDetail;
  if (!detail) {
    const empty = document.createElement('div');
    empty.className = 'muted-text';
    empty.style.fontSize = '12px';
    empty.textContent = '프로젝트를 선택하면 워커가 표시됩니다.';
    workerList.appendChild(empty);
    return;
  }

  const projectId = detail.snapshot.project.projectId;
  for (const worker of detail.snapshot.workers) {
    const workerKey = `${projectId}:${worker.workerId}`;
    const isExpanded = state.expandedWorkers.has(workerKey);
    const latestProgress = state.workerLatestProgress.get(workerKey);

    const card = document.createElement('div');
    card.className = `worker-card${isExpanded ? ' expanded' : ''}`;

    const headerBtn = document.createElement('div');
    headerBtn.setAttribute('role', 'button');
    headerBtn.tabIndex = 0;
    headerBtn.className = 'worker-card-header';
    headerBtn.setAttribute('aria-expanded', String(isExpanded));
    const toggleExpand = () => {
      if (state.expandedWorkers.has(workerKey)) {
        state.expandedWorkers.delete(workerKey);
        renderWorkersPanel();
      } else {
        state.expandedWorkers.add(workerKey);
        renderWorkersPanel();
        void fetchWorkerLogs(projectId, worker.workerId);
      }
    };
    headerBtn.addEventListener('click', toggleExpand);
    headerBtn.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleExpand();
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
    statusText.textContent = workerStatusLabel(worker.status);
    const chevron = document.createElement('span');
    chevron.className = 'worker-chevron';
    chevron.textContent = '▾';
    rightWrap.append(statusText, chevron);
    top.append(nameWrap, rightWrap);

    const agyCatalog = getAgyCatalog();
    const openWorkerModelPicker = (anchorEl: HTMLElement) => {
      openModelEffortPopover({
        anchor: anchorEl,
        source: 'agy',
        currentModel: worker.model,
        currentEffort: worker.reasoningEffort,
        preferAbove: false,
        onChange: next => {
          void handleUpdateWorkerSettings(projectId, worker.workerId, {
            model: next.model,
            reasoningEffort: next.effort,
            permissionMode: worker.permissionMode,
            autoApply: true,
          });
        },
      });
    };

    const compactSub = document.createElement('div');
    compactSub.className = 'worker-compact-sub';
    const modelSummaryBtn = document.createElement('button');
    modelSummaryBtn.type = 'button';
    modelSummaryBtn.className = 'worker-sub-picker';
    modelSummaryBtn.title = '클릭하여 워커 모델·추론 강도 변경';
    modelSummaryBtn.textContent = `${shortModelLabel(worker.model, agyCatalog)} · ${effortDisplay(worker.reasoningEffort, agyCatalog, worker.model)} ▾`;
    modelSummaryBtn.addEventListener('click', event => {
      event.stopPropagation();
      openWorkerModelPicker(modelSummaryBtn);
    });
    const permBadge = document.createElement('span');
    permBadge.className = 'mono-text';
    permBadge.textContent = PERMISSION_SHORT_LABELS[worker.permissionMode] ?? worker.permissionMode;
    compactSub.append(modelSummaryBtn, permBadge);

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

      if (worker.lastError) {
        const err = document.createElement('div');
        err.className = 'error-text';
        err.textContent = worker.lastError;
        body.appendChild(err);
      }

      // 깔끔한 커스텀 팝오버 필 버튼 (모델·추론 슬라이더 & 권한)
      const pillRow = document.createElement('div');
      pillRow.className = 'worker-pill-row';

      const modelPill = document.createElement('button');
      modelPill.type = 'button';
      modelPill.className = 'worker-pill-btn';
      modelPill.textContent = `${shortModelLabel(worker.model, agyCatalog)} · ${effortDisplay(worker.reasoningEffort, agyCatalog, worker.model)} ▾`;
      modelPill.addEventListener('click', event => {
        event.stopPropagation();
        openWorkerModelPicker(modelPill);
      });

      const permPill = document.createElement('button');
      permPill.type = 'button';
      permPill.className = 'worker-pill-btn';
      permPill.textContent = `${PERMISSION_SHORT_LABELS[worker.permissionMode] ?? worker.permissionMode} ▾`;
      permPill.addEventListener('click', event => {
        event.stopPropagation();
        openOptionPopover({
          anchor: permPill,
          title: '워커 권한 수준',
          options: WORKER_PERMISSION_OPTIONS,
          currentValue: worker.permissionMode,
          preferAbove: false,
          onSelect: nextPerm => {
            void handleUpdateWorkerSettings(projectId, worker.workerId, {
              model: worker.model,
              reasoningEffort: worker.reasoningEffort,
              permissionMode: nextPerm as WorkerRecord['permissionMode'],
              autoApply: true,
            });
          },
        });
      });

      pillRow.append(modelPill, permPill);
      body.appendChild(pillRow);

      const actions = document.createElement('div');
      actions.className = 'worker-actions';
      const isRunning = worker.status === 'ready' || worker.status === 'working' || worker.status === 'needs_attention';
      const isStarting = worker.status === 'starting';

      if (isRunning) {
        const activeBtn = document.createElement('button');
        activeBtn.type = 'button';
        activeBtn.className = 'btn btn-outline btn-xs';
        activeBtn.textContent = '작동 중';
        activeBtn.disabled = true;

        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'btn btn-subtle btn-xs';
        stopBtn.textContent = '정지';
        stopBtn.addEventListener('click', () => { void runWorkerAction(projectId, worker.workerId, 'stop'); });

        actions.append(activeBtn, stopBtn);
      } else if (isStarting) {
        const startingBtn = document.createElement('button');
        startingBtn.type = 'button';
        startingBtn.className = 'btn btn-outline btn-xs';
        startingBtn.textContent = '시작 중';
        startingBtn.disabled = true;
        actions.append(startingBtn);
      } else {
        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.className = 'btn btn-outline btn-xs';
        startBtn.textContent = '시작';
        startBtn.addEventListener('click', () => { void runWorkerAction(projectId, worker.workerId, 'start'); });
        actions.append(startBtn);
      }
      body.appendChild(actions);

      // Level 1 (Codex 스타일 워커 보고) + Level 2 (접히는 내부 로그 · 터미널)
      const reportAndLogsSlot = document.createElement('div');
      reportAndLogsSlot.className = 'worker-report-slot';
      reportAndLogsSlot.dataset.workerLogList = worker.workerId;
      body.appendChild(reportAndLogsSlot);
      populateWorkerReportAndLogs(reportAndLogsSlot, projectId, worker.workerId);

      // 워커 전용 직접 대화 입력창
      const chatRow = document.createElement('div');
      chatRow.className = 'worker-chat-row';
      const chatInput = document.createElement('input');
      chatInput.className = 'input';
      chatInput.type = 'text';
      chatInput.placeholder = `${worker.name}에게 직접 지시 (Enter)`;
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
}

function renderAll(): void {
  renderProjectList();
  renderHeaderAndComposer();
  renderMessages();
  renderHcomMessages();
  renderWorkersPanel();
}

/* ============================================================================
 * Incremental Partial Renderer & Zero-Refetch Delta SSE
 * ========================================================================== */

function flushPartialRenders(): void {
  state.partialRenderTimer = null;
  if (document.hidden) {
    state.dirtyWhileHidden = true;
    return;
  }
  const projectId = state.selectedProjectId;
  const reqGroupIds = [...state.dirtyRequestGroups];
  const reqThinkingIds = [...state.dirtyRequestThinking];
  const workerSlots = [...state.dirtyWorkerSlots];
  const workersPanel = state.dirtyWorkersPanel;
  const header = state.dirtyHeader;
  const hcom = state.dirtyHcom;

  state.dirtyRequestGroups.clear();
  state.dirtyRequestThinking.clear();
  state.dirtyWorkerSlots.clear();
  state.dirtyWorkersPanel = false;
  state.dirtyHeader = false;
  state.dirtyHcom = false;

  window.requestAnimationFrame(() => {
    for (const reqId of reqGroupIds) patchRequestGroup(reqId);
    for (const reqId of reqThinkingIds) {
      if (!reqGroupIds.includes(reqId)) patchRequestThinkingSlot(reqId);
    }
    if (workersPanel) {
      renderWorkersPanel();
      renderProjectList();
    } else if (projectId) {
      for (const workerId of workerSlots) {
        patchWorkerLiveSlot(projectId, workerId);
        if (state.expandedWorkers.has(`${projectId}:${workerId}`)) {
          patchWorkerLogSlot(projectId, workerId);
        }
      }
    }
    if (header) {
      renderHeaderAndComposer();
      renderProjectList();
    }
    if (hcom || workersPanel || reqGroupIds.length > 0) renderHcomMessages();
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

function applyEventDelta(projectId: string, delta: EventDelta): boolean {
  const detail = state.activeDetail;
  if (!detail || detail.snapshot.project.projectId !== projectId) return false;
  let applied = false;

  if (delta.codex) {
    detail.snapshot = { ...detail.snapshot, codex: delta.codex };
    state.dirtyHeader = true;
    applied = true;
  }

  if (delta.worker) {
    const workers = [...detail.snapshot.workers];
    const idx = workers.findIndex(w => w.workerId === delta.worker!.workerId);
    if (idx >= 0) workers[idx] = delta.worker;
    else workers.push(delta.worker);
    detail.snapshot = { ...detail.snapshot, workers };
    state.dirtyWorkersPanel = true;
    state.dirtyHeader = true;
    applied = true;
  }

  if (delta.request) {
    const req = delta.request;
    const idx = detail.requests.findIndex(r => r.requestId === req.requestId);
    if (idx >= 0) detail.requests[idx] = req;
    else {
      detail.requests.push(req);
      detail.totalRequests += 1;
    }
    if (req.progressSummary && req.progressSummary.length > 0 && !(detail.progressByRequest[req.requestId]?.length)) {
      detail.progressByRequest[req.requestId] = req.progressSummary;
    }
    if (delta.delegations) {
      const others = detail.delegations.filter(d => d.requestId !== req.requestId);
      detail.delegations = [...others, ...delta.delegations];
      for (const d of delta.delegations) {
        state.dirtyWorkerSlots.add(d.workerId);
      }
    }
    if (req.mode === 'direct_worker') {
      if (req.targetWorkerId) state.dirtyWorkerSlots.add(req.targetWorkerId);
    } else {
      state.dirtyRequestGroups.add(req.requestId);
    }
    applied = true;
  }

  if (delta.handoff) {
    detail.snapshot = { ...detail.snapshot, handoff: delta.handoff };
    state.dirtyHeader = true;
    applied = true;
  }

  if (applied) {
    const pIdx = state.projects.findIndex(p => p.project.projectId === projectId);
    if (pIdx >= 0) state.projects[pIdx] = detail.snapshot;
    schedulePartialRender();
  }
  return applied;
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

  const structuralKinds = [
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

  for (const kind of structuralKinds) {
    source.addEventListener(kind, event => {
      if (state.selectedProjectId !== projectId) return;
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as {
          seq?: number;
          projectId?: string;
          delta?: EventDelta;
        };
        if (parsed.projectId !== projectId) return;
        if (state.activeDetail && typeof parsed.seq === 'number' && parsed.seq > state.activeDetail.latestSeq) {
          state.activeDetail.latestSeq = parsed.seq;
        }
        if (parsed.delta && kind !== 'project.stopped' && kind !== 'hcom.db_reset') {
          if (applyEventDelta(projectId, parsed.delta)) return;
        }
      } catch {}
      scheduleProjectRefresh(projectId);
    });
  }

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
      if (parsed.entry.kind === 'commentary') {
        state.dirtyRequestGroups.add(parsed.requestId);
      } else {
        state.dirtyRequestThinking.add(parsed.requestId);
      }
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

/* ============================================================================
 * API Actions
 * ========================================================================== */

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
      hasMoreRequests?: boolean;
      totalRequests?: number;
    }>(`/api/projects/${encodeURIComponent(projectId)}?limit=${PAGE_LIMIT}`);
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
      hasMoreRequests: Boolean(data.hasMoreRequests),
      totalRequests: data.totalRequests ?? data.requests.length,
    };
    const idx = state.projects.findIndex(p => p.project.projectId === projectId);
    if (idx >= 0) state.projects[idx] = data.snapshot;
    else await refreshProjectsList();

    if (!document.hidden) renderAll();
    else state.dirtyWhileHidden = true;

    if (reconnectSse) connectSse(projectId, data.latestSeq);
  } finally {
    state.refreshInFlight = false;
    const queued = state.refreshQueuedProjectId;
    if (queued && queued === state.selectedProjectId && !document.hidden) {
      state.refreshQueuedProjectId = null;
      void refreshActiveProject(queued, false);
    }
  }
}

async function handleLoadOlderRequests(): Promise<void> {
  const detail = state.activeDetail;
  if (!detail || !detail.hasMoreRequests || state.loadingOlder) return;
  const oldest = detail.requests[0];
  if (!oldest) return;
  const projectId = detail.snapshot.project.projectId;
  state.loadingOlder = true;
  el<HTMLButtonElement>('loadOlderBtn').disabled = true;
  el<HTMLButtonElement>('loadOlderBtn').textContent = '불러오는 중...';

  const scroller = el<HTMLElement>('conversationScroll');
  const prevHeight = scroller.scrollHeight;
  try {
    const query = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      beforeCreatedAt: oldest.createdAt,
      beforeRequestId: oldest.requestId,
    });
    const data = await api<{
      requests: RequestRecord[];
      delegations: DelegationRecord[];
      progressByRequest?: Record<string, ProgressLogEntry[]>;
      hasMoreRequests: boolean;
      totalRequests: number;
    }>(`/api/projects/${encodeURIComponent(projectId)}/requests?${query.toString()}`);

    if (state.selectedProjectId !== projectId || !state.activeDetail) return;
    const existingIds = new Set(state.activeDetail.requests.map(r => r.requestId));
    const olderUnique = data.requests.filter(r => !existingIds.has(r.requestId));
    state.activeDetail.requests = [...olderUnique, ...state.activeDetail.requests];
    const existingDelIds = new Set(state.activeDetail.delegations.map(d => d.delegationId));
    state.activeDetail.delegations = [
      ...data.delegations.filter(d => !existingDelIds.has(d.delegationId)),
      ...state.activeDetail.delegations,
    ];
    state.activeDetail.progressByRequest = {
      ...(data.progressByRequest ?? {}),
      ...state.activeDetail.progressByRequest,
    };
    state.activeDetail.hasMoreRequests = data.hasMoreRequests;
    state.activeDetail.totalRequests = data.totalRequests;
    renderMessages();
    renderWorkersPanel();
    scroller.scrollTop += scroller.scrollHeight - prevHeight;
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.loadingOlder = false;
  }
}

async function selectProject(projectId: string): Promise<void> {
  closePopover();
  showNotice(null);
  state.selectedProjectId = projectId;
  state.composerTarget = 'codex';
  await api(`/api/projects/${encodeURIComponent(projectId)}/select`, { method: 'POST' });
  await refreshActiveProject(projectId, true);
}

async function loadModels(refresh = false): Promise<void> {
  state.modelsLoading = true;
  try {
    const catalog = await api<ModelCatalog>(`/api/models${refresh ? '?refresh=1' : ''}`);
    if (Array.isArray(catalog.codex) && catalog.codex.length > 0) {
      state.models = catalog;
      renderHeaderAndComposer();
      renderWorkersPanel();
      state.activePopoverRerender?.();
    }
  } catch {
  } finally {
    state.modelsLoading = false;
    state.activePopoverRerender?.();
  }
}

async function loadDiagnostics(refresh = false): Promise<void> {
  try {
    state.diagnostics = await api<CliDiagnostics>(`/api/diagnostics${refresh ? '?refresh=1' : ''}`);
    renderDiagnostics();
  } catch {}
}

async function handleUpdateCodexSettings(patch: {
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  sandboxMode?: CodexRecord['sandboxMode'];
  customInstructions?: string;
}): Promise<void> {
  const projectId = state.selectedProjectId;
  if (!projectId) return;
  try {
    const res = await api<{ codex: CodexRecord }>(`/api/projects/${encodeURIComponent(projectId)}/codex/settings`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    applyEventDelta(projectId, { codex: res.codex });
    if (patch.customInstructions !== undefined) {
      showNotice(res.codex.customInstructions ? '사용자 지침을 저장했습니다.' : '사용자 지침을 비웠습니다 (추가 토큰 없음).');
      window.setTimeout(() => showNotice(null), 1800);
    }
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleUpdateWorkerSettings(
  projectId: string,
  workerId: string,
  payload: { model: string | null; reasoningEffort: string | null; permissionMode: WorkerRecord['permissionMode']; autoApply?: boolean },
): Promise<void> {
  const timerKey = `${projectId}:${workerId}`;
  const prevTimer = state.workerAutoApplyTimers.get(timerKey);
  if (prevTimer !== undefined) {
    window.clearTimeout(prevTimer);
    state.workerAutoApplyTimers.delete(timerKey);
  }
  try {
    const res = await api<{ worker: WorkerRecord }>(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        model: payload.model,
        reasoningEffort: payload.reasoningEffort,
        permissionMode: payload.permissionMode,
        applyNow: false,
      }),
    });
    applyEventDelta(projectId, { worker: res.worker });

    // 작동 중인 대기 상태 워커는 슬라이더·드롭다운 조작이 끝난 직후 자동으로 새 설정을 반영
    if (payload.autoApply && (res.worker.status === 'ready' || res.worker.status === 'needs_attention')) {
      const nextTimer = window.setTimeout(() => {
        state.workerAutoApplyTimers.delete(timerKey);
        const latestWorker = state.activeDetail?.snapshot.project.projectId === projectId
          ? state.activeDetail.snapshot.workers.find(w => w.workerId === workerId)
          : res.worker;
        if (!latestWorker || (latestWorker.status !== 'ready' && latestWorker.status !== 'needs_attention')) return;
        void (async () => {
          try {
            showNotice('변경된 설정을 워커에 자동 반영하는 중입니다...');
            const applied = await api<{ worker: WorkerRecord }>(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/settings`, {
              method: 'PATCH',
              body: JSON.stringify({
                model: latestWorker.model,
                reasoningEffort: latestWorker.reasoningEffort,
                permissionMode: latestWorker.permissionMode,
                applyNow: true,
              }),
            });
            applyEventDelta(projectId, { worker: applied.worker });
            showNotice('워커 설정이 자동 반영되었습니다.');
            window.setTimeout(() => showNotice(null), 1600);
          } catch (err) {
            showNotice(err instanceof Error ? err.message : String(err), true);
          }
        })();
      }, 650);
      state.workerAutoApplyTimers.set(timerKey, nextTimer);
    }
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleWorkerTerminalInput(projectId: string, workerId: string, decision: 'approve' | 'deny'): Promise<void> {
  try {
    showNotice(decision === 'approve' ? '워커에게 승인(Enter)을 전달했습니다...' : '워커에게 거절(Esc)을 전달했습니다...');
    const res = await api<{ worker: WorkerRecord }>(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/input`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    applyEventDelta(projectId, { worker: res.worker });
    window.setTimeout(() => {
      showNotice(null);
      void fetchWorkerLogs(projectId, workerId);
    }, 900);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function runWorkerAction(projectId: string, workerId: string, action: 'start' | 'stop'): Promise<void> {
  const timerKey = `${projectId}:${workerId}`;
  const prevTimer = state.workerAutoApplyTimers.get(timerKey);
  if (prevTimer !== undefined) {
    window.clearTimeout(prevTimer);
    state.workerAutoApplyTimers.delete(timerKey);
  }
  try {
    showNotice(action === 'start' ? '워커를 시작하는 중입니다...' : '워커를 정지하는 중입니다...');
    const res = await api<{ worker: WorkerRecord }>(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/${action}`, { method: 'POST' });
    showNotice(null);
    applyEventDelta(projectId, { worker: res.worker });
    if (state.expandedWorkers.has(`${projectId}:${workerId}`)) {
      void fetchWorkerLogs(projectId, workerId);
    }
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

function openModal(id: string): void {
  closePopover();
  el<HTMLElement>(id).classList.remove('hidden');
}

function closeModal(id: string): void {
  closePopover();
  el<HTMLElement>(id).classList.add('hidden');
}

function syncAddWorkerModalLabels(): void {
  const { model, effort, permissionMode } = state.addWorkerDraft;
  const agyCatalog = getAgyCatalog();
  el<HTMLButtonElement>('addWorkerModelEffortBtn').textContent =
    `${shortModelLabel(model, agyCatalog)} · ${effortDisplay(effort, agyCatalog, model)}`;
  el<HTMLButtonElement>('addWorkerPermBtn').textContent =
    `${PERMISSION_SHORT_LABELS[permissionMode] ?? permissionMode} ▾`;
}

async function handleDirectWorkerChat(projectId: string, workerId: string, prompt: string): Promise<void> {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    showNotice(null);
    const res = await api<{ request?: RequestRecord }>(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ requestId, prompt }),
    });
    if (res.request) applyEventDelta(projectId, { request: res.request });
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

  const target = state.composerTarget || 'codex';
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  input.value = '';
  try {
    showNotice(null);
    if (target.startsWith('worker:')) {
      const targetWorkerId = target.slice('worker:'.length);
      const workerKey = `${projectId}:${targetWorkerId}`;
      const rightPanel = el<HTMLElement>('rightSidebar');
      if (rightPanel.classList.contains('collapsed')) {
        rightPanel.classList.remove('collapsed');
        el<HTMLDivElement>('rightResizer').classList.remove('hidden');
        el<HTMLButtonElement>('railRightBtn').classList.add('is-active');
      }
      if (!state.expandedWorkers.has(workerKey)) {
        state.expandedWorkers.add(workerKey);
        renderWorkersPanel();
        void fetchWorkerLogs(projectId, targetWorkerId);
      }
      const res = await api<{ request?: RequestRecord }>(`/api/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(targetWorkerId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ requestId, prompt }),
      });
      if (res.request) applyEventDelta(projectId, { request: res.request });
    } else {
      const res = await api<{ request?: RequestRecord }>(`/api/projects/${encodeURIComponent(projectId)}/requests`, {
        method: 'POST',
        body: JSON.stringify({ requestId, prompt }),
      });
      if (res.request) applyEventDelta(projectId, { request: res.request });
    }
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleReplyToRequest(projectId: string, requestId: string, answer: string): Promise<void> {
  const replyKey = `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    showNotice(null);
    const res = await api<{ request?: RequestRecord }>(`/api/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ replyKey, answer }),
    });
    if (res.request) applyEventDelta(projectId, { request: res.request });
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleResolveApproval(projectId: string, requestId: string, decision: 'approve' | 'deny'): Promise<void> {
  try {
    showNotice(decision === 'approve' ? '워커에게 승인을 전달하는 중입니다...' : '워커 작업을 거절하는 중입니다...');
    const res = await api<{ request: RequestRecord }>(`/api/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/approval`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    showNotice(null);
    applyEventDelta(projectId, { request: res.request });
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleCancelRequest(projectId: string, requestId: string): Promise<void> {
  try {
    showNotice('요청을 취소하는 중입니다...');
    const res = await api<{ request: RequestRecord }>(`/api/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/cancel`, {
      method: 'POST',
    });
    showNotice(null);
    applyEventDelta(projectId, { request: res.request });
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

function bindEvents(): void {
  // Close custom popovers on outside click / Escape / resize
  el<HTMLDivElement>('popoverPortal').addEventListener('click', event => {
    event.stopPropagation();
  });
  document.addEventListener('click', event => {
    const portal = el<HTMLDivElement>('popoverPortal');
    if (portal.classList.contains('hidden')) return;
    const target = event.target as Node;
    if (portal.contains(target) || state.activePopoverAnchor?.contains(target)) return;
    closePopover();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePopover();
  });
  window.addEventListener('resize', closePopover);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.dirtyWhileHidden) {
      state.dirtyWhileHidden = false;
      if (state.selectedProjectId) void refreshActiveProject(state.selectedProjectId, false);
      else renderAll();
    }
  });

  const toggleLeft = () => {
    const collapsed = el<HTMLElement>('leftSidebar').classList.toggle('collapsed');
    el<HTMLDivElement>('leftResizer').classList.toggle('hidden', collapsed);
    el<HTMLButtonElement>('toggleLeftBtn').classList.toggle('is-active', !collapsed);
  };
  el<HTMLButtonElement>('toggleLeftBtn').addEventListener('click', toggleLeft);
  el<HTMLButtonElement>('railHomeBtn').addEventListener('click', toggleLeft);

  const toggleRight = () => {
    const collapsed = el<HTMLElement>('rightSidebar').classList.toggle('collapsed');
    el<HTMLDivElement>('rightResizer').classList.toggle('hidden', collapsed);
    el<HTMLButtonElement>('railRightBtn').classList.toggle('is-active', !collapsed);
  };
  el<HTMLButtonElement>('toggleRightBtn').addEventListener('click', toggleRight);
  el<HTMLButtonElement>('railRightBtn').addEventListener('click', toggleRight);

  // 왼쪽 프로젝트 사이드바 & 오른쪽 워커 사이드바 드래그 너비 조절 (localStorage 저장)
  const bindResizer = (opts: {
    handle: HTMLElement;
    target: HTMLElement;
    side: 'left' | 'right';
    min: number;
    max: number;
    defaultWidth: number;
    storageKey: string;
  }) => {
    try {
      const saved = Number.parseInt(window.localStorage.getItem(opts.storageKey) ?? '', 10);
      if (Number.isFinite(saved) && saved >= opts.min && saved <= opts.max) {
        opts.target.style.width = `${saved}px`;
      }
    } catch {}

    opts.handle.addEventListener('dblclick', () => {
      opts.target.style.width = `${opts.defaultWidth}px`;
      try { window.localStorage.setItem(opts.storageKey, String(opts.defaultWidth)); } catch {}
    });

    opts.handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      closePopover();
      const startX = event.clientX;
      const startWidth = opts.target.getBoundingClientRect().width;
      opts.handle.classList.add('is-dragging');
      document.body.classList.add('is-resizing');

      const onMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const nextWidth = Math.round(
          Math.max(opts.min, Math.min(opts.max, opts.side === 'left' ? startWidth + dx : startWidth - dx)),
        );
        opts.target.style.width = `${nextWidth}px`;
      };

      const onUp = () => {
        opts.handle.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const finalWidth = Math.round(opts.target.getBoundingClientRect().width);
        try { window.localStorage.setItem(opts.storageKey, String(finalWidth)); } catch {}
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  };

  bindResizer({
    handle: el<HTMLDivElement>('leftResizer'),
    target: el<HTMLElement>('leftSidebar'),
    side: 'left',
    min: 180,
    max: 440,
    defaultWidth: 236,
    storageKey: 'hcom_gui_left_w',
  });

  bindResizer({
    handle: el<HTMLDivElement>('rightResizer'),
    target: el<HTMLElement>('rightSidebar'),
    side: 'right',
    min: 240,
    max: 680,
    defaultWidth: 300,
    storageKey: 'hcom_gui_right_w',
  });

  el<HTMLButtonElement>('toggleSearchBtn').addEventListener('click', () => {
    const wrap = el<HTMLDivElement>('projectSearchWrap');
    const hidden = wrap.classList.toggle('hidden');
    if (!hidden) {
      el<HTMLInputElement>('projectSearchInput').focus();
    } else {
      state.projectSearch = '';
      el<HTMLInputElement>('projectSearchInput').value = '';
      renderProjectList();
    }
  });

  el<HTMLInputElement>('projectSearchInput').addEventListener('input', event => {
    state.projectSearch = (event.target as HTMLInputElement).value;
    renderProjectList();
  });

  el<HTMLButtonElement>('toggleHcomLogBtn').addEventListener('click', () => {
    const hidden = el<HTMLDivElement>('hcomLogList').classList.toggle('hidden');
    el<HTMLSpanElement>('hcomChevron').textContent = hidden ? '▾' : '▴';
  });

  el<HTMLButtonElement>('loadOlderBtn').addEventListener('click', () => {
    void handleLoadOlderRequests();
  });

  for (const btn of document.querySelectorAll<HTMLElement>('.modal-close')) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.close;
      if (target) closeModal(target);
    });
  }

  // Custom Composer Pickers (Zero native <select>)
  el<HTMLButtonElement>('targetPickerBtn').addEventListener('click', event => {
    event.stopPropagation();
    const detail = state.activeDetail;
    if (!detail) return;
    const options: OptionChoice[] = [
      { value: 'codex', title: 'Codex', subtitle: '오케스트레이터 (위임·검수·직접 답변)' },
      ...detail.snapshot.workers.map(w => ({
        value: `worker:${w.workerId}`,
        title: `직접 · ${w.name}`,
        subtitle: `Antigravity 워커 (${statusLabel(w.status)})`,
      })),
    ];
    openOptionPopover({
      anchor: el<HTMLButtonElement>('targetPickerBtn'),
      title: '메시지 전송 대상',
      options,
      currentValue: state.composerTarget,
      preferAbove: true,
      onSelect: val => {
        state.composerTarget = val;
        renderHeaderAndComposer();
      },
    });
  });

  el<HTMLButtonElement>('codexPermPickerBtn').addEventListener('click', event => {
    event.stopPropagation();
    const codex = state.activeDetail?.snapshot.codex;
    if (!codex) return;
    openOptionPopover({
      anchor: el<HTMLButtonElement>('codexPermPickerBtn'),
      title: 'Codex 권한 범위',
      options: CODEX_PERMISSION_OPTIONS,
      currentValue: codex.sandboxMode,
      preferAbove: true,
      onSelect: val => {
        void handleUpdateCodexSettings({ sandboxMode: val as CodexRecord['sandboxMode'] });
      },
    });
  });

  el<HTMLButtonElement>('codexModelEffortBtn').addEventListener('click', event => {
    event.stopPropagation();
    const codex = state.activeDetail?.snapshot.codex;
    if (!codex) return;
    openModelEffortPopover({
      anchor: el<HTMLButtonElement>('codexModelEffortBtn'),
      source: 'codex',
      currentModel: codex.model,
      currentEffort: codex.reasoningEffort,
      currentFast: codex.serviceTier === 'priority' || codex.serviceTier === 'fast',
      preferAbove: true,
      onChange: next => {
        void handleUpdateCodexSettings({ model: next.model, reasoningEffort: next.effort });
      },
      onToggleFast: fast => {
        void handleUpdateCodexSettings({ serviceTier: fast ? 'priority' : null });
      },
    });
  });

  // Optional custom instructions modal (from far-left rail)
  el<HTMLButtonElement>('instructionsModalBtn').addEventListener('click', () => {
    const codex = state.activeDetail?.snapshot.codex;
    if (!codex) return;
    el<HTMLTextAreaElement>('customInstructionsInput').value = codex.customInstructions ?? '';
    openModal('instructionsModal');
  });

  el<HTMLButtonElement>('saveInstructionsBtn').addEventListener('click', async () => {
    await handleUpdateCodexSettings({ customInstructions: el<HTMLTextAreaElement>('customInstructionsInput').value });
    closeModal('instructionsModal');
  });

  const openRegister = () => {
    el<HTMLInputElement>('registerPathInput').value = '';
    el<HTMLInputElement>('registerNameInput').value = '';
    el<HTMLDivElement>('registerError').classList.add('hidden');
    openModal('registerModal');
    el<HTMLInputElement>('registerPathInput').focus();
  };
  el<HTMLButtonElement>('openRegisterBtn').addEventListener('click', openRegister);
  el<HTMLButtonElement>('quickRegisterRowBtn').addEventListener('click', openRegister);
  el<HTMLButtonElement>('railRegisterBtn').addEventListener('click', openRegister);
  el<HTMLButtonElement>('emptyRegisterBtn').addEventListener('click', openRegister);

  el<HTMLButtonElement>('browseFolderBtn').addEventListener('click', async () => {
    if (!window.hcomGui) {
      const errBox = el<HTMLDivElement>('registerError');
      errBox.textContent = '브라우저 미리보기 모드에서는 로컬 폴더 절대 경로를 직접 입력해 주세요 (폴더 선택 대화상자는 Electron 앱에서 지원).';
      errBox.classList.remove('hidden');
      return;
    }
    const picked = await window.hcomGui.pickFolder();
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

  // Add Worker Modal with Custom Pickers
  el<HTMLButtonElement>('openAddWorkerBtn').addEventListener('click', () => {
    if (!state.activeDetail) return;
    state.addWorkerDraft = {
      projectId: state.activeDetail.snapshot.project.projectId,
      model: null,
      effort: null,
      permissionMode: 'always-proceed',
    };
    el<HTMLElement>('addWorkerProjectLabel').textContent = state.activeDetail.snapshot.project.name;
    el<HTMLInputElement>('addWorkerNameInput').value = '';
    el<HTMLInputElement>('addWorkerCwdInput').value = '';
    el<HTMLDivElement>('addWorkerError').classList.add('hidden');
    syncAddWorkerModalLabels();
    openModal('addWorkerModal');
  });

  el<HTMLButtonElement>('addWorkerModelEffortBtn').addEventListener('click', event => {
    event.stopPropagation();
    openModelEffortPopover({
      anchor: el<HTMLButtonElement>('addWorkerModelEffortBtn'),
      source: 'agy',
      currentModel: state.addWorkerDraft.model,
      currentEffort: state.addWorkerDraft.effort,
      preferAbove: false,
      onChange: next => {
        state.addWorkerDraft.model = next.model;
        state.addWorkerDraft.effort = next.effort;
        syncAddWorkerModalLabels();
      },
    });
  });

  el<HTMLButtonElement>('addWorkerPermBtn').addEventListener('click', event => {
    event.stopPropagation();
    openOptionPopover({
      anchor: el<HTMLButtonElement>('addWorkerPermBtn'),
      title: '워커 권한 수준',
      options: WORKER_PERMISSION_OPTIONS,
      currentValue: state.addWorkerDraft.permissionMode,
      preferAbove: false,
      onSelect: val => {
        state.addWorkerDraft.permissionMode = val as WorkerRecord['permissionMode'];
        syncAddWorkerModalLabels();
      },
    });
  });

  el<HTMLButtonElement>('browseWorkerCwdBtn').addEventListener('click', async () => {
    if (!window.hcomGui) return;
    const picked = await window.hcomGui.pickFolder();
    if (picked) el<HTMLInputElement>('addWorkerCwdInput').value = picked;
  });

  el<HTMLButtonElement>('confirmAddWorkerBtn').addEventListener('click', async () => {
    const targetProjectId = state.addWorkerDraft.projectId;
    if (!targetProjectId) return;
    const name = el<HTMLInputElement>('addWorkerNameInput').value.trim();
    const cwd = el<HTMLInputElement>('addWorkerCwdInput').value.trim();
    const errBox = el<HTMLDivElement>('addWorkerError');
    const requestKey = `add-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      closeModal('addWorkerModal');
      showNotice(`워커(${name || '새 워커'})를 추가하고 시작하는 중입니다...`);
      const res = await api<{ worker: WorkerRecord }>(`/api/projects/${encodeURIComponent(targetProjectId)}/workers`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          requestKey,
          ...(cwd ? { cwd } : {}),
          model: state.addWorkerDraft.model,
          reasoningEffort: state.addWorkerDraft.effort,
          permissionMode: state.addWorkerDraft.permissionMode,
          start: true,
        }),
      });
      showNotice(null);
      if (state.selectedProjectId === targetProjectId) {
        applyEventDelta(targetProjectId, { worker: res.worker });
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
    void loadDiagnostics(false);
  });
  el<HTMLButtonElement>('refreshDiagBtn').addEventListener('click', () => { void loadDiagnostics(true); });

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
    try {
      const health = await api<{ version?: string; dataDir?: string }>('/api/health');
      if (health.version) state.config.version = health.version;
      if (health.dataDir) state.config.dataDir = health.dataDir;
    } catch {}
  }
  el<HTMLSpanElement>('versionLabel').textContent = state.config.version.split('.').slice(0, 2).join('.');

  await refreshProjectsList();
  if (state.selectedProjectId) {
    await refreshActiveProject(state.selectedProjectId, true);
  } else {
    renderAll();
  }
  void loadDiagnostics(false);
  void loadModels(false);
}

void bootstrap();
