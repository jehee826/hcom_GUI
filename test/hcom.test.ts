import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HcomAdapter, isJammedTerminal, isWorkerReply, parseFollowLine, type HcomEvent, type Participant, type Runner } from '../src/hcom/index.ts';

const codex: Participant = { projectId: 'a', name: 'codex', sessionId: 'thread', tool: 'adhoc', status: 'active' };
const worker: Participant = { projectId: 'a', name: 'worker', sessionId: 'conversation', tool: 'agy', status: 'active' };

test('프로젝트 환경과 Codex 스레드 바인딩을 검증한다', async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const runner: Runner = async (args, env) => {
    calls.push({ args, env });
    return { code: 0, stderr: '', stdout: args[0] === 'list' ? JSON.stringify({ name: 'codex', session_id: 'thread', tool: 'adhoc', status: 'active' }) : args[0] === 'start' ? '[hcom:codex]' : 'Relay: not configured\n' };
  };
  const adapter = new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner);
  await adapter.initialize();
  assert.deepEqual(await adapter.startCodex('thread'), codex);
  assert.equal(calls[1]?.env.CODEX_THREAD_ID, 'thread');
  assert.equal(calls[1]?.env.HCOM_DIR, 'C:\\isolated');
  assert.deepEqual(calls[2]?.args, ['list', 'codex', '--json']);
  assert.equal(calls[2]?.env.HCOM_DIR, 'C:\\isolated');
  assert.equal(calls[2]?.env.CODEX_THREAD_ID, undefined);
  await assert.rejects(adapter.listParticipant('other'), /참가자 정보가 일치하지/);
});

test('다른 프로젝트와 잘못된 수신 결과를 거부한다', async () => {
  let sends = 0;
  const runner: Runner = async args => ({ code: 0, stderr: '', stdout: args.includes('send') ? (sends++, JSON.stringify({ event_id: 1, delivered_to: ['other'] })) : 'Relay: not configured\n' });
  const adapter = new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner);
  await adapter.initialize();
  await assert.rejects(adapter.send(codex, { ...worker, projectId: 'b' }, 'work'));
  assert.equal(sends, 0);
  await assert.rejects(adapter.send(codex, worker, 'work'));
});

test('종료 시 같은 프로젝트의 정확한 Codex 참가자만 연결 해제한다', async () => {
  const calls: string[][] = [];
  let active = true;
  const runner: Runner = async (args, env) => {
    calls.push(args);
    assert.equal(env.HCOM_DIR, 'C:\\isolated');
    if (args[0] === 'list') return { code: 0, stderr: '', stdout: JSON.stringify(active ? [{ name: codex.name, session_id: codex.sessionId, tool: codex.tool }] : []) };
    if (args[0] === 'stop') active = false;
    return { code: 0, stderr: '', stdout: 'Relay: not configured\n' };
  };
  const adapter = new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner);
  await adapter.initialize();
  await assert.rejects(adapter.stopCodex({ ...codex, projectId: 'b' }), /다른 프로젝트/);
  await assert.rejects(adapter.stopCodex({ ...codex, sessionId: 'stale-thread' }), /변경/);
  await adapter.stopCodex(codex);
  await adapter.stopCodex(codex);
  assert.deepEqual(calls.filter(args => args[0] === 'stop'), [['stop', codex.name]]);
});

