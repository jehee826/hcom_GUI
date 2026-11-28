import { mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CodexSession, type TurnResult } from '../src/codex/index.ts';
import { HcomAdapter, isJammedTerminal, isWorkerReply, type HcomEvent, type Participant, type Receipt, type WorkerBinding, type WorkerLaunch } from '../src/hcom/index.ts';
import { assertExpectedBranchReply, BRANCH_CHECK_TASK } from './verify-branch-common.ts';

const task = BRANCH_CHECK_TASK;
const delay = () => new Promise(resolve => setTimeout(resolve, 1000));

export async function verifyHcom(repo: string, command: string, model: string | undefined, branch: string) {
  // 모든 검증 프로세스가 같은 Windows 경로에서 상태 파일을 읽을 수 있게 한다.
  const hcomDir = await mkdtemp(join(dirname(repo), 'hcom-gui-verify-'));
  const workerSettings = join(hcomDir, 'agy-settings.json');
  // hcom 0.7.31은 agy 1.5.18의 자동 모드 안내를 입력된 텍스트로 판정하고, 기본 모드에서는 명령마다 승인 대기에 걸린다.
  await writeFile(workerSettings, JSON.stringify({ agentMode: '', toolPermission: 'always-proceed' }), { flag: 'wx' });
  const hcom = new HcomAdapter({ projectId: 'roundtrip', cwd: repo, hcomDir });
  await hcom.initialize();
  let sender: Participant | undefined;
  let worker: Participant | undefined;
  let binding: WorkerBinding | undefined;
  let launch: WorkerLaunch | undefined;
  let receipt: Receipt | undefined;
  let toolCallId: string | undefined;
  let verificationFailed = false;
  let events: HcomEvent[] = [];
  let eventError: Error | undefined;
  let stopFollow: (() => Promise<void>) | undefined;
  function follow(cursor: number): void {
    events = [];
    eventError = undefined;
    stopFollow = hcom.follow(cursor, event => events.push(event), error => { eventError = error; });
  }
  async function closeFollow(): Promise<void> {
    const close = stopFollow;
    stopFollow = undefined;
    if (close) await close();
  }
  async function prepareWorker(launch: WorkerLaunch): Promise<void> {
    if (launch.readiness === 'needs_attention') throw new Error(`워커 실행에 로컬 확인이 필요합니다 (${launch.name})`);
    if (await hcom.settleWorker(launch.name)) return;
    // hcom이 해당 실행의 준비를 확인했다면 전달을 맡기고 실제 회신까지 기다린다.
    if (launch.readiness !== 'ready') throw new Error(`워커 입력 준비 시간 초과 (${launch.name})`);
  }
  async function waitReply(requestId: number, target: Participant): Promise<HcomEvent> {
    const deadline = Date.now() + 180_000;
    let jammedSince: number | undefined;
    for (let tick = 0; Date.now() < deadline; tick++) {
      if (eventError) throw eventError;
      const found = events.find(event => isWorkerReply(event, 'roundtrip', sender!, target, requestId));
      if (found) return found;
      const status = events.findLast(event => event.id > requestId && event.type === 'status' && event.instance === target.name);
      if (status?.data.status === 'blocked') throw new Error(`워커가 대기 상태로 중단됐습니다 (${String(status.data.context ?? 'blocked')}): ${String(status.data.detail ?? '')}`);
      const started = events.some(event => event.id > requestId && event.type === 'status' && event.instance === target.name && event.data.status === 'active');
      if (!started && tick % 2 === 1) {
        const term = await hcom.readTerminal(target.name).catch(() => undefined);
        if (term) {
          const bannerCleared = await hcom.clearBannerOverlay(target.name, term).catch(() => false);
          if (bannerCleared) {
            jammedSince = undefined;
          } else if (isJammedTerminal(term, requestId)) {
            jammedSince ??= Date.now();
            if (Date.now() - jammedSince >= 4000) {
              await hcom.clearJammedInput(target.name, requestId, term).catch(() => false);
              jammedSince = undefined;
            }
          } else {
            jammedSince = undefined;
          }
        } else {
          jammedSince = undefined;
        }
      }
      await delay();
    }
    throw new Error('워커 결과 회신 시간 초과');
  }
  const session = await CodexSession.connect({
    command, cwd: repo, model, env: process.env, hcomDir,
    dynamicTools: [{ type: 'function', name: 'delegate_branch', description: '워커에게 현재 브랜치 이름 조회만 위임한다.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    onToolCall: async params => {
      if (params.tool !== 'delegate_branch' || typeof params.callId !== 'string' || !params.callId || !sender || !worker || !launch || toolCallId) throw new Error('예상하지 못한 위임 호출');
      toolCallId = params.callId;
      await prepareWorker(launch);
      receipt = await hcom.send(sender, worker, task);
      return { success: true, contentItems: [{ type: 'inputText', text: '작업을 전달했습니다. 실제 회신은 나중에 제공됩니다.' }] };
    },
  });
  try {
    const threadId = await session.startThread();
    sender = await hcom.startCodex(threadId);
    launch = await hcom.launchWorker(workerSettings);
    // 첫 작업 이후 native ID가 생길 수 있으므로 시작 이름은 전달에만 사용한다.
    worker = { projectId: 'roundtrip', name: launch.name, sessionId: '', tool: 'agy', status: 'starting' };
    follow(0);
    const delegated = await session.runTurn({ text: 'delegate_branch 도구를 정확히 한 번 호출하여 현재 브랜치 이름 조회를 위임하고 전달 상태만 알려줘. 이후 도구 출력으로 워커 회신이 전달되면 다른 설명이나 서식 없이 브랜치 이름만 답해.' });
    if (delegated.status !== 'completed' || !receipt) throw new Error(`위임 턴 또는 작업 전달 확인 실패: ${JSON.stringify(delegated)}`);
    const sent = receipt as Receipt;
    const reply = await waitReply(sent.eventId, worker);
    binding = await hcom.probeWorker(worker.name);
    worker = binding;
    if (!isWorkerReply(reply, 'roundtrip', sender, binding, sent.eventId)) throw new Error('워커 바인딩과 회신이 일치하지 않습니다.');
    const text = assertExpectedBranchReply(String(reply.data.text), branch, '워커의 브랜치 결과');

    await closeFollow();
    follow(sent.eventId);
    const replay = await waitReply(sent.eventId, binding);
    if (replay.id !== reply.id || String(replay.data.text).trim() !== text) throw new Error('재생된 회신이 원래 회신과 다릅니다.');
    await closeFollow();

    const review: TurnResult = await session.runTurn({ toolOutput: { name: 'delegate_branch', output: `워커의 실제 회신: ${text}\n회신을 확인했고, 다른 설명이나 마크다운 서식 없이 위 브랜치 이름만 그대로 출력하세요.` } });
    if (review.status !== 'completed' || review.finalText?.trim() !== branch || review.turnId === delegated.turnId) throw new Error(`검토 턴 불일치: ${JSON.stringify(review)}`);
    await hcom.stopWorker(binding);
    launch = undefined;
    launch = await hcom.resumeWorker(binding, workerSettings);
    await prepareWorker(launch);
    follow(reply.id);
    const resumedReceipt = await hcom.send(sender, binding, task);
    const resumedReply = await waitReply(resumedReceipt.eventId, binding);
    const resumed = await hcom.verifyResumedWorker(binding);
    if (String(resumedReply.data.text).trim() !== branch || !isWorkerReply(resumedReply, 'roundtrip', sender, resumed, resumedReceipt.eventId)) throw new Error('재개 워커의 회신 또는 세션이 일치하지 않습니다.');
    return { hcomDir, threadId, sender, worker: binding, resumed, toolCallId, requestEventId: sent.eventId, replyEventId: reply.id, replayEventId: replay.id, resumedRequestEventId: resumedReceipt.eventId, resumedReplyEventId: resumedReply.id, delegated, review };
  } catch (error) {
    verificationFailed = true;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const result of await Promise.allSettled([closeFollow(), session.close()])) {
      if (result.status === 'rejected') cleanupErrors.push(result.reason);
    }
    try {
      if (launch) {
        if (verificationFailed || !binding) await hcom.stopLaunch(launch, binding?.sessionId);
        else await hcom.stopWorker(await hcom.verifyResumedWorker(binding));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (sender) await hcom.stopCodex(sender);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      const error = new AggregateError(cleanupErrors, `검증 세션 정리 확인 필요 (${hcomDir})`);
      if (!verificationFailed) throw error;
      console.error(error);
    }
  }
}
