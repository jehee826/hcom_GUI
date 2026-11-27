import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CodexSession } from '../src/codex/index.ts';

const server = String.raw`
const readline = require('node:readline');
let turn = 0;
let turnInput;
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{}});
  if (m.method === 'model/list') return send({id:m.id,result:{
    hcomDir:process.env.HCOM_DIR, hcomName:process.env.HCOM_NAME,
    threadId:process.env.CODEX_THREAD_ID, sessionId:process.env.CODEX_SESSION_ID,
    codexHome:process.env.CODEX_HOME,
  }});
  if (m.method === 'thread/start' || m.method === 'thread/resume') return send({id:m.id,result:{thread:{id:m.params.threadId || 'thread-1'}}});
  if (m.method === 'thread/turns/list') {
    if (m.params.threadId !== 'thread-1' || m.params.itemsView !== 'full') throw Error('invalid history request');
    return send({id:m.id,result:{data:[
      {id:'other',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'다른 턴'}]},
      {id:'turn-' + turn,status:'completed',items:[{type:'agentMessage',phase:turnInput === 'history final' ? 'final_answer' : undefined,text:'저장된 결과'}]},
    ]}});
  }
  if (m.method !== 'turn/start') return;
  if (m.params.sandboxPolicy.type !== 'readOnly' || m.params.approvalPolicy !== 'never') throw Error('unsafe');
  if (m.params.toolOutput && (m.params.input.length || m.params.toolOutput.name !== 'worker')) throw Error('invalid output');
  const id = 'turn-' + ++turn;
  turnInput = m.params.input[0]?.text;
  const event = (method, params) => send({method,params:{threadId:'thread-1',turnId:id,...params}});
  event('item/completed',{item:{type:'agentMessage',phase:'commentary',text:'중간'}});
  event('item/completed',{item:{type:'agentMessage',phase:'final_answer',text:'다른 턴'},turnId:'other'});
  event('item/completed',{item:{type:'agentMessage',phase: ['no phase', 'history final'].includes(turnInput) ? undefined : 'final_answer',text:'결과'}});
  event('item/completed',{item:{type:'agentMessage',phase:'final_answer',text:'다른 프로젝트'},threadId:'thread-2'});
  send({method:'turn/completed',params:{threadId:'thread-1',turn:{id,status:m.params.input[0]?.text === 'fail' ? 'failed' : 'completed',error:null}}});
  send({id:m.id,result:{turn:{id}}});
});`;

async function connect() {
  return CodexSession.connect({ command: process.execPath, args: ['-e', server], cwd: process.cwd(), env: process.env });
}

test('App Server마다 명시한 HCOM_DIR만 전달한다', async () => {
  const env = {
    ...process.env, hcom_dir: resolve('foreign'), HCOM_DIR: resolve('inherited'), HCOM_NAME: 'foreign',
    CODEX_THREAD_ID: 'foreign-thread', CODEX_SESSION_ID: 'foreign-session', CODEX_HOME: resolve('codex-home'),
  };
  const sessions: CodexSession[] = [];
  try {
    for (const hcomDir of [resolve('hcom-a'), resolve('hcom-b'), undefined]) {
      const session = await CodexSession.connect({ command: process.execPath, args: ['-e', server], cwd: process.cwd(), env, hcomDir });
      sessions.push(session);
      assert.deepEqual(await session.listModels(), { ...(hcomDir ? { hcomDir } : {}), codexHome: env.CODEX_HOME });
    }
    assert.equal(env.HCOM_DIR, resolve('inherited'));
  } finally {
    await Promise.all(sessions.map(session => session.close()));
  }
});

test('턴 ID와 최종 phase를 대조하고 응답 전 알림을 보존한다', async () => {
  const session = await connect();
  try {
    assert.equal(await session.startThread(), 'thread-1');
    assert.deepEqual(await session.runTurn({ text: 'branch' }), { threadId: 'thread-1', turnId: 'turn-1', status: 'completed', finalText: '결과' });
    assert.equal((await session.runTurn({ text: 'no phase' })).status, 'needs_final_answer');
    assert.equal((await session.runTurn({ text: 'fail' })).status, 'failed');
    assert.equal((await session.runTurn({ toolOutput: { name: 'worker', output: 'branch' } })).status, 'completed');
  } finally { await session.close(); }
});

