import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateInstallerPath } from '../electron/updater.ts';

test('validateInstallerPath는 유효한 .exe 파일만 허용하고 비유효 경로를 거부한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcom-gui-updater-'));
  try {
    const validExe = join(dir, 'hcom_gui-1.0.1-x64-setup.exe');
    const txtFile = join(dir, 'readme.txt');
    writeFileSync(validExe, 'MZ');
    writeFileSync(txtFile, 'hello');

    assert.equal(validateInstallerPath(validExe), validExe);
    assert.throws(() => validateInstallerPath(''), /비어 있습니다/);
    assert.throws(() => validateInstallerPath(txtFile), /\.exe/);
    assert.throws(() => validateInstallerPath(join(dir, 'missing.exe')), /찾을 수 없습니다/);
    assert.throws(() => validateInstallerPath(validExe, validExe), /현재 실행 중인 앱/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
