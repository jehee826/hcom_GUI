import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { sessionEnvironment } from '../session-env.ts';

export interface ProjectScope { projectId: string; cwd: string; hcomDir: string }
export interface Participant { projectId: string; name: string; sessionId: string; tool: string; status: string }
export interface WorkerLaunch { readonly name: string; readonly batchId: string; readonly readiness: 'ready' | 'starting' | 'needs_attention' }
export interface WorkerBinding extends Participant { evidence: 'hcom-managed-binding'; hooksBound: true; processBound: true; directory: string }
export interface Receipt { eventId: number; deliveredTo: string[] }
export interface HcomEvent { projectId: string; id: number; type: string; instance?: string; data: Record<string, unknown> }
export interface TerminalState { ready: boolean; promptEmpty: boolean | null; inputText: string | null; lines: string[]; cursorRow?: number }
export interface CommandResult { stdout: string; stderr: string; code: number }
export type Runner = (args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<CommandResult>;

function identity(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) || value.endsWith('-')) throw new Error('유효하지 않은 참가자 이름');
  return value;
}
function nonempty(value: string): string {
  if (!value.trim() || /[\r\n\0]/.test(value)) throw new Error('유효하지 않은 세션 ID');
  return value;
}
function workerSettingsArgs(settingsPath?: string): string[] {
  if (!settingsPath) return [];
  if (!(isAbsolute(settingsPath) || win32.isAbsolute(settingsPath))) throw new Error('워커 설정은 절대 경로여야 합니다');
  return ['--', '--settings', settingsPath];
}
function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('잘못된 hcom JSON');
  return value as Record<string, unknown>;
}
export function parseFollowLine(line: string, projectId: string): HcomEvent {
  const value = parseObject(line);
  if (value.db_reset === true) throw new Error('hcom DB가 교체되어 커서 복구가 필요합니다');
  if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0 || typeof value.type !== 'string' || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw new Error('잘못된 이벤트');
  return {
    projectId,
    id: value.id as number,
    type: value.type,
    instance: typeof value.instance === 'string' ? value.instance : undefined,
    data: value.data as Record<string, unknown>,
  };
}
function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('hcom', args, { cwd, env, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('hcom 명령 시간 초과, 실행 결과 확인 필요'));
      else resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export class HcomAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private ready = false;
  private readonly launches = new Map<string, WorkerLaunch>();
  readonly scope: Readonly<ProjectScope>;
  private readonly runner: Runner;
  constructor(scope: ProjectScope, runner: Runner = run) {
    if (!scope.projectId || !(isAbsolute(scope.cwd) || win32.isAbsolute(scope.cwd)) || !(isAbsolute(scope.hcomDir) || win32.isAbsolute(scope.hcomDir))) throw new Error('프로젝트와 절대 경로가 필요합니다');
    this.scope = Object.freeze({ ...scope });
    this.runner = runner;
    this.env = sessionEnvironment(process.env, scope.hcomDir);
  }
  private async command(args: string[], codexThreadId?: string): Promise<string> {
    const env = { ...this.env };
    if (codexThreadId !== undefined) env.CODEX_THREAD_ID = codexThreadId;
    const result = await this.runner(args, env, this.scope.cwd);
    if (result.code !== 0) throw new Error(`hcom 명령 실패 (${result.code}): ${result.stderr || result.stdout}`);
    return result.stdout;
  }
  async initialize(): Promise<void> {
    let status = await this.command(['relay', 'status']);
    if (!/^Relay: (?:not configured|disabled)\s*$/m.test(status)) {
      await this.command(['relay', 'off']);
      status = await this.command(['relay', 'status']);
      if (!/^Relay: (?:not configured|disabled)\s*$/m.test(status)) throw new Error('프로젝트 relay 비활성화 확인 필요');
    }
    this.ready = true;
  }
  private requireReady(): void { if (!this.ready) throw new Error('먼저 프로젝트 relay를 비활성화해야 합니다'); }
  private check(participant: Participant): void {
    if (participant.projectId !== this.scope.projectId) throw new Error('다른 프로젝트 참가자입니다');
    identity(participant.name);
  }
  async startCodex(threadId: string): Promise<Participant> {
    this.requireReady(); nonempty(threadId);
    const output = await this.command(['start'], threadId);
    const names = [...output.matchAll(/\[hcom:([a-zA-Z0-9_-]+)\]|hcom already started for ([a-zA-Z0-9_-]+)/g)].map(match => match[1] ?? match[2]);
    const name = names[0];
    if (!name || names.some(found => found !== name)) throw new Error('Codex 참가자 이름 확인 필요');
    const participant = await this.listParticipant(name);
    if (participant.sessionId !== threadId || participant.tool !== 'adhoc') throw new Error('Codex 참가자와 스레드가 일치하지 않습니다');
    return participant;
  }
  async listParticipant(name: string): Promise<Participant> {
    this.requireReady(); identity(name);
    const data = parseObject(await this.command(['list', name, '--json']));
    if (data.name !== name || typeof data.session_id !== 'string' || typeof data.tool !== 'string' || typeof data.status !== 'string') throw new Error('참가자 정보가 일치하지 않습니다');
    return { projectId: this.scope.projectId, name: data.name, sessionId: data.session_id, tool: data.tool, status: data.status };
  }
  async stopCodex(participant: Participant): Promise<void> {
    this.requireReady(); this.check(participant); nonempty(participant.sessionId);
    if (participant.tool !== 'adhoc') throw new Error('Codex 참가자만 연결을 해제할 수 있습니다');
    const matches = (item: Record<string, unknown>) => item.name === participant.name || item.session_id === participant.sessionId;
    const current = (await this.listActive()).filter(matches);
    if (current.length === 0) return;
    if (current.length !== 1 || current[0].name !== participant.name || current[0].session_id !== participant.sessionId || current[0].tool !== 'adhoc') {
      throw new Error('Codex 참가자와 스레드가 변경되었습니다');
    }
    await this.command(['stop', participant.name]);
    if ((await this.listActive()).some(matches)) throw new Error('Codex 참가자 연결 해제 확인 필요');
  }
  async launchWorker(settingsPath?: string): Promise<WorkerLaunch> {
    this.requireReady();
    return this.startWorker(['agy', '--headless', '--json', '--go', ...workerSettingsArgs(settingsPath)]);
  }
  private async startWorker(args: string[], expectedName?: string): Promise<WorkerLaunch> {
    const result = await this.runner(args, { ...this.env }, this.scope.cwd);
    if (result.code !== 0 && result.code !== 2) {
      throw new Error(`hcom 워커 실행 실패 (${result.code}): ${result.stderr || result.stdout}`);
    }
    // 종료 코드 2에서도 이미 실행된 워커의 이름과 소유권을 보존한다.
    const data = parseObject(result.stdout);
    if (data.launched !== 1 || data.failed !== 0 || !Array.isArray(data.names) || data.names.length !== 1 || typeof data.names[0] !== 'string' || typeof data.batch_id !== 'string') {
      throw new Error(`워커 실행 결과 확인 필요 (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 1000)}`);
    }
    const name = identity(data.names[0]);
    if (expectedName && name !== expectedName) throw new Error('재개 대상 워커 이름이 일치하지 않습니다');
    const summary = data.readiness && typeof data.readiness === 'object' ? data.readiness as Record<string, unknown> : undefined;
    let readiness: WorkerLaunch['readiness'] = 'starting';
    if (summary?.status === 'ready') readiness = 'ready';
    else if (result.code === 2 && summary?.status !== 'timeout') readiness = 'needs_attention';
    const launch = Object.freeze({ name, batchId: data.batch_id, readiness });
    this.launches.set(name, launch);
    return launch;
  }
  private async listActive(): Promise<Record<string, unknown>[]> {
    const value: unknown = JSON.parse(await this.command(['list', '--json']));
    if (!Array.isArray(value) || !value.every((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))) throw new Error('참가자 목록 확인 필요');
    return value;
  }
  private async findWorker(name: string): Promise<(Record<string, unknown> & { tool: string; directory: string }) | undefined> {
    const matches = (await this.listActive()).filter(item => item.name === name);
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) throw new Error('워커 참가자 확인 필요');
    const item = matches[0];
    if (item.base_name !== name || (item.tool !== 'agy' && item.tool !== 'antigravity') || typeof item.directory !== 'string' || win32.normalize(item.directory).toLowerCase() !== win32.normalize(this.scope.cwd).toLowerCase()) throw new Error('워커의 프로젝트 소속 확인 필요');
    return { ...item, tool: item.tool, directory: item.directory };
  }
  async probeWorker(name: string): Promise<WorkerBinding> {
    this.requireReady(); identity(name);
    const item = await this.findWorker(name);
    if (!item || item.hooks_bound !== true || item.process_bound !== true || typeof item.session_id !== 'string' || !item.session_id || typeof item.status !== 'string' || item.status === 'stopped') throw new Error('워커의 세션 바인딩 확인 필요');
    return { projectId: this.scope.projectId, name, sessionId: item.session_id, status: item.status, tool: item.tool, directory: item.directory, hooksBound: true, processBound: true, evidence: 'hcom-managed-binding' };
  }
  private async verifyStopped(worker: WorkerBinding): Promise<void> {
    const active = await this.listActive();
    if (active.some(item => item.name === worker.name || item.base_name === worker.name || item.session_id === worker.sessionId)) throw new Error('워커에 활성 바인딩이 남아 있습니다');
    const snapshot = parseObject(await this.command(['list', '--stopped', worker.name, '--json']));
    if (snapshot.name !== worker.name || snapshot.tool !== worker.tool || snapshot.session_id !== worker.sessionId || typeof snapshot.directory !== 'string' || win32.normalize(snapshot.directory).toLowerCase() !== win32.normalize(this.scope.cwd).toLowerCase()) throw new Error('중지된 워커와 저장된 세션이 일치하지 않습니다');
  }
  async stopWorker(worker: WorkerBinding): Promise<void> {
    this.requireReady(); this.check(worker);
    const current = await this.probeWorker(worker.name);
    if (current.sessionId !== worker.sessionId) throw new Error('워커 세션이 변경되었습니다');
    await this.command(['kill', worker.name]);
    await this.verifyStopped(worker);
    this.launches.delete(worker.name);
  }
  async stopLaunch(launch: WorkerLaunch, expectedSessionId?: string): Promise<void> {
    this.requireReady();
    if (this.launches.get(launch.name) !== launch) throw new Error('이 연결이 시작한 워커인지 확인할 수 없습니다');
    const current = await this.findWorker(launch.name);
    if (current) {
      if (current.process_bound !== true || (expectedSessionId && current.session_id && current.session_id !== expectedSessionId)) throw new Error('워커 프로세스 또는 세션이 변경되었습니다');
      await this.command(['kill', launch.name]);
      if (await this.findWorker(launch.name)) throw new Error('워커 종료 확인 필요');
    }
    this.launches.delete(launch.name);
  }
  async resumeWorker(worker: WorkerBinding, settingsPath?: string): Promise<WorkerLaunch> {
    this.requireReady(); this.check(worker);
    await this.verifyStopped(worker);
    return this.startWorker(['r', worker.name, '--headless', '--json', '--go', ...workerSettingsArgs(settingsPath)], worker.name);
  }
  async verifyResumedWorker(worker: WorkerBinding): Promise<WorkerBinding> {
    const current = await this.probeWorker(worker.name);
    if (current.sessionId !== worker.sessionId) throw new Error('재개된 native 대화 ID가 다릅니다');
    return current;
  }
  async readTerminal(name: string): Promise<TerminalState> {
    this.requireReady(); identity(name);
    const data = parseObject(await this.command(['term', name, '--json']));
    return {
      ready: data.ready === true,
      promptEmpty: typeof data.prompt_empty === 'boolean' ? data.prompt_empty : null,
      inputText: typeof data.input_text === 'string' ? data.input_text : null,
      lines: Array.isArray(data.lines) ? data.lines.map(line => typeof line === 'string' ? line : '') : [],
      cursorRow: Array.isArray(data.cursor) && Number.isSafeInteger(data.cursor[0]) ? data.cursor[0] as number : undefined,
    };
  }
  // agy 1.5.18 시작 공지 배너가 프롬프트를 밀어낼 때 구분선·단축키 안내가 입력칸에 겹친다.
  async clearBannerOverlay(name: string): Promise<boolean> {
    let term = await this.readTerminal(name);
    const hasBanner = term.lines.some(line => line.includes('esc to dismiss'));
    const input = term.inputText?.trim() ?? '';
    const artifact = /^(?:for shortcuts|─+)$/;
    if (!term.ready || (input && !artifact.test(input))) return false;
    if (!artifact.test(input) && !(hasBanner && term.promptEmpty === true)) return false;
    if (hasBanner) {
      await this.command(['term', 'inject', name, '\x1b']);
      await new Promise(resolve => setTimeout(resolve, 250));
      term = await this.readTerminal(name);
    }
    if (term.ready && term.promptEmpty === false && artifact.test(term.inputText?.trim() ?? '')) {
      await this.command(['term', 'inject', name, ' \x08']);
    }
    return true;
  }
  private async probeInputEcho(name: string): Promise<boolean> {
    await this.command(['term', 'inject', name, 'x']);
    const echoDeadline = Date.now() + 1500;
    let echoed = false;
    while (Date.now() < echoDeadline) {
      const term = await this.readTerminal(name);
      if (term.inputText?.trim() === 'x') { echoed = true; break; }
      if (term.inputText?.trim()) return false;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!echoed) return false;
    await this.command(['term', 'inject', name, '\x15']);
    const clearDeadline = Date.now() + 1500;
    while (Date.now() < clearDeadline) {
      const term = await this.readTerminal(name);
      if (term.ready && term.promptEmpty === true) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }
  async clearJammedInput(name: string, requestId: number): Promise<boolean> {
    const term = await this.readTerminal(name);
    if (!isJammedTerminal(term, requestId)) return false;
    // 입력칸에서 직접 확인한 요청만 지우고, 화면 잔상은 다시 그리기만 한다.
    const inputMatches = term.promptEmpty !== true && term.inputText?.trim().startsWith(`<hcom>[request #${requestId}]`);
    await this.command(['term', 'inject', name, inputMatches ? '\x15\x0c' : '\x0c']);
    return true;
  }
  async settleWorker(name: string, timeoutMs = 20_000): Promise<boolean> {
    const start = Date.now();
    const fallbackMs = Math.min(12_000, Math.floor(timeoutMs * 0.7));
    let stableClean = 0;
    let sawTier = false;
    let syncAttempts = 0;
    while (Date.now() - start < timeoutMs) {
      let term: TerminalState;
      try {
        term = await this.readTerminal(name);
      } catch (error) {
        if (error instanceof Error && /has no terminal screen/i.test(error.message)) {
          stableClean = 0;
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        throw error;
      }
      const hasBanner = term.lines.some(line => line.includes('esc to dismiss'));
      if (term.lines.some(line => /\(Google AI|\bPro\b|\bUltra\b/.test(line))) sawTier = true;
      if (await this.clearBannerOverlay(name)) {
        stableClean = 0;
        await new Promise(resolve => setTimeout(resolve, 400));
        continue;
      }
      const ready = term.ready && term.promptEmpty === true && !hasBanner;
      if (ready && (sawTier || Date.now() - start >= fallbackMs)) {
        const hasInkFrame = term.lines.some(line => /─{10,}|for shortcuts/.test(line));
        if (hasInkFrame) {
          if (syncAttempts >= 3) return false;
          syncAttempts++;
          // ConPTY와 Ink의 비동기 초기 그리기 이후 커서를 입력칸 안으로 재정렬한다.
          await this.command(['term', 'inject', name, '\x0c']);
          await new Promise(resolve => setTimeout(resolve, 500));
          if (await this.probeInputEcho(name)) return true;
          stableClean = 0;
          continue;
        }
        stableClean++;
        if (stableClean >= 3) return true;
      } else {
        stableClean = 0;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
  }
  async send(sender: Participant, target: Participant, text: string): Promise<Receipt> {
    this.requireReady(); this.check(sender); this.check(target);
    if (sender.name === target.name || !text.trim()) throw new Error('유효하지 않은 작업 또는 대상');
    const data = parseObject(await this.command(['--name', sender.name, 'send', `@${target.name}`, '--intent', 'request', '--json', '--', text]));
    if (!Number.isSafeInteger(data.event_id) || (data.event_id as number) <= 0 || !Array.isArray(data.delivered_to) || data.delivered_to.length !== 1 || data.delivered_to[0] !== target.name) throw new Error('hcom 전달 결과 확인 필요');
    return { eventId: data.event_id as number, deliveredTo: [target.name] };
  }
  follow(afterId: number, onEvent: (event: HcomEvent) => void, onError: (error: Error) => void): () => Promise<void> {
    this.requireReady();
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('유효하지 않은 이벤트 커서');
    const child: ChildProcessWithoutNullStreams = spawn('hcom', ['events', '--follow', '--full', '--after-id', String(afterId)], { cwd: this.scope.cwd, env: this.env, shell: false, windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let stopped = false;
    child.stderr.resume();
    lines.on('line', line => {
      try {
        onEvent(parseFollowLine(line, this.scope.projectId));
      } catch (error) { stopped = true; lines.close(); child.kill(); onError(error instanceof Error ? error : new Error(String(error))); }
    });
    child.on('error', onError);
    child.on('close', code => { if (!stopped) onError(new Error(`hcom 이벤트 구독 종료 (${code})`)); });
    const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
    return async () => { stopped = true; lines.close(); if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; };
  }
}

export function isJammedTerminal(term: TerminalState, requestId: number): boolean {
  if (term.lines.some(line => /\besc to cancel\b/i.test(line))) return false;
  const marker = `<hcom>[request #${requestId}]`;
  const input = term.inputText?.trim();
  if (input?.startsWith(marker) && term.promptEmpty !== true) return true;
  // agy 재개 시 hcom은 이전 대화의 입력을 읽고, 실제 커서는 새 요청 위에 있을 수 있다.
  const cursorLine = term.cursorRow === undefined ? undefined : term.lines[term.cursorRow];
  if (cursorLine?.includes(marker)) return true;
  if (input) return false;
  if (term.promptEmpty === true) {
    if (!term.ready || typeof term.inputText !== 'string') return false;
    const bottom = term.lines.filter(line => line.trim()).slice(-14).join('\n');
    const first = bottom.indexOf(marker);
    return first !== -1 && bottom.indexOf(marker, first + marker.length) !== -1;
  }
  const bottom = term.lines.filter(line => line.trim().length > 0).slice(-6);
  return !term.ready && bottom.some(line => line.trim().replace(/^>\s*/, '').startsWith(marker));
}

export function isWorkerReply(event: HcomEvent, projectId: string, sender: Participant, worker: Participant, requestEventId: number): boolean {
  const d = event.data;
  return event.projectId === projectId && sender.projectId === projectId && worker.projectId === projectId && Number.isSafeInteger(requestEventId) && requestEventId > 0 && event.id > requestEventId && event.type === 'message' && d.from === worker.name && d.sender_kind === 'instance' && d.scope === 'mentions' && Array.isArray(d.delivered_to) && d.delivered_to.length === 1 && d.delivered_to[0] === sender.name && d.reply_to === String(requestEventId) && d.intent === 'inform' && typeof d.text === 'string' && d.text.trim().length > 0;
}