test('저장한 스레드를 정확히 재개한다', async () => {
  const session = await connect();
  try { assert.equal(await session.resumeThread('thread-1'), 'thread-1'); }
  finally { await session.close(); }
});

test('스레드 시작이 진행 중이면 같은 연결에서 두 번째 시작이나 재개를 거절한다', async () => {
  const session = await connect();
  try {
    const first = session.startThread();
    await Promise.all([
      assert.rejects(session.startThread(), /이미 스레드/),
      assert.rejects(session.resumeThread('thread-2'), /이미 스레드/),
    ]);
    assert.equal(await first, 'thread-1');
  } finally { await session.close(); }
});

test('최종 phase가 빠진 경우 해당 턴의 저장된 최종 본문만 복원한다', async () => {
  const session = await connect();
  try {
    await session.startThread();
    assert.deepEqual(await session.runTurn({ text: 'history final' }), { threadId: 'thread-1', turnId: 'turn-1', status: 'completed', finalText: '저장된 결과' });
    assert.equal((await session.runTurn({ text: 'no phase' })).status, 'needs_final_answer');
  } finally { await session.close(); }
});

test('턴 ID가 확인되기 전 도구 요청도 해당 턴과 대조한다', async () => {
  const dynamicServer = String.raw`
  const readline=require('node:readline');
  const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);
    if(m.method==='initialize') return send({id:m.id,result:{}});
    if(m.method==='thread/start') return send({id:m.id,result:{thread:{id:'thread-1'}}});
    if(m.method==='turn/start') {
      send({id:'call',method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',tool:'delegate',callId:'call-1',arguments:{}}});
      return send({id:m.id,result:{turn:{id:'turn-1'}}});
    }
    if(m.id==='call') {
      if(!m.result?.success) throw Error('tool failed');
      send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',phase:'final_answer',text:'완료'}}});
      send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
    }
  });`;
  let calls = 0;
  const session = await CodexSession.connect({ command: process.execPath, args: ['-e', dynamicServer], cwd: process.cwd(), env: process.env, onToolCall: async () => { calls++; return { success: true, contentItems: [{ type: 'inputText', text: 'ok' }] }; } });
  try {
    await session.startThread();
    assert.equal((await session.runTurn({ text: '위임' })).status, 'completed');
    assert.equal(calls, 1);
  } finally { await session.close(); }
});

test('sandbox 옵션에 따라 스레드와 턴에 해당 sandbox 정책을 전달한다', async () => {
  const sandboxServer = String.raw`
  const readline = require('node:readline');
  const seen = [];
  const send = x => process.stdout.write(JSON.stringify(x) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') return send({ id: m.id, result: {} });
    if (m.method === 'thread/start' || m.method === 'thread/resume') {
      seen.push({ method: m.method, sandbox: m.params.sandbox });
      return send({ id: m.id, result: { thread: { id: 'thread-sb' } } });
    }
    if (m.method === 'turn/start') {
      seen.push({ method: m.method, policy: m.params.sandboxPolicy?.type });
      send({ method: 'item/completed', params: { threadId: 'thread-sb', turnId: 't-1', item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(seen) } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-sb', turn: { id: 't-1', status: 'completed', error: null } } });
      return send({ id: m.id, result: { turn: { id: 't-1' } } });
    }
  });`;

  for (const [mode, expectedPolicy] of [['workspace-write', 'workspaceWrite'], ['danger-full-access', 'dangerFullAccess']] as const) {
    const session = await CodexSession.connect({
      command: process.execPath,
      args: ['-e', sandboxServer],
      cwd: process.cwd(),
      env: process.env,
      sandbox: mode,
    });
    try {
      await session.startThread();
      const res = await session.runTurn({ text: 'check' });
      assert.equal(res.status, 'completed');
      assert.deepEqual(JSON.parse(res.finalText ?? '[]'), [
        { method: 'thread/start', sandbox: mode },
        { method: 'turn/start', policy: expectedPolicy },
      ]);
    } finally {
      await session.close();
    }
  }
});
