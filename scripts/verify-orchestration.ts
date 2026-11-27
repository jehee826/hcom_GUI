import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultCodexCandidates, resolveExecutable } from '../src/server/diagnostics.ts';
import { ProjectManager } from '../src/runtime/index.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

async function main(): Promise<void> {
  const codexCommand = resolveExecutable(process.env.HCOM_GUI_CODEX_PATH, 'codex', defaultCodexCandidates());
  assert.ok(codexCommand, 'codex.exe를 찾을 수 없습니다.');
  const model = process.env.HCOM_GUI_MODEL ?? 'gpt-6.1-sol';

  const baseTmp = resolve(process.cwd(), '..', 'tmp', 'hcom-gui-orchestration-verify');
  mkdirSync(baseTmp, { recursive: true });
  const runDir = mkdtempSync(join(baseTmp, 'orch-'));
  const dataDir = join(runDir, 'data');

  // Project A: Git 저장소 (재지시 + 직접 답변 + ask_user 재접속 이어가기)
  const repoA = join(runDir, 'repo-a');
  mkdirSync(repoA, { recursive: true });
  git(repoA, ['init', '-b', 'orch-a']);
  git(repoA, ['config', 'user.email', 'verify@hcom-gui.local']);
  git(repoA, ['config', 'user.name', 'hcom-gui-verify']);
  writeFileSync(join(repoA, 'FILE_ONE.txt'), 'PART_ONE_777\n', 'utf8');
  writeFileSync(join(repoA, 'FILE_TWO.txt'), 'PART_TWO_888\n', 'utf8');
  git(repoA, ['add', 'FILE_ONE.txt', 'FILE_TWO.txt']);
  git(repoA, ['commit', '-m', 'init orch-a']);

  // Project B: Git 없는 일반 폴더 (일반 폴더 등록 + 동시 격리 + 워커 직접 메시지)
  const plainB = join(runDir, 'plain-b');
  mkdirSync(plainB, { recursive: true });
  writeFileSync(join(plainB, 'PLAIN_TOKEN.txt'), 'PLAIN_FOLDER_999\n', 'utf8');

  const workerSettings = {
    agentMode: '',
    toolPermission: 'always-proceed',
  };

  const makeManager = () => new ProjectManager({
    dataDir,
    codexCommand,
    model,
    codexSandbox: 'danger-full-access',
    env: process.env,
    workerSettings,
  });

  console.log('[verify-orchestration] runDir:', runDir);
  let activeManager: ProjectManager | undefined = makeManager();

  try {
    const snapA = activeManager.registerProject(repoA, { name: 'Orch-A' });
    const snapB = activeManager.registerProject(plainB, { name: 'Plain-B' });
    assert.equal(snapA.handoff.branchStatus, 'orch-a');
    assert.equal(snapB.handoff.branchStatus, 'Git 없음');
    assert.equal(snapB.handoff.commitStatus, 'Git 없음');

    const projA = snapA.project.projectId;
    const projB = snapB.project.projectId;
    console.log('[verify-orchestration] starting A (Git) & B (Plain folder) in parallel...');
    await Promise.all([
      activeManager.startProject(projA),
      activeManager.startProject(projB),
    ]);

    const eventsA: Array<{ kind: string; projectId: string; payload: Record<string, unknown> }> = [];
    const eventsB: Array<{ kind: string; projectId: string; payload: Record<string, unknown> }> = [];
    activeManager.subscribeEvents(ev => {
      if (ev.projectId === projA) eventsA.push(ev);
      if (ev.projectId === projB) eventsB.push(ev);
    });

    // 1. A: 직접 답변 (위임 없음)
    console.log('[verify-orchestration] 1. testing direct answer...');
    const directReq = await activeManager.submitRequest(
      projA,
      'live-direct-1',
      '워커에게 위임하거나 도구를 호출하지 말고, 직접 답변으로 DIRECT_OK_42 만 출력하세요.',
    );
    assert.equal(directReq.status, 'completed', `직접 답변 실패: ${directReq.error}`);
    assert.equal(directReq.round, 0);
    assert.match(directReq.finalText ?? '', /DIRECT_OK_42/);
    assert.equal(activeManager.listDelegations(projA, 'live-direct-1').length, 0);
    console.log('[verify-orchestration] 1. direct answer OK:', directReq.finalText?.trim());

    // 2. A(2라운드 재지시 루프) + B(일반 폴더 워커 직접 메시지) 동시 실행으로 격리 및 재지시 동시 검증
    console.log('[verify-orchestration] 2. testing parallel A (2-round re-delegation) + B (plain-folder direct worker)...');
    const redelegatePrompt = [
      '먼저 list_workers로 현재 프로젝트의 기본 워커 ID를 확인하세요.',
      '1차 delegate_work 호출에서는 워커에게 FILE_ONE.txt 내용만 확인해 회신하도록 지시하세요(1차에서는 FILE_TWO.txt를 묻지 마세요).',
      '1차 회신을 받으면 FILE_TWO.txt가 아직 누락되어 있으므로, 최종 답변을 내지 말고 반드시 같은 요청에서 2차 delegate_work를 호출해 워커에게 FILE_TWO.txt 내용을 확인해 회신하도록 보완 재지시하세요.',
      '2차 회신까지 모두 받으면 최종 답변에 PART_ONE_777 과 PART_TWO_888 두 값을 모두 포함해 한 번만 답하세요.',
    ].join(' ');

    const workerBId = snapB.workers[0]!.workerId;
    const [redelegateReq, directWorkerB] = await Promise.all([
      activeManager.submitRequest(projA, 'live-redelegate-1', redelegatePrompt),
      activeManager.sendDirectWorkerMessage(
        projB,
        workerBId,
        'live-plain-direct-1',
        '현재 폴더의 PLAIN_TOKEN.txt 파일 내용을 읽고 그대로 회신해줘. 파일은 수정하지 마.',
      ),
    ]);

    assert.equal(redelegateReq.status, 'completed', `재지시 요청 실패: ${redelegateReq.error}`);
    assert.ok(redelegateReq.round >= 2, `2차 재지시 라운드 미달: round=${redelegateReq.round}`);
    const redelegateDels = activeManager.listDelegations(projA, 'live-redelegate-1');
    assert.ok(redelegateDels.length >= 2, `위임 기록이 2건 미만입니다: ${redelegateDels.length}`);
    assert.match(redelegateReq.finalText ?? '', /PART_ONE_777/);
    assert.match(redelegateReq.finalText ?? '', /PART_TWO_888/);
    assert.doesNotMatch(redelegateReq.finalText ?? '', /PLAIN_FOLDER_999/);
    const finishedCount = eventsA.filter(e => e.kind === 'request.finished' && e.payload.requestId === 'live-redelegate-1').length;
    assert.equal(finishedCount, 1, '재지시 요청의 최종 완료 이벤트는 1회만 발행돼야 합니다');

    assert.equal(directWorkerB.request.mode, 'direct_worker');
    assert.equal(directWorkerB.request.status, 'completed', `일반 폴더 직접 메시지 실패: ${directWorkerB.request.error}`);
    assert.match(directWorkerB.request.finalText ?? '', /PLAIN_FOLDER_999/);
    assert.doesNotMatch(directWorkerB.request.finalText ?? '', /PART_ONE_777|PART_TWO_888/);
    console.log('[verify-orchestration] 2. re-delegation & plain-folder direct worker OK:', {
      aRounds: redelegateReq.round,
      aDelegations: redelegateDels.length,
      bDirectReply: directWorkerB.request.finalText?.slice(0, 80),
    });

    // 3. A: ask_user -> waiting_user -> 백엔드 재접속(detachAll -> 재오픈) -> replyToRequest 같은 요청 이어가기
    console.log('[verify-orchestration] 3. testing ask_user -> waiting_user -> reconnect -> reply continuation...');
    const askReq = await activeManager.submitRequest(
      projA,
      'live-ask-1',
      '반드시 ask_user 도구를 호출해 사용자에게 ALPHA_CHOICE와 BETA_CHOICE 중 어느 것을 선택할지 options와 함께 질문하세요. 아직 최종 답변을 완료하지 마세요.',
    );
    assert.equal(askReq.status, 'waiting_user', `waiting_user 진입 실패: ${JSON.stringify(askReq)}`);
    assert.ok(askReq.pendingQuestion && askReq.pendingQuestion.length > 0);
    console.log('[verify-orchestration] 3a. waiting_user OK:', askReq.pendingQuestion);

    // 백엔드 분리 후 재오픈 (재접속 복원 검증)
    await activeManager.detachAll();
    activeManager = makeManager();
    await activeManager.reconcileProject(projA);
    const restoredAsk = activeManager.getRequest(projA, 'live-ask-1');
    assert.equal(restoredAsk?.status, 'waiting_user');

    const continued = await activeManager.replyToRequest(projA, 'live-ask-1', 'rk-live-1', 'BETA_CHOICE를 선택합니다. 이제 BETA_CHOICE를 포함해 최종 완료해 주세요.');
    assert.equal(continued.deduplicated, false);
    assert.equal(continued.request.status, 'completed', `사용자 답변 이어가기 실패: ${continued.request.error}`);
    assert.match(continued.request.finalText ?? '', /BETA_CHOICE/);

    const dupReply = await activeManager.replyToRequest(projA, 'live-ask-1', 'rk-live-1', 'BETA_CHOICE');
    assert.equal(dupReply.deduplicated, true);
    console.log('[verify-orchestration] 3b. reply continuation & dedup OK:', continued.request.finalText?.slice(0, 100));

    const summary = {
      ok: true,
      runDir,
      directOk: true,
      redelegateRounds: redelegateReq.round,
      redelegateDelegations: redelegateDels.length,
      plainFolderDirectOk: true,
      askUserReconnectContinueOk: true,
    };
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log('[verify-orchestration] ALL PASSED:', JSON.stringify(summary, null, 2));
  } finally {
    if (activeManager) {
      await activeManager.shutdownAll().catch(err => console.error('shutdown warning:', err));
    }
  }
}

void main().catch(err => {
  console.error('[verify-orchestration] FAILED:', err);
  process.exit(1);
});
