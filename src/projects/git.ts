import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, normalize, relative, resolve, win32 } from 'node:path';

export interface GitRepoInfo {
  readonly rootPath: string;
  readonly rootKey: string;
  readonly gitCommonDir: string;
  readonly gitCommonDirKey: string;
  readonly defaultName: string;
  readonly isGitRepo?: boolean;
}

export interface GitSnapshot {
  readonly branchStatus: string;
  readonly commitStatus: string;
}

export interface GitInspector {
  resolveProject(folderPath: string): GitRepoInfo;
  readSnapshot(cwd: string): GitSnapshot;
}

export function isAbsolutePath(value: string): boolean {
  return Boolean(value) && (isAbsolute(value) || win32.isAbsolute(value));
}

export function canonicalizePath(value: string): string {
  if (!isAbsolutePath(value)) throw new Error('절대 경로가 필요합니다.');
  const resolved = resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return win32.normalize(resolved);
  }
}

export function normalizePathKey(value: string): string {
  return win32.normalize(canonicalizePath(value)).replace(/[\\/]+$/, '').toLowerCase();
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

export function resolveGitProject(folderPath: string): GitRepoInfo {
  if (!isAbsolutePath(folderPath)) throw new Error('프로젝트 경로는 절대 경로여야 합니다.');
  const realFolder = canonicalizePath(folderPath);
  let stats;
  try {
    stats = statSync(realFolder);
  } catch {
    throw new Error(`프로젝트 폴더를 찾을 수 없습니다: ${folderPath}`);
  }
  if (!stats.isDirectory()) throw new Error(`폴더 경로가 아닙니다: ${folderPath}`);

  let toplevelRaw: string | null = null;
  let commonDirRaw: string | null = null;
  try {
    toplevelRaw = runGit(realFolder, ['rev-parse', '--path-format=absolute', '--show-toplevel']);
    commonDirRaw = runGit(realFolder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch {
    toplevelRaw = null;
    commonDirRaw = null;
  }

  if (toplevelRaw && commonDirRaw) {
    const rootPath = canonicalizePath(toplevelRaw);
    const gitCommonDir = canonicalizePath(commonDirRaw);
    return {
      rootPath,
      rootKey: normalizePathKey(rootPath),
      gitCommonDir,
      gitCommonDirKey: normalizePathKey(gitCommonDir),
      defaultName: basename(rootPath) || rootPath,
      isGitRepo: true,
    };
  }

  // Git 저장소가 아닌 일반 폴더도 프로젝트로 등록한다.
  const rootKey = normalizePathKey(realFolder);
  return {
    rootPath: realFolder,
    rootKey,
    gitCommonDir: realFolder,
    gitCommonDirKey: `dir:${rootKey}`,
    defaultName: basename(realFolder) || realFolder,
    isGitRepo: false,
  };
}

export function readGitSnapshot(cwd: string): GitSnapshot {
  if (!isAbsolutePath(cwd)) return { branchStatus: '확인 필요', commitStatus: '확인 필요' };
  const realCwd = canonicalizePath(cwd);

  try {
    const inside = runGit(realCwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return { branchStatus: 'Git 없음', commitStatus: 'Git 없음' };
  } catch {
    return { branchStatus: 'Git 없음', commitStatus: 'Git 없음' };
  }

  let branchStatus = '확인 필요';
  try {
    const branch = runGit(realCwd, ['symbolic-ref', '--short', 'HEAD']);
    if (branch) branchStatus = branch;
  } catch {
    try {
      const detached = runGit(realCwd, ['rev-parse', '--short', 'HEAD']);
      if (detached) branchStatus = `detached@${detached}`;
    } catch {
      branchStatus = '확인 필요';
    }
  }

  let commitStatus = '커밋 없음';
  try {
    const commit = runGit(realCwd, ['log', '-1', '--format=%h %s']);
    if (commit) commitStatus = commit;
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? (error as { status?: unknown }).status : undefined;
    commitStatus = status === 128 ? '커밋 없음' : '확인 필요';
  }

  return { branchStatus, commitStatus };
}

export function validateRelativeDocPath(projectRoot: string, docPath: string): string {
  const trimmed = docPath.trim();
  if (!trimmed || isAbsolutePath(trimmed)) throw new Error('설계 문서 경로는 프로젝트 상대 경로여야 합니다.');
  const normalized = normalize(trimmed).replace(/\\/g, '/');
  const full = resolve(projectRoot, normalized);
  const rel = relative(resolve(projectRoot), full);
  if (!rel || rel.startsWith('..') || isAbsolutePath(rel)) {
    throw new Error(`프로젝트 밖의 설계 문서 경로는 허용되지 않습니다: ${docPath}`);
  }
  return rel.replace(/\\/g, '/');
}

export const defaultGitInspector: GitInspector = {
  resolveProject: resolveGitProject,
  readSnapshot: readGitSnapshot,
};