test('두 프로젝트가 같은 참가자 이름을 써도 전달과 응답을 프로젝트별로 검사한다', async () => {
  const deliveries: Array<{ dir: string | undefined; cwd: string; text: string | undefined }> = [];
  const runner: Runner = async (args, env, cwd) => {
    if (args.includes('send')) {
      deliveries.push({ dir: env.HCOM_DIR, cwd, text: args.at(-1) });
      // 각 DB의 이벤트 번호는 서로 같을 수 있다.
      return { code: 0, stderr: '', stdout: JSON.stringify({ event_id: 7, delivered_to: ['worker'] }) };
    }
    return { code: 0, stderr: '', stdout: 'Relay: not configured\n' };
  };
  const a = new HcomAdapter({ projectId: 'a', cwd: 'C:\\repo-a', hcomDir: 'C:\\hcom-a' }, runner);
  const b = new HcomAdapter({ projectId: 'b', cwd: 'C:\\repo-b', hcomDir: 'C:\\hcom-b' }, runner);
  const codexB = { ...codex, projectId: 'b', sessionId: 'thread-b' };
  const workerB = { ...worker, projectId: 'b', sessionId: 'conversation-b' };
  await Promise.all([a.initialize(), b.initialize()]);
  await Promise.all([
    a.send(codex, worker, 'branch-a'),
    b.send(codexB, workerB, 'branch-b'),
    assert.rejects(a.send(codex, workerB, 'cross-project'), /다른 프로젝트/),
    assert.rejects(b.send(codexB, worker, 'cross-project'), /다른 프로젝트/),
  ]);
  assert.deepEqual(deliveries, [
    { dir: 'C:\\hcom-a', cwd: 'C:\\repo-a', text: 'branch-a' },
    { dir: 'C:\\hcom-b', cwd: 'C:\\repo-b', text: 'branch-b' },
  ]);
  const reply: HcomEvent = { projectId: 'a', id: 8, type: 'message', data: { from: 'worker', sender_kind: 'instance', scope: 'mentions', delivered_to: ['codex'], reply_to: '7', intent: 'inform', text: 'branch-a' } };
  assert.equal(isWorkerReply(reply, 'a', codex, worker, 7), true);
  assert.equal(isWorkerReply(reply, 'a', codex, workerB, 7), false);
  assert.equal(isWorkerReply({ ...reply, projectId: 'b' }, 'a', codex, worker, 7), false);
});

test('DB 교체 표시는 이전 커서의 이벤트로 처리하지 않는다', () => {
  assert.throws(() => parseFollowLine('{"db_reset":true}', 'a'), /복구/);
  const event = parseFollowLine('{"id":2,"type":"message","data":{},"projectId":"b"}', 'a');
  assert.equal(event.id, 2);
  assert.equal(event.projectId, 'a');
});

test('관리형 바인딩과 중지 후 재개의 동일 ID를 확인한다', async () => {
  let status = 'active';
  let sessionId = 'conversation';
  const runner: Runner = async args => {
    let stdout = 'Relay: not configured\n';
    if (args[0] === 'list' && args[1] === '--json') stdout = JSON.stringify(status === 'stopped' ? [] : [{ name: 'worker', base_name: 'worker', tool: 'agy', status, session_id: sessionId, hooks_bound: true, process_bound: true, directory: 'C:\\project' }]);
    if (args[0] === 'list' && args[1] === '--stopped') stdout = JSON.stringify({ name: 'worker', tool: 'agy', session_id: sessionId, directory: 'C:\\project' });
    if (args[0] === 'kill') status = 'stopped';
    if (args[0] === 'r') { status = 'active'; stdout = JSON.stringify({ launched: 1, failed: 0, names: ['worker'], batch_id: 'batch' }); }
    return { code: 0, stderr: '', stdout };
  };
  const adapter = new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner);
  await adapter.initialize();
  const binding = await adapter.probeWorker('worker');
  await adapter.stopWorker(binding);
  await adapter.resumeWorker(binding);
  assert.equal((await adapter.verifyResumedWorker(binding)).sessionId, 'conversation');
  await assert.rejects(adapter.resumeWorker(binding), /활성 바인딩/);
  sessionId = 'different';
  await assert.rejects(adapter.verifyResumedWorker(binding));
});

