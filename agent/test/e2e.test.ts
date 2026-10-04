import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli';

/**
 * A real product: one npm component with minimist 1.2.5 (an advisory, fixed in
 * 1.2.6, inside the ^1.2.5 range). Needs the npm registry, so it is skipped
 * unless PATCHKIT_E2E=1.
 */
const e2e = process.env.PATCHKIT_E2E === '1' ? describe : describe.skip;

function product(testCommand: string): string {
  const d = mkdtempSync(join(tmpdir(), 'pk-e2e-'));
  const sh = (c: string, cwd = d) => execSync(c, { cwd, stdio: 'pipe' }).toString();
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', private: true }));
  sh('npm install minimist@1.2.5 --no-audit --no-fund --silent');
  writeFileSync(join(d, '.gitignore'), 'node_modules\n.patchkit\n');
  writeFileSync(join(d, 'patchkit.yml'), `product: demo\ncomponents: [.]\ntests:\n  - name: unit\n    run: ${JSON.stringify(testCommand)}\n`);
  sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init');
  return d;
}

const branch = (d: string) => execSync('git rev-parse --abbrev-ref HEAD', { cwd: d }).toString().trim();
const lockVersion = (d: string, ref: string) =>
  JSON.parse(execSync(`git show ${ref}:package-lock.json`, { cwd: d }).toString()).packages['node_modules/minimist'].version;

e2e('patchkit fix (npm registry)', () => {
  it('upgrades on a branch, keeps main untouched, and reports', async () => {
    const d = product('node -e "require(\'minimist\')"');
    expect(await main(['fix', '--root', d, '--no-images', '-q'])).toBe(0);
    expect(branch(d)).toBe('main');
    expect(lockVersion(d, 'main')).toBe('1.2.5');
    const b = execSync('git branch --list "patchkit/*"', { cwd: d }).toString().trim().replace('* ', '');
    expect(compareGte(lockVersion(d, b), '1.2.6')).toBe(true);
    const r = JSON.parse(readFileSync(join(d, '.patchkit/report.json'), 'utf8'));
    expect(r.changes[0]).toMatchObject({ package: 'minimist', from: '1.2.5' });
    expect(r.tests[0].verdict).toBe('passed');
    expect(execSync('git status --porcelain', { cwd: d }).toString().trim()).toBe('');
  }, 240_000);

  it('commits nothing when the upgrade breaks a test', async () => {
    const d = product(`node -e "process.exit(require('minimist/package.json').version === '1.2.5' ? 0 : 1)"`);
    expect(await main(['fix', '--root', d, '--no-images', '-q'])).toBe(1);
    expect(branch(d)).toBe('main');
    expect(execSync('git branch --list "patchkit/*"', { cwd: d }).toString().trim()).toBe('');
    const r = JSON.parse(readFileSync(join(d, '.patchkit/report.json'), 'utf8'));
    expect(r.tests[0].verdict).toBe('regression');
    expect(readFileSync(join(d, '.patchkit/report.md'), 'utf8')).toMatch(/broke 1 test/);
  }, 240_000);

  it('refuses to run on uncommitted work', async () => {
    const d = product('true');
    writeFileSync(join(d, 'package.json'), '{"name":"demo","dependencies":{"minimist":"^1.2.5"}}');
    await expect(main(['fix', '--root', d, '--no-images', '-q'])).rejects.toThrow(/uncommitted changes/);
    expect(existsSync(join(d, '.patchkit'))).toBe(false);
  }, 240_000);
});

function compareGte(a: string, b: string) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}
