import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readGitSnapshot, resolveGitProject, validateRelativeDocPath } from '../src/projects/git.ts';
import { ProjectStore } from '../src/store/index.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

test('Git 공용 디렉터리로 worktree 중복 등록을 막고 일반 폴더 및 커밋·브랜치 상태를 정확히 읽는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hcom-gui-git-test-'));
  try {
    const emptyRepo = join(root, 'empty-a');
    const committedRepo = join(root, 'repo-b');
    const worktreeB = join(root, 'repo-b-wt');

    git(root, 'init', '-b', 'branch-a', emptyRepo);
    const infoA = resolveGitProject(emptyRepo);
    const snapA = readGitSnapshot(emptyRepo);
    assert.equal(snapA.branchStatus, 'branch-a');
    assert.equal(snapA.commitStatus, '커밋 없음');

    git(root, 'init', '-b', 'main', committedRepo);
    git(committedRepo, 'config', 'user.email', 'test@example.com');
    git(committedRepo, 'config', 'user.name', 'Test User');
    writeFileSync(join(committedRepo, 'README.md'), 'hello\n', 'utf8');
    git(committedRepo, 'add', 'README.md');
    git(committedRepo, 'commit', '-m', 'init repo b');
    git(committedRepo, 'worktree', 'add', '-b', 'feat-wt', worktreeB);

    const infoB = resolveGitProject(committedRepo);
    const infoWt = resolveGitProject(worktreeB);
    assert.equal(infoB.gitCommonDirKey, infoWt.gitCommonDirKey);
    assert.notEqual(infoB.rootKey, infoWt.rootKey);
    assert.notEqual(infoA.gitCommonDirKey, infoB.gitCommonDirKey);

    const snapWt = readGitSnapshot(worktreeB);
    assert.equal(snapWt.branchStatus, 'feat-wt');
    assert.match(snapWt.commitStatus, /init repo b/);

    const dbPath = join(root, 'data', 'state.sqlite');
    const store = new ProjectStore(dbPath);
    try {
      const regA = store.registerProject({
        name: 'A',
        rootPath: infoA.rootPath,
        gitCommonDir: infoA.gitCommonDir,
        gitCommonDirKey: infoA.gitCommonDirKey,
        hcomDir: ProjectStore.projectHcomDir(join(root, 'data'), 'proj-a'),
        branchStatus: snapA.branchStatus,
        commitStatus: snapA.commitStatus,
        projectId: 'proj-a',
      });
      assert.equal(regA.handoff.commitStatus, '커밋 없음');
      assert.equal(regA.handoff.testResult, '미실행');
      assert.equal(regA.handoff.goal, '미설정');

      const regB = store.registerProject({
        name: 'B',
        rootPath: infoB.rootPath,
        gitCommonDir: infoB.gitCommonDir,
        gitCommonDirKey: infoB.gitCommonDirKey,
        hcomDir: ProjectStore.projectHcomDir(join(root, 'data'), 'proj-b'),
        branchStatus: 'main',
        commitStatus: 'abc init repo b',
        projectId: 'proj-b',
      });
      // 같은 Git 공용 디렉터리의 worktree 중복 등록 거절
      assert.throws(() => store.registerProject({
        name: 'B-wt',
        rootPath: infoWt.rootPath,
        gitCommonDir: infoWt.gitCommonDir,
        gitCommonDirKey: infoWt.gitCommonDirKey,
        hcomDir: ProjectStore.projectHcomDir(join(root, 'data'), 'proj-b-wt'),
        branchStatus: snapWt.branchStatus,
        commitStatus: snapWt.commitStatus,
      }), /이미 같은 프로젝트 폴더/);

      // Git 없는 일반 폴더 등록 및 이후 git init 시 중복 등록 차단 확인
      const plainDir = join(root, 'plain-folder');
      writeFileSync(join(root, 'marker'), 'x', 'utf8');
      git(root, 'version');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(plainDir, { recursive: true });
      const infoPlain = resolveGitProject(plainDir);
      assert.equal(infoPlain.isGitRepo, false);
      assert.ok(infoPlain.gitCommonDirKey.startsWith('dir:'));
      const snapPlain = readGitSnapshot(plainDir);
      assert.equal(snapPlain.branchStatus, 'Git 없음');
      assert.equal(snapPlain.commitStatus, 'Git 없음');

      store.registerProject({
        name: 'Plain',
        rootPath: infoPlain.rootPath,
        gitCommonDir: infoPlain.gitCommonDir,
        gitCommonDirKey: infoPlain.gitCommonDirKey,
        hcomDir: ProjectStore.projectHcomDir(join(root, 'data'), 'proj-plain'),
        branchStatus: snapPlain.branchStatus,
        commitStatus: snapPlain.commitStatus,
        projectId: 'proj-plain',
      });
      git(root, 'init', '-b', 'main', plainDir);
      const infoAfterGitInit = resolveGitProject(plainDir);
      assert.equal(infoAfterGitInit.isGitRepo, true);
      assert.throws(() => store.registerProject({
        name: 'Plain-dup',
        rootPath: infoAfterGitInit.rootPath,
        gitCommonDir: infoAfterGitInit.gitCommonDir,
        gitCommonDirKey: infoAfterGitInit.gitCommonDirKey,
        hcomDir: ProjectStore.projectHcomDir(join(root, 'data'), 'proj-plain-2'),
        branchStatus: 'main',
        commitStatus: '커밋 없음',
      }), /이미 같은 프로젝트 폴더/);

      store.selectProject(regB.project.projectId);
      store.updateHandoff(regA.project.projectId, {
        goal: 'A 목표',
        designDocs: [validateRelativeDocPath(infoA.rootPath, 'docs/design/architecture.md')],
        testCommand: 'npm test',
        testResult: '통과',
        nextSteps: '2단계 진행',
      });

      assert.throws(() => validateRelativeDocPath(infoA.rootPath, '../outside.md'), /프로젝트 밖/);
      assert.throws(() => validateRelativeDocPath(infoA.rootPath, 'C:\\outside.md'), /상대 경로/);
    } finally {
      store.close();
    }

    // SQLite 재오픈 후 선택 상태 및 인계 격리 확인
    const reopened = new ProjectStore(dbPath);
    try {
      assert.equal(reopened.getSelectedProjectId(), 'proj-b');
      assert.equal(reopened.listProjects().length, 3);
      const handoffA = reopened.getHandoff('proj-a')!;
      const handoffB = reopened.getHandoff('proj-b')!;
      assert.equal(handoffA.goal, 'A 목표');
      assert.deepEqual(handoffA.designDocs, ['docs/design/architecture.md']);
      assert.equal(handoffA.testResult, '통과');
      assert.equal(handoffB.goal, '미설정');
      assert.equal(handoffB.testResult, '미실행');
      assert.deepEqual(handoffB.designDocs, []);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
