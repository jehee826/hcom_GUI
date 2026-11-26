import { execFileSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { CodexSession, type TurnResult } from '../src/codex/index.ts';
import { verifyHcom } from './verify-hcom.ts';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 인자가 필요합니다.`);
  return value;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function scratchState(repo: string): string {
  if (resolve(git(repo, 'rev-parse', '--show-toplevel')) !== resolve(repo)) throw new Error('저장소 루트 경로가 필요합니다.');
  if (git(repo, 'remote').length || git(repo, 'status', '--porcelain', '--untracked-files=all').length) throw new Error('빈 임시 저장소만 사용할 수 있습니다.');
  try {
    git(repo, 'rev-parse', '--verify', '--quiet', 'HEAD');
    throw new Error('커밋 없는 임시 저장소만 사용할 수 있습니다.');
  } catch (error) {
    if (!(error instanceof Error) || !('status' in error) || error.status !== 1) throw error;
  }
  return git(repo, 'symbolic-ref', '--short', 'HEAD');
}

function check(result: TurnResult, threadId: string, branch: string): void {
  if (result.threadId !== threadId || result.status !== 'completed' || result.finalText?.trim() !== branch) {
    throw new Error(`왕복 검증 실패: ${JSON.stringify(result)}`);
  }
}

async function main(): Promise<void> {
  const repo = argument('--repo');
  const command = argument('--codex');
  if (!isAbsolute(repo) || !isAbsolute(command)) throw new Error('저장소와 Codex 실행 파일은 절대 경로여야 합니다.');
  const branch = scratchState(repo);
  const modelIndex = process.argv.indexOf('--model');
  const model = modelIndex < 0 ? undefined : argument('--model');
  const options = { command, cwd: repo, env: { ...process.env }, model };
  if (process.argv.includes('--hcom')) {
    const result = await verifyHcom(repo, command, model, branch);
    if (scratchState(repo) !== branch) throw new Error('검증 중 저장소 상태가 변경됐습니다.');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (process.argv.includes('--list-models')) {
    const session = await CodexSession.connect(options);
    try { console.log(JSON.stringify(await session.listModels(), null, 2)); }
    finally { await session.close(); }
    return;
  }
  const first = await CodexSession.connect(options);
  let threadId: string;
  let firstTurn: TurnResult;
  try {
    threadId = await first.startThread();
    firstTurn = await first.runTurn({ text: '읽기 전용 PowerShell 명령 Get-Content -LiteralPath .git/HEAD 로 파일을 읽고, ref: refs/heads/ 뒤의 브랜치 이름만 답해. Git 명령은 실행하지 말고 다른 설명이나 서식도 붙이지 마.' });
    check(firstTurn, threadId, branch);
  } finally { await first.close(); }
  const second = await CodexSession.connect(options);
  try {
    await second.resumeThread(threadId);
    const secondTurn = await second.runTurn({ text: '읽기 전용 PowerShell 명령 Get-Content -LiteralPath .git/HEAD 로 파일을 읽고, ref: refs/heads/ 뒤의 브랜치 이름만 답해. Git 명령은 실행하지 말고 다른 설명이나 서식도 붙이지 마.' });
    check(secondTurn, threadId, branch);
    if (firstTurn.turnId === secondTurn.turnId) throw new Error('재개 전후 턴 ID가 같습니다.');
    if (scratchState(repo) !== branch) throw new Error('검증 중 저장소 상태가 변경됐습니다.');
    console.log(JSON.stringify({ threadId, branch, firstTurn, secondTurn }, null, 2));
  } finally { await second.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