test('기존 세션 환경을 자식 프로세스에 전달하지 않는다', async () => {
  const saved = {
    CODEX_TOOL_CALL_ID: process.env.CODEX_TOOL_CALL_ID,
    ANTIGRAVITY_AGENT: process.env.ANTIGRAVITY_AGENT,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    GEMINI_CLI: process.env.GEMINI_CLI,
  };
  process.env.CODEX_TOOL_CALL_ID = 'foreign';
  process.env.ANTIGRAVITY_AGENT = '1';
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'foreign-conv';
  process.env.GEMINI_CLI = '1';
  try {
    const runner: Runner = async (_args, env) => {
      assert.equal(env.CODEX_TOOL_CALL_ID, undefined);
      assert.equal(env.ANTIGRAVITY_AGENT, undefined);
      assert.equal(env.ANTIGRAVITY_CONVERSATION_ID, undefined);
      assert.equal(env.GEMINI_CLI, undefined);
      assert.equal(env.HCOM_DIR, 'C:\\isolated');
      return { code: 0, stderr: '', stdout: 'Relay: not configured\n' };
    };
    await new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner).initialize();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('워커 시작과 재개에 절대 경로 설정 인자를 전달한다', async () => {
  const calls: string[][] = [];
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === 'list' && args[1] === '--json') return { code: 0, stderr: '', stdout: '[]' };
    if (args[0] === 'list' && args[1] === '--stopped') return { code: 0, stderr: '', stdout: JSON.stringify({ name: 'worker', tool: 'agy', session_id: 'conversation', directory: 'C:\\project' }) };
    if (args[0] === 'agy' || args[0] === 'r') return { code: 0, stderr: '', stdout: JSON.stringify({ launched: 1, failed: 0, names: ['worker'], batch_id: 'batch' }) };
    return { code: 0, stderr: '', stdout: 'Relay: not configured\n' };
  };
  const adapter = new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner);
  await adapter.initialize();
  await assert.rejects(adapter.launchWorker('relative.json'), /절대 경로/);
  await adapter.launchWorker('C:\\isolated\\agy-settings.json');
  const binding = { ...worker, evidence: 'hcom-managed-binding' as const, hooksBound: true as const, processBound: true as const, directory: 'C:\\project' };
  await adapter.resumeWorker(binding, 'C:\\isolated\\agy-settings.json');
  assert.deepEqual(calls[1], ['agy', '--headless', '--json', '--go', '--', '--settings', 'C:\\isolated\\agy-settings.json']);
  assert.deepEqual(calls[4], ['r', 'worker', '--headless', '--json', '--go', '--', '--settings', 'C:\\isolated\\agy-settings.json']);
});

test('바인딩 전 시작이 막힌 워커도 원래 실행 기록으로 정리할 수 있다', async () => {
  const calls: string[][] = [];
  let running = false;
  let readiness = 'blocked';
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === 'agy') {
      running = true;
      return { code: 2, stderr: '', stdout: JSON.stringify({ launched: 1, failed: 0, names: ['worker'], batch_id: 'batch', readiness: { status: readiness } }) };
    }
    if (args[0] === 'list') return { code: 0, stderr: '', stdout: JSON.stringify(running ? [{ name: 'worker', base_name: 'worker', tool: 'agy', directory: 'C:\\project', process_bound: true, hooks_bound: false }] : []) };
    if (args[0] === 'kill') running = false;
    return { code: 0, stderr: '', stdout: 'Relay: not configured\n' };
  };
  const adapter = new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner);
  await adapter.initialize();
  const launch = await adapter.launchWorker();
  assert.equal(launch.readiness, 'needs_attention');
  await assert.rejects(adapter.stopLaunch({ ...launch }), /시작한 워커/);
  await adapter.stopLaunch(launch);
  assert.deepEqual(calls.filter(args => args[0] === 'kill'), [['kill', 'worker']]);
  readiness = 'timeout';
  const pending = await adapter.launchWorker();
  assert.equal(pending.readiness, 'starting');
  await adapter.stopLaunch(pending);
});

