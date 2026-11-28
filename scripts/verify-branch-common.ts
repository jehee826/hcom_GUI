export const BRANCH_CHECK_TASK =
  '읽기 전용 PowerShell 명령 Get-Content -LiteralPath .git/HEAD 로 파일을 읽고 ref: refs/heads/ 뒤의 브랜치 이름만 확인하세요. Git 명령은 실행하지 마세요. hcom send에서 --intent inform --reply-to <원본 요청 event_id>를 사용해 브랜치 이름만 회신하세요. ACK는 결과가 아닙니다.';

export function buildWorkerBranchDelegationPrompt(workerId: string): string {
  return `먼저 list_workers 도구를 호출해 현재 프로젝트 워커를 확인한 뒤, workerId가 "${workerId}" 인 워커에게만 delegate_work 도구로 다음 지시를 위임하세요: "${BRANCH_CHECK_TASK}". 위임 후에는 전달 사실만 짧게 답하고, 이후 도구 출력으로 워커 회신이 전달되면 다른 설명이나 서식 없이 브랜치 이름만 그대로 답하세요.`;
}

export function assertExpectedBranchReply(actual: string | null | undefined, expectedBranch: string, contextLabel = '브랜치 회신'): string {
  const trimmed = (actual ?? '').trim();
  if (trimmed !== expectedBranch) {
    throw new Error(`${contextLabel} 불일치: expected=${expectedBranch}, actual=${trimmed}`);
  }
  return trimmed;
}
