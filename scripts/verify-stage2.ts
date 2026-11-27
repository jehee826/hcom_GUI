import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ProjectManager } from '../src/runtime/index.ts';

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 인자가 필요합니다.`);
  return value;
}

function optionalArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 값이 비어 있습니다.`);
  return value;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

const branchTask = '읽기 전용 PowerShell 명령 Get-Content -LiteralPath .git/HEAD 로 파일을 읽고 ref: refs/heads/ 뒤의 브랜치 이름만 확인하세요. Git 명령은 실행하지 마세요. hcom send에서 --intent inform --reply-to <원본 요청 event_id>를 사용해 브랜치 이름만 회신하세요. ACK는 결과가 아닙니다.';

async function main(): Promise<void> {
  const baseDir = arg('--base');
  const codexCommand = arg('--codex');
  const model = optionalArg('--model');
  if (!isAbsolute(baseDir) || !isAbsolute(codexCommand)) {
    throw new Error('--base와 --codex는 절대 경로여야 합니다.');
  }

  const runRoot = await mkdtemp(join(baseDir, 'stage2-verify-'));
  const dataDir = join(runRoot, 'app-data');
  const repoA = join(runRoot, 'repo-a');
  const repoAWt = join(runRoot, 'repo-a-wt');
  const repoB = join(runRoot, 'repo-b');

  // A: 1개 커밋 + 연결된 worktree(stage2-a-wt), B: 커밋 없는 빈 저장소(stage2-b)
  git(runRoot, 'init', '-b', 'stage2-a', repoA);
  git(repoA, 'config', 'user.email', 'stage2@example.com');
  git(repoA, 'config', 'user.name', 'Stage2 Verify');
  await writeFile(join(repoA, 'README.md'), 'stage2-a\n', 'utf8');
  git(repoA, 'add', 'README.md');
  git(repoA, 'commit', '-m', 'init stage2-a');
  git(repoA, 'worktree', 'add', '-b', 'stage2-a-wt', repoAWt);

  git(runRoot, 'init', '-b', 'stage2-b', repoB);

  const workerSettings = {
    agentMode: '',
    toolPermission: 'always-proceed',
    trustedWorkspaces: [repoA, repoAWt, repoB],
  };

  const makeManager = () => new ProjectManager({
    dataDir,
    codexCommand,
    model,
    env: process.env,
    workerSettings,
  });

  let activeManager: ProjectManager | undefined = makeManager();
  try {
    // 1. 등록 및 worktree 중복 등록 차단
    const regA = activeManager.registerProject(repoA, { name: 'Stage2-A' });
    const regB = activeManager.registerProject(repoB, { name: 'Stage2-B' });
    let duplicateBlocked = false;
    try {
      activeManager.registerProject(repoAWt);
    } catch {
      duplicateBlocked = true;
    }
    assert.equal(duplicateBlocked, true, 'worktree 중복 등록이 거절돼야 합니다.');
    assert.equal(regB.handoff.commitStatus, '커밋 없음');
    assert.equal(regB.handoff.testResult, '미실행');

    // 2. A·B 동시 시작 + A 중복 시작 직렬화
    const [startedA1, startedA2, startedB] = await Promise.all([
      activeManager.startProject(regA.project.projectId),
      activeManager.startProject(regA.project.projectId),
      activeManager.startProject(regB.project.projectId),
    ]);
    assert.equal(startedA1.codex.threadId, startedA2.codex.threadId);
    assert.ok(startedA1.codex.threadId && startedB.codex.threadId);
    assert.notEqual(startedA1.codex.threadId, startedB.codex.threadId);
    assert.notEqual(startedA1.project.hcomDir, startedB.project.hcomDir);

    const workerA1 = startedA1.workers[0]!;
    const workerB1 = startedB.workers[0]!;
    assert.equal((await activeManager.listProjectHcomParticipants(regA.project.projectId)).length, 2);
    assert.equal((await activeManager.listProjectHcomParticipants(regB.project.projectId)).length, 2);

    // 3. 양방향 교차 전송 및 교차 worktree 전환 거절
    await assert.rejects(activeManager.sendTaskToWorker(regA.project.projectId, workerB1.workerId, branchTask), /다른 프로젝트/);
    await assert.rejects(activeManager.sendTaskToWorker(regB.project.projectId, workerA1.workerId, branchTask), /다른 프로젝트/);
    await assert.rejects(activeManager.switchWorktree(regA.project.projectId, 'codex', repoB), /다른 Git 저장소/);
    await assert.rejects(activeManager.switchWorktree(regA.project.projectId, { workerId: workerA1.workerId }, repoB), /다른 Git 저장소/);

    // 4. A 추가 워커 생성 및 동일 requestKey 중복 방지
    const [workerA2First, workerA2Dup] = await Promise.all([
      activeManager.addWorker(regA.project.projectId, { name: '추가 워커', requestKey: 'stage2-add-w2' }),
      activeManager.addWorker(regA.project.projectId, { name: '추가 워커', requestKey: 'stage2-add-w2' }),
    ]);
    assert.equal(workerA2First.workerId, workerA2Dup.workerId);
    assert.equal((await activeManager.listProjectHcomParticipants(regA.project.projectId)).length, 3);
    assert.equal((await activeManager.listProjectHcomParticipants(regB.project.projectId)).length, 2);

    // 5. A 기본 워커 바인딩 확보 + A 추가 워커와 B 기본 워커에 동시 Codex 위임 왕복
    const a1Check = await activeManager.sendTaskToWorker(regA.project.projectId, workerA1.workerId, branchTask);
    assert.equal(String(a1Check.reply.data.text).trim(), 'stage2-a');

    const promptA = `먼저 list_workers 도구를 호출해 현재 프로젝트 워커를 확인한 뒤, workerId가 "${workerA2First.workerId}" 인 워커에게만 delegate_work 도구로 다음 지시를 위임하세요: "${branchTask}". 위임 후에는 전달 사실만 짧게 답하고, 이후 도구 출력으로 워커 회신이 전달되면 다른 설명이나 서식 없이 브랜치 이름만 그대로 답하세요.`;
    const promptB = `먼저 list_workers 도구를 호출해 현재 프로젝트 워커를 확인한 뒤, workerId가 "${workerB1.workerId}" 인 워커에게만 delegate_work 도구로 다음 지시를 위임하세요: "${branchTask}". 위임 후에는 전달 사실만 짧게 답하고, 이후 도구 출력으로 워커 회신이 전달되면 다른 설명이나 서식 없이 브랜치 이름만 그대로 답하세요.`;

    const [reqA, reqB] = await Promise.all([
      activeManager.submitRequest(regA.project.projectId, 'stage2-req-a', promptA),
      activeManager.submitRequest(regB.project.projectId, 'stage2-req-b', promptB),
    ]);
    assert.equal(reqA.status, 'completed', `A 요청 실패: ${JSON.stringify(reqA)}`);
    assert.equal(reqB.status, 'completed', `B 요청 실패: ${JSON.stringify(reqB)}`);
    assert.equal(reqA.finalText?.trim(), 'stage2-a');
    assert.equal(reqB.finalText?.trim(), 'stage2-b');

    const afterDelegationA = activeManager.getProjectSnapshot(regA.project.projectId);
    const afterDelegationB = activeManager.getProjectSnapshot(regB.project.projectId);
    const convA1 = afterDelegationA.workers.find(w => w.workerId === workerA1.workerId)!.conversationId;
    const convA2 = afterDelegationA.workers.find(w => w.workerId === workerA2First.workerId)!.conversationId;
    const convB1 = afterDelegationB.workers.find(w => w.workerId === workerB1.workerId)!.conversationId;
    assert.ok(convA1 && convA2 && convB1);
    assert.equal(new Set([convA1, convA2, convB1]).size, 3, '세 워커의 conversationId는 모두 달라야 합니다.');
    await assert.rejects(activeManager.bindWorkerConversation(regA.project.projectId, workerA1.workerId, convB1), /재사용할 수 없습니다/);

    // 6. A 추가 워커 개별 중지 후 동일 ID 재개 + 재회신
    await activeManager.stopWorker(regA.project.projectId, workerA2First.workerId);
    assert.equal((await activeManager.listProjectHcomParticipants(regA.project.projectId)).length, 2);
    const resumedA2 = await activeManager.startWorker(regA.project.projectId, workerA2First.workerId);
    assert.equal(resumedA2.conversationId, convA2);
    const a2ResumedReply = await activeManager.sendTaskToWorker(regA.project.projectId, workerA2First.workerId, branchTask);
    assert.equal(String(a2ResumedReply.reply.data.text).trim(), 'stage2-a');
    assert.equal(a2ResumedReply.binding.sessionId, convA2);

    // 7. 백엔드 재시작(detachAll -> 새 ProjectManager) 후 살아 있는 워커 대조·재연결 및 Codex 스레드 재개
    await activeManager.detachAll();
    activeManager = makeManager();
    const reconciledA = await activeManager.reconcileProject(regA.project.projectId);
    assert.equal(
      reconciledA.workers.every(w => w.status === 'ready' || w.status === 'working'),
      true,
      `재연결 워커 상태 확인 필요: ${JSON.stringify(reconciledA.workers)}`,
    );
    assert.equal(reconciledA.workers.find(w => w.workerId === workerA1.workerId)?.conversationId, convA1);
    assert.equal(reconciledA.workers.find(w => w.workerId === workerA2First.workerId)?.conversationId, convA2);
    const restartedA = await activeManager.startProject(regA.project.projectId);
    assert.equal(restartedA.codex.threadId, startedA1.codex.threadId);
    assert.equal((await activeManager.listProjectHcomParticipants(regA.project.projectId)).length, 3);

    // 8. 기존 worktree(repo-a-wt) 전환 검증 (Codex + agy 실측)
    const codexSwitched = await activeManager.switchWorktree(regA.project.projectId, 'codex', repoAWt);
    assert.equal(codexSwitched.codex.threadId, startedA1.codex.threadId);
    assert.equal(codexSwitched.project.hcomDir, regA.project.hcomDir);
    assert.equal(codexSwitched.handoff.branchStatus, 'stage2-a-wt');
    const wtCodexReq = await activeManager.submitRequest(
      regA.project.projectId,
      'stage2-wt-codex',
      '읽기 전용 PowerShell 명령 Get-Content -LiteralPath .git 를 읽어 gitdir 경로를 확인하고, 그 경로의 HEAD 파일에서 ref: refs/heads/ 뒤 브랜치 이름만 답해. 다른 설명이나 서식은 붙이지 마.',
    );
    assert.equal(wtCodexReq.status, 'completed');
    assert.equal(wtCodexReq.finalText?.trim(), 'stage2-a-wt');

    let workerWorktreeSwitchResult: { supported: boolean; conversationId: string | null; preservedCwd: string; status: string; error?: string };
    try {
      const switchedW = await activeManager.switchWorktree(regA.project.projectId, { workerId: workerA1.workerId }, repoAWt);
      const moved = switchedW.workers.find(w => w.workerId === workerA1.workerId)!;
      workerWorktreeSwitchResult = {
        supported: true,
        conversationId: moved.conversationId,
        preservedCwd: moved.cwd,
        status: moved.status,
      };
    } catch (error) {
      const current = activeManager.getProjectSnapshot(regA.project.projectId).workers.find(w => w.workerId === workerA1.workerId)!;
      assert.equal(current.cwd.toLowerCase(), repoA.toLowerCase(), 'worktree 전환 실패 시 기존 경로가 유지돼야 합니다.');
      assert.equal(current.status, 'needs_attention');
      workerWorktreeSwitchResult = {
        supported: false,
        conversationId: current.conversationId,
        preservedCwd: current.cwd,
        status: current.status,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // 동일 프로젝트 A 소속으로 worktree(repo-a-wt)에 직접 워커 추가 시 같은 projectId/HCOM_DIR 유지 확인
    const wtWorker = await activeManager.addWorker(regA.project.projectId, {
      name: 'worktree 워커',
      requestKey: 'stage2-add-wt-worker',
      cwd: repoAWt,
    });
    const wtWorkerReply = await activeManager.sendTaskToWorker(
      regA.project.projectId,
      wtWorker.workerId,
      '읽기 전용 PowerShell 명령으로 Get-Content -LiteralPath .git 의 gitdir 경로를 확인하고, 그 안의 HEAD 파일에서 ref: refs/heads/ 뒤 브랜치 이름만 hcom send --intent inform --reply-to <원본 요청 event_id> 로 회신하세요. Git 명령은 실행하지 마세요.',
    );
    assert.equal(String(wtWorkerReply.reply.data.text).trim(), 'stage2-a-wt');
    assert.equal(wtWorkerReply.binding.directory.toLowerCase(), repoAWt.toLowerCase());
    assert.equal(new Set([convA1, convA2, convB1, wtWorkerReply.binding.sessionId]).size, 4);

    // 9. 인계 기록 및 정리 확인
    const handoffA = activeManager.getHandoff(regA.project.projectId);
    const handoffB = activeManager.getHandoff(regB.project.projectId);
    assert.equal(handoffA.lastCodexReview?.trim(), 'stage2-a');
    assert.equal(handoffB.lastCodexReview?.trim(), 'stage2-b');
    assert.equal(handoffB.commitStatus, '커밋 없음');
    assert.equal(handoffB.testResult, '미실행');

    await activeManager.shutdownAll();
    const verifier = makeManager();
    try {
      const activeA = await verifier.listProjectHcomParticipants(regA.project.projectId);
      const activeB = await verifier.listProjectHcomParticipants(regB.project.projectId);
      assert.equal(activeA.length, 0, `A 종료 후 잔여 참가자: ${JSON.stringify(activeA)}`);
      assert.equal(activeB.length, 0, `B 종료 후 잔여 참가자: ${JSON.stringify(activeB)}`);
    } finally {
      await verifier.detachAll();
    }
    activeManager = undefined;

    console.log(JSON.stringify({
      runRoot,
      projectA: {
        projectId: regA.project.projectId,
        hcomDir: regA.project.hcomDir,
        threadId: startedA1.codex.threadId,
        defaultWorkerId: workerA1.workerId,
        defaultConversationId: convA1,
        additionalWorkerId: workerA2First.workerId,
        additionalConversationId: convA2,
        delegatedFinalText: reqA.finalText?.trim(),
        worktreeCodexFinalText: wtCodexReq.finalText?.trim(),
        workerWorktreeSwitchResult,
        worktreeAddedWorker: {
          workerId: wtWorker.workerId,
          conversationId: wtWorkerReply.binding.sessionId,
          cwd: wtWorkerReply.binding.directory,
          reply: String(wtWorkerReply.reply.data.text).trim(),
        },
      },
      projectB: {
        projectId: regB.project.projectId,
        hcomDir: regB.project.hcomDir,
        threadId: startedB.codex.threadId,
        defaultWorkerId: workerB1.workerId,
        defaultConversationId: convB1,
        delegatedFinalText: reqB.finalText?.trim(),
        handoffCommitStatus: handoffB.commitStatus,
        handoffTestResult: handoffB.testResult,
      },
    }, null, 2));
  } finally {
    if (activeManager) {
      await activeManager.shutdownAll().catch(error => console.error('cleanup error:', error));
    }
    if (process.argv.includes('--cleanup')) {
      await rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
