import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { sessionEnvironment } from '../session-env.ts';

type JsonObject = Record<string, unknown>;
type RpcId = string | number;
export type DynamicTool = { type: 'function'; name: string; description: string; inputSchema: JsonObject; deferLoading?: boolean };
export type ToolResult = { contentItems: Array<{ type: 'inputText'; text: string }>; success: boolean };
export type ToolOutput = { name: string; namespace?: string | null; output: string };
export type Progress = { method: string; params: JsonObject };
export type TurnResult = {
  threadId: string; turnId: string;
  status: 'completed' | 'failed' | 'interrupted' | 'needs_final_answer';
  finalText?: string; reason?: string;
};
export type SessionOptions = {
  command: string; args?: string[]; cwd: string; env: NodeJS.ProcessEnv; hcomDir?: string;
  model?: string; timeoutMs?: number; dynamicTools?: DynamicTool[];
  onToolCall?: (params: JsonObject) => Promise<ToolResult>;
  onProgress?: (event: Progress) => void;
};

type Pending = { timer: NodeJS.Timeout; resolve: (value: unknown) => void; reject: (error: Error) => void };
type ActiveTurn = { threadId: string; turnId?: string; buffered: Progress[]; toolRequests: Array<{ id: RpcId; params: JsonObject }>; finalText?: string; missingPhase: boolean; finished: boolean; resolve: (value: TurnResult) => void; reject: (error: Error) => void };
const obj = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export class CodexSession {
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private active?: ActiveTurn;
  private threadId?: string;
  private bindingThread = false;
  private ended = false;
  private readonly exit: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: SessionOptions;
  private constructor(child: ChildProcessWithoutNullStreams, options: SessionOptions) {
    this.child = child;
    this.options = options;
    this.exit = new Promise(resolve => child.once('close', () => resolve()));
    child.on('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    child.on('close', (code, signal) => this.fail(new Error(`App Server 종료: ${code ?? signal}`)));
    createInterface({ input: child.stdout }).on('line', line => this.receive(line));
    child.stderr.resume();
  }
  static async connect(options: SessionOptions): Promise<CodexSession> {
    if (!isAbsolute(options.cwd)) throw new Error('cwd는 절대 경로여야 합니다.');
    if (options.hcomDir !== undefined && !isAbsolute(options.hcomDir)) throw new Error('HCOM_DIR은 절대 경로여야 합니다.');
    const child = spawn(options.command, options.args ?? ['app-server'], {
      cwd: options.cwd, env: sessionEnvironment(options.env, options.hcomDir), stdio: 'pipe', windowsHide: true,
    });
    const session = new CodexSession(child, options);
    try {
      await session.request('initialize', {
        clientInfo: { name: 'hcom_gui', title: 'hcom_gui', version: '1.0.0' },
        ...(options.dynamicTools || options.onToolCall ? { capabilities: { experimentalApi: true } } : {}),
      });
      session.send({ method: 'initialized', params: {} });
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async listModels(): Promise<JsonObject> {
    return obj(await this.request('model/list', {}));
  }
  async startThread(): Promise<string> {
    return this.bindThread('thread/start', {
      cwd: this.options.cwd, approvalPolicy: 'never', sandbox: 'read-only',
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.dynamicTools ? { dynamicTools: this.options.dynamicTools } : {}),
    });
  }
  async resumeThread(threadId: string): Promise<string> {
    if (!nonempty(threadId)) throw new Error('스레드 ID가 잘못되었습니다.');
    return this.bindThread('thread/resume', { threadId, cwd: this.options.cwd, approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true, ...(this.options.model ? { model: this.options.model } : {}) }, threadId);
  }
  private async bindThread(method: 'thread/start' | 'thread/resume', params: JsonObject, expectedId?: string): Promise<string> {
    if (this.threadId || this.bindingThread) throw new Error('이미 스레드를 연결했거나 연결하고 있습니다.');
    this.bindingThread = true;
    try {
      const result = obj(await this.request(method, params));
      const id = obj(result.thread).id;
      if (!nonempty(id)) throw new Error('스레드 ID가 없습니다.');
      if (expectedId && id !== expectedId) throw new Error('재개된 스레드 ID가 요청과 다릅니다.');
      this.threadId = id;
      return id;
    } finally {
      this.bindingThread = false;
    }
  }
  async runTurn(input: { text: string } | { toolOutput: ToolOutput }): Promise<TurnResult> {
    const threadId = this.threadId;
    if (!threadId) throw new Error('스레드를 먼저 연결해야 합니다.');
    if (this.active) throw new Error('이미 진행 중인 턴이 있습니다.');
    if ('text' in input ? !nonempty(input.text) : !nonempty(input.toolOutput.name)) throw new Error('턴 입력이 비어 있습니다.');
    const timeoutMs = this.options.timeoutMs ?? 300_000;
    let resolve!: (value: TurnResult) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<TurnResult>((yes, no) => { resolve = yes; reject = no; });
    completed.catch(() => {});
    const active: ActiveTurn = { threadId, buffered: [], toolRequests: [], missingPhase: false, finished: false, resolve, reject };
    this.active = active;
    const timer = setTimeout(() => {
      this.fail(new Error('턴 응답 시간이 초과됐습니다. 접수 여부 확인이 필요합니다.'));
      this.child.kill();
    }, timeoutMs);
    completed.finally(() => clearTimeout(timer)).catch(() => {});
    try {
      const result = obj(await this.request('turn/start', {
        threadId, cwd: this.options.cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' },
        ...('text' in input ? { input: [{ type: 'text', text: input.text }] } : { input: [], toolOutput: input.toolOutput }),
      }));
      const turnId = obj(result.turn).id;
      if (!nonempty(turnId)) throw new Error('턴 ID가 없습니다.');
      active.turnId = turnId;
      for (const request of active.toolRequests) void this.serverRequest(request.id, 'item/tool/call', request.params);
      active.toolRequests = [];
      for (const event of active.buffered) this.turnEvent(active, event);
      active.buffered = [];
    } catch (error) {
      clearTimeout(timer);
      if (this.active === active) this.active = undefined;
      this.fail(new Error('턴 시작 결과 확인 필요'));
      this.child.kill();
      // 접수 결과가 모호하므로 호출자가 자동 재전송하지 않도록 오류를 전달한다.
      throw error;
    }
    try {
      const result = await completed;
      if (result.status !== 'needs_final_answer') return result;
      return await this.recoverFinalAnswer(result);
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }
  private async recoverFinalAnswer(result: TurnResult): Promise<TurnResult> {
    try {
      const history = obj(await this.request('thread/turns/list', {
        threadId: result.threadId, itemsView: 'full', sortDirection: 'desc', limit: 5,
      }));
      if (!Array.isArray(history.data)) return result;
      const turn = history.data.map(obj).find(entry => entry.id === result.turnId && entry.status === 'completed');
      if (!turn || !Array.isArray(turn.items)) return result;
      const answer = turn.items.map(obj).findLast(item => item.type === 'agentMessage' && item.phase === 'final_answer');
      if (answer && nonempty(answer.text)) {
        return { threadId: result.threadId, turnId: result.turnId, status: 'completed', finalText: answer.text };
      }
    } catch {
      return { ...result, reason: '이력 조회 실패: 최종 답변 확인 필요' };
    }
    return result;
  }
  async close(): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.fail(new Error('App Server 연결을 닫았습니다.'));
      this.child.stdin.end();
    }
    const timer = setTimeout(() => this.child.kill(), 2000);
    timer.unref();
    try { await this.exit; } finally { clearTimeout(timer); }
  }
  private send(message: JsonObject): void {
    if (this.ended || !this.child.stdin.writable) throw new Error('App Server 연결이 닫혔습니다.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(method + ' 응답 시간이 초과됐습니다. 접수 여부 확인이 필요합니다.'));
        this.child.kill();
      }, this.options.timeoutMs ?? 300_000);
      this.pending.set(id, { timer, resolve, reject });
      try { this.send({ id, method, params }); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  private fail(error: Error): void {
    this.ended = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (this.active) { this.active.reject(error); this.active = undefined; }
  }
  private receive(line: string): void {
    let message: JsonObject;
    try { message = obj(JSON.parse(line)); } catch { this.fail(new Error('잘못된 App Server JSON 응답입니다.')); this.child.kill(); return; }
    const id = message.id;
    if ((typeof id === 'string' || typeof id === 'number') && typeof message.method === 'string') {
      void this.serverRequest(id, message.method, obj(message.params));
    } else if (typeof id === 'string' || typeof id === 'number') {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`App Server 오류: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    } else if (typeof message.method === 'string') {
      const event = { method: message.method, params: obj(message.params) };
      const active = this.active;
      if (active) {
        if (active.turnId) this.turnEvent(active, event);
        else active.buffered.push(event);
      }
    }
  }
  private async serverRequest(id: RpcId, method: string, params: JsonObject): Promise<void> {
    try {
      if (method === 'item/tool/call' && this.active && !this.active.turnId) {
        this.active.toolRequests.push({ id, params });
        return;
      }
      let result: unknown;
      if (method === 'item/tool/call' && this.options.onToolCall && this.active && !this.active.finished && params.threadId === this.threadId && params.turnId === this.active.turnId) {
        result = await this.options.onToolCall(params);
      } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        this.options.onProgress?.({ method, params });
        result = { decision: 'decline' };
      } else {
        this.send({ id, error: { code: -32601, message: 'Unsupported request' } });
        return;
      }
      this.send({ id, result });
    } catch (error) {
      if (!this.ended) this.send({ id, error: { code: -32603, message: error instanceof Error ? error.message : 'Request failed' } });
    }
  }
  private turnEvent(active: ActiveTurn, event: Progress): void {
    const params = event.params;
    const turn = obj(params.turn);
    const eventTurnId = event.method === 'turn/completed' || event.method === 'turn/started' ? turn.id : params.turnId;
    if (active.finished || params.threadId !== active.threadId || eventTurnId !== active.turnId) return;
    this.options.onProgress?.(event);
    if (event.method === 'item/completed') {
      const item = obj(params.item);
      if (item.type === 'agentMessage') {
        if (item.phase === 'final_answer' && nonempty(item.text)) active.finalText = item.text;
        if (item.phase == null) active.missingPhase = true;
      }
    }
    if (event.method === 'turn/completed') {
      active.finished = true;
      const status = turn.status;
      if (status === 'failed' || status === 'interrupted') {
        active.resolve({ threadId: active.threadId, turnId: active.turnId!, status, reason: JSON.stringify(turn.error ?? null) });
      } else if (status === 'completed' && active.finalText) {
        active.resolve({ threadId: active.threadId, turnId: active.turnId!, status: 'completed', finalText: active.finalText });
      } else {
        active.resolve({ threadId: active.threadId, turnId: active.turnId!, status: 'needs_final_answer', reason: status === 'completed' ? (active.missingPhase ? 'phase 누락: 이력 확인 필요' : '최종 본문 누락') : `알 수 없는 턴 상태: ${String(status)}` });
      }
    }
  }
}
