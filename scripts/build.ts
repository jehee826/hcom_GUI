import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBuildAssets } from './generate-assets.ts';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = resolve(ROOT_DIR, 'dist');
const TSC_BIN = resolve(ROOT_DIR, 'node_modules', 'typescript', 'bin', 'tsc');

function runTsc(projectFile: string): void {
  execFileSync(process.execPath, [TSC_BIN, '-p', projectFile], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
}

function main(): void {
  const requiredAssets = [
    resolve(ROOT_DIR, 'build', 'icon.png'),
    resolve(ROOT_DIR, 'build', 'icon.ico'),
    resolve(ROOT_DIR, 'build', 'installer-header.bmp'),
    resolve(ROOT_DIR, 'build', 'installer-sidebar.bmp'),
  ];
  if (requiredAssets.some(file => !existsSync(file))) {
    generateBuildAssets();
  }

  rmSync(DIST_DIR, { recursive: true, force: true });
  runTsc('tsconfig.build.json');
  runTsc('tsconfig.web.json');

  mkdirSync(resolve(DIST_DIR, 'web'), { recursive: true });
  copyFileSync(resolve(ROOT_DIR, 'src', 'web', 'index.html'), resolve(DIST_DIR, 'web', 'index.html'));
  copyFileSync(resolve(ROOT_DIR, 'src', 'web', 'styles.css'), resolve(DIST_DIR, 'web', 'styles.css'));

  mkdirSync(resolve(DIST_DIR, 'electron'), { recursive: true });
  copyFileSync(resolve(ROOT_DIR, 'electron', 'preload.cjs'), resolve(DIST_DIR, 'electron', 'preload.cjs'));

  mkdirSync(resolve(DIST_DIR, 'assets'), { recursive: true });
  copyFileSync(resolve(ROOT_DIR, 'build', 'icon.png'), resolve(DIST_DIR, 'assets', 'icon.png'));

  console.log('[build] dist/ 컴파일 및 정적 에셋 복사 완료');
}

main();
