import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

export interface LaunchInstallerResult {
  readonly installerPath: string;
  readonly pid: number | undefined;
}

export function validateInstallerPath(
  filePath: string,
  currentExePath?: string,
): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error('설치 파일(.exe) 경로가 비어 있습니다.');
  }
  const resolvedPath = resolve(trimmed);
  if (extname(resolvedPath).toLowerCase() !== '.exe') {
    throw new Error('Windows 설치 파일(.exe)만 업데이트 실행에 사용할 수 있습니다.');
  }
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw new Error(`설치 파일을 찾을 수 없습니다: ${resolvedPath}`);
  }
  if (currentExePath && resolve(currentExePath).toLowerCase() === resolvedPath.toLowerCase()) {
    throw new Error('현재 실행 중인 앱 실행 파일 자체는 설치 파일로 선택할 수 없습니다.');
  }
  return resolvedPath;
}

export function launchInstallerExe(
  filePath: string,
  options?: { currentExePath?: string; args?: readonly string[] },
): LaunchInstallerResult {
  const installerPath = validateInstallerPath(filePath, options?.currentExePath);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(installerPath, [...(options?.args ?? [])], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env,
  });
  child.unref();
  return { installerPath, pid: child.pid };
}