test('시작 배너 잔상이 입력칸에 겹친 경우에만 ESC와 재그리기를 전송한다', async () => {
  const calls: string[][] = [];
  let state: 'banner' | 'residual' | 'hcom' | 'draft' = 'banner';
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === 'term' && args[1] === 'worker') {
      const payload = state === 'banner'
        ? { ready: true, prompt_empty: false, input_text: '──────', lines: ['esc to dismiss', '>──────'] }
        : state === 'residual'
          ? { ready: true, prompt_empty: false, input_text: 'for shortcuts', lines: ['> for shortcuts'] }
          : state === 'hcom'
            ? { ready: true, prompt_empty: false, input_text: '<hcom>[request #1]', lines: ['esc to dismiss', '><hcom>[request #1]'] }
            : { ready: true, prompt_empty: false, input_text: 'user draft', lines: ['esc to dismiss', '> user draft'] };
      return { code: 0, stderr: '', stdout: JSON.stringify(payload) };
    }
    return { code: 0, stderr: '', stdout: 'Relay: not configured\n' };
  };
  const adapter = new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner);
  await adapter.initialize();
  assert.equal(await adapter.clearBannerOverlay('worker'), true);
  state = 'residual';
  assert.equal(await adapter.clearBannerOverlay('worker'), true);
  state = 'hcom';
  assert.equal(await adapter.clearBannerOverlay('worker'), false);
  state = 'draft';
  assert.equal(await adapter.clearBannerOverlay('worker'), false);
  assert.deepEqual(calls.filter(args => args[1] === 'inject').map(args => args[3]), ['\x1b', ' \x08', ' \x08']);
});

test('settleWorker는 초기 터미널 미준비 상태를 기다린 뒤 배너를 해제하고 안정화한다', async () => {
  let step = 0;
  const runner: Runner = async args => {
    if (args[0] === 'term' && args[1] === 'worker') {
      step++;
      if (step === 1) return { code: 1, stderr: "Error: 'worker' is headless, so it has no terminal screen", stdout: '' };
      if (step === 2) return { code: 0, stderr: '', stdout: JSON.stringify({ ready: true, prompt_empty: false, input_text: 'for shortcuts', lines: ['(Google AI Pro)', 'esc to dismiss', '> for shortcuts'] }) };
      return { code: 0, stderr: '', stdout: JSON.stringify({ ready: true, prompt_empty: true, input_text: '', lines: ['(Google AI Pro)', '>'] }) };
    }
    return { code: 0, stderr: '', stdout: 'Relay: not configured\n' };
  };
  const adapter = new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner);
  await adapter.initialize();
  assert.equal(await adapter.settleWorker('worker', 10_000), true);
  assert.ok(step >= 5);
  assert.equal(await adapter.settleWorker('worker', 0), false);
});

test('settleWorker는 Ink 프레임에서 Ctrl+L 재정렬 후 입력 에코를 검증한다', async () => {
  const calls: string[][] = [];
  let inputText = '';
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === 'term' && args[1] === 'inject' && args[2] === 'worker') {
      if (args[3] === 'x') inputText = 'x';
      if (args[3] === '\x15') inputText = '';
      return { code: 0, stderr: '', stdout: '' };
    }
    if (args[0] === 'term' && args[1] === 'worker') {
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          ready: inputText === '',
          prompt_empty: inputText === '',
          input_text: inputText,
          lines: ['(Google AI Pro)', '────────', `>${inputText ? ` ${inputText}` : ''}`, '────────', '? for shortcuts'],
        }),
      };
    }
    return { code: 0, stderr: '', stdout: 'Relay: not configured\n' };
  };
  const adapter = new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner);
  await adapter.initialize();
  assert.equal(await adapter.settleWorker('worker', 10_000), true);
  const injected = calls.filter(args => args[0] === 'term' && args[1] === 'inject').map(args => args[3]);
  assert.deepEqual(injected, ['\x0c', 'x', '\x15']);
});

