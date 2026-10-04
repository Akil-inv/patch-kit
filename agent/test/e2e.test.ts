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

const sh = (c: string, cwd: string) => execSync(c, { cwd, stdio: 'pipe' }).toString();

/** Make an upgrade with fix, then merge it into main the way GitHub does. */
async function upgradeAndMerge(d: string, how: 'merge' | 'squash') {
  expect(await main(['fix', '--root', d, '--no-images', '-q'])).toBe(0);
  const b = sh('git branch --list "patchkit/*"', d).trim().replace('* ', '');
  if (how === 'merge') sh(`git -c user.name=t -c user.email=t@t merge --no-ff -m "Merge pull request #7 from Akil-inv/${b}" ${b}`, d);
  else sh(`git merge --squash ${b} && git -c user.name=t -c user.email=t@t commit -qm "patch-kit: 1 safe upgrade (demo) (#7)" -m "$(git log -1 --format=%B ${b} | tail -1)"`, d);
  sh(`git branch -D ${b}`, d);
  expect(lockVersion(d, 'main')).not.toBe('1.2.5');
}

e2e('patchkit rollback (npm registry)', () => {
  for (const how of ['merge', 'squash'] as const) {
    it(`reverts the last upgrade (${how}) on a branch, tested, main untouched`, async () => {
      const d = product('node -e "require(\'minimist\')"');
      await upgradeAndMerge(d, how);
      writeFileSync(join(d, 'later.txt'), 'unrelated work after the upgrade');
      sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm "later work"', d);
      const mainBefore = sh('git rev-parse main', d).trim();
      expect(await main(['rollback', '--root', d, '-q'])).toBe(0);
      expect(branch(d)).toBe('main');
      expect(sh('git rev-parse main', d).trim()).toBe(mainBefore);
      const rb = sh('git branch --list "patchkit/rollback-*"', d).trim();
      expect(rb).toMatch(/patchkit\/rollback-[0-9a-f]{7}/);
      expect(lockVersion(d, rb)).toBe('1.2.5');
      expect(sh(`git show ${rb}:later.txt`, d)).toMatch(/unrelated/);            // later work kept
      expect(readFileSync(join(d, '.patchkit/rollback.md'), 'utf8')).toMatch(/✅ passed/);
    }, 240_000);
  }

  it('says so when there is nothing to roll back, and does not roll back twice', async () => {
    const d = product('true');
    expect(await main(['rollback', '--root', d, '-q'])).toBe(0);
    await upgradeAndMerge(d, 'merge');
    expect(await main(['rollback', '--root', d, '-q'])).toBe(0);
    const rb = sh('git branch --list "patchkit/rollback-*"', d).trim();
    sh(`git -c user.name=t -c user.email=t@t merge --no-ff -m "Merge rollback" ${rb}`, d);
    const before = sh('git branch --list "patchkit/*"', d);
    expect(await main(['rollback', '--root', d, '-q'])).toBe(0);
    expect(sh('git branch --list "patchkit/*"', d)).toBe(before);              // nothing new
  }, 240_000);

  it('refuses on a schedule', async () => {
    const d = product('true');
    process.env.GITHUB_EVENT_NAME = 'schedule';
    try { await expect(main(['rollback', '--root', d, '-q'])).rejects.toThrow(/only when a person asks/); }
    finally { delete process.env.GITHUB_EVENT_NAME; }
  }, 60_000);
});

function compareGte(a: string, b: string) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}