test('isJammedTerminal과 clearJammedInput은 미제출 hcom 입력만 Ctrl+U/Ctrl+L로 정리한다', async () => {
  assert.equal(isJammedTerminal({ ready: false, promptEmpty: false, inputText: '<hcom>[request #6] beta -> milo</hcom>', lines: ['>', '? for shortcuts'] }, 6), true);
  assert.equal(isJammedTerminal({ ready: false, promptEmpty: null, inputText: null, lines: ['───', '> <hcom>[request #6]', 'milo</hcom>', '───'] }, 6), true);
  assert.equal(isJammedTerminal({ ready: true, promptEmpty: true, inputText: '', lines: ['  <hcom>[request #6] laza -> bira</hcom>', '────', '? for shortcuts'] }, 6), false);
  assert.equal(isJammedTerminal({ ready: false, promptEmpty: false, inputText: '<hcom>[request #6]', lines: ['>'] }, 8), false);
  assert.equal(isJammedTerminal({ ready: false, promptEmpty: false, inputText: '<hcom>[request #6]', lines: ['● Running', 'esc to cancel'] }, 6), false);
  assert.equal(isJammedTerminal({ ready: false, promptEmpty: false, inputText: 'draft', lines: ['> <hcom>[request #6]', '> draft'] }, 6), false);

  const calls: string[][] = [];
  let jammed: 'input' | 'frame' | 'resumed' | 'idle' = 'input';
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === 'term' && args[1] === 'worker') {
      return {
        code: 0,
        stderr: '',
        stdout: jammed === 'input'
          ? JSON.stringify({ ready: false, prompt_empty: false, input_text: '<hcom>[request #6]</hcom>', lines: ['<hcom>[request #6]</hcom>'] })
          : jammed === 'frame'
            ? JSON.stringify({ ready: true, prompt_empty: true, input_text: '', lines: ['<hcom>[request #6] a -> b</hcom><hcom>[request #6] a -> b</hcom>', '────', '>', '────', '? for shortcuts'] })
            : jammed === 'resumed'
              ? JSON.stringify({ ready: true, prompt_empty: false, input_text: '<hcom>[request #1]', cursor: [2, 31], lines: ['> <hcom>[request #1]', '● Ran 2 commands', '  <hcom>[request #6] a -> b</hcom>', '────'] })
              : JSON.stringify({ ready: true, prompt_empty: true, input_text: '', lines: ['> <hcom>[request #1]', '>', 'esc to cancel'] }),
      };
    }
    return { code: 0, stderr: '', stdout: 'Relay: not configured\n' };
  };
  const adapter = new HcomAdapter({ projectId: 'a', cwd: 'C:\\project', hcomDir: 'C:\\isolated' }, runner);
  await adapter.initialize();
  assert.equal(await adapter.clearJammedInput('worker', 6), true);
  assert.deepEqual(calls[2], ['term', 'inject', 'worker', '\x15\x0c']);
  jammed = 'frame';
  assert.equal(await adapter.clearJammedInput('worker', 6), true);
  assert.deepEqual(calls[4], ['term', 'inject', 'worker', '\x0c']);
  jammed = 'resumed';
  assert.equal(await adapter.clearJammedInput('worker', 6), true);
  assert.deepEqual(calls[6], ['term', 'inject', 'worker', '\x0c']);
  jammed = 'idle';
  assert.equal(await adapter.clearJammedInput('worker', 6), false);
  assert.equal(calls.length, 8);
});

test('정확한 회신만 결과로 인정하고 ACK와 다른 이벤트를 거부한다', () => {
  const event: HcomEvent = { projectId: 'a', id: 8, type: 'message', data: { from: 'worker', sender_kind: 'instance', scope: 'mentions', delivered_to: ['codex'], reply_to: '7', intent: 'inform', text: '완료' } };
  assert.equal(isWorkerReply(event, 'a', codex, worker, 7), true);
  assert.equal(isWorkerReply({ ...event, data: { ...event.data, intent: 'ack' } }, 'a', codex, worker, 7), false);
  assert.equal(isWorkerReply(event, 'b', codex, worker, 7), false);
  assert.equal(isWorkerReply(event, 'a', codex, worker, 6), false);
  assert.equal(isWorkerReply({ ...event, data: { ...event.data, from: 'other' } }, 'a', codex, worker, 7), false);
});
