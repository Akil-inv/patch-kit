import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { backTo, dirtyFiles, discardChanges, gitInfo, pullRequest, push } from './git';
import { Manifest, TestRun } from './types';
import { compare, runAll } from './tests';
import { run } from './util';

/**
 * Undo the last patch-kit upgrade in the code: a revert on its own branch,
 * tested like an upgrade, offered as a pull request. A person asks for it and
 * a person merges it. (Putting back the running release on a server is the
 * deploy's job; this makes the code match, so the next deploy doesn't bring
 * the upgrade back.)
 */

export const UPGRADE_TRAILER = 'Patch-Kit-Upgrade';

export type Upgrade = { sha: string; subject: string; date: string; merge: boolean };

const git = (root: string, ...args: string[]) => run('git', args, { cwd: root, timeoutMs: 120_000 });

/** The newest upgrade on this branch that hasn't been reverted already. */
export async function findLastUpgrade(root: string): Promise<Upgrade | null> {
  const r = await git(root, 'log', '--first-parent', '-n', '500', '--format=%H%x1f%P%x1f%s%x1f%cI%x1f%B%x1e');
  if (r.code !== 0) return null;
  const commits = r.stdout.split('\x1e').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [sha, parents, subject, date, body] = x.split('\x1f');
    return { sha, merge: parents.trim().split(' ').length > 1, subject, date, body: body ?? '' };
  });
  // Reverts can sit off the main line (a rollback PR merged with a merge commit), so look at all history.
  const all = await git(root, 'log', '-n', '2000', '--format=%B');
  const reverted = new Set<string>();
  for (const m of all.stdout.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) reverted.add(m[1]);
  const isReverted = (sha: string) => [...reverted].some((r) => sha.startsWith(r));
  for (const c of commits) {
    if (/^Revert /.test(c.subject)) continue;
    const isUpgrade =
      c.subject.startsWith('patch-kit:') ||                                   // squash merge or direct
      new RegExp(`^${UPGRADE_TRAILER}:`, 'm').test(c.body) ||                 // squash keeps the trailer
      /^Merge pull request #\d+ from \S+\/patchkit\/\d{4}-\d{2}-\d{2}/.test(c.subject) ||
      /^Merge branch 'patchkit\/\d{4}-\d{2}-\d{2}'/.test(c.subject);
    if (isUpgrade && !isReverted(c.sha)) return { sha: c.sha, subject: c.subject, date: c.date, merge: c.merge };
  }
  return null;
}

export type RollbackResult = {
  upgrade: Upgrade | null;
  branch?: { name: string; pushed: boolean; pullRequest?: string };
  tests: TestRun[];
  code: number;
  message: string;
};

export async function rollback(root: string, m: Manifest, opts: { push: boolean; pr: boolean; allowDirty: boolean; out: string; log: (s: string) => void }): Promise<RollbackResult> {
  const { log } = opts;
  const info = await gitInfo(root);
  if (!info) throw new Error('rollback needs a git repository');
  const dirty = await dirtyFiles(root);
  if (dirty.length && !opts.allowDirty) throw new Error(`uncommitted changes (${dirty.slice(0, 5).join(', ')}). Commit them, or pass --allow-dirty.`);

  const up = await findLastUpgrade(root);
  if (!up) return { upgrade: null, tests: [], code: 0, message: `no patch-kit upgrade on ${info.branch} that isn't already reverted` };
  log(`Last upgrade: ${up.sha.slice(0, 7)} ${up.subject} (${up.date.slice(0, 10)})`);

  log(`Running ${m.tests?.length ?? 0} test(s) as things are`);
  const before = await runAll(root, m.tests);

  const name = `patchkit/rollback-${up.sha.slice(0, 7)}`;
  const b = await git(root, 'checkout', '-B', name);
  if (b.code !== 0) throw new Error(`could not create branch ${name}: ${b.stderr.trim()}`);
  const rv = await git(root, '-c', 'user.name=patch-kit', '-c', 'user.email=patch-kit@users.noreply.github.com',
    'revert', '--no-edit', ...(up.merge ? ['-m', '1'] : []), up.sha);
  if (rv.code !== 0) {
    await git(root, 'revert', '--abort');
    await backTo(root, info.branch);
    await git(root, 'branch', '-D', name);
    throw new Error(`the upgrade can't be reverted cleanly (later changes touch the same files): ${(rv.stderr + rv.stdout).trim().split('\n').filter(Boolean).pop() ?? ''}. Revert it by hand.`.replace(': . ', '. '));
  }

  // Install what the reverted lockfiles say, so the tests run against it.
  const changed = (await git(root, 'diff', '--name-only', 'HEAD~1', 'HEAD')).stdout.split('\n').filter(Boolean);
  for (const c of m.components) {
    const dir = join(root, c.path);
    const prefix = c.path === '.' ? '' : `${c.path}/`;
    if (c.ecosystem === 'npm' && changed.includes(`${prefix}package-lock.json`)) {
      log(`Installing ${c.path} as it was`);
      await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, timeoutMs: 900_000 });
      // npm ci empties node_modules, which drops a generated Prisma client.
      if (existsSync(join(dir, 'prisma', 'schema.prisma'))) await run('npx', ['prisma', 'generate'], { cwd: dir, timeoutMs: 300_000 });
    }
    if (c.ecosystem === 'pip' && changed.includes(`${prefix}requirements.txt`) && process.env.PATCHKIT_PIP_INSTALL !== '0') {
      await run('python3', ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'], { cwd: dir, timeoutMs: 900_000 });
    }
  }

  log('Running the tests on the rolled-back code');
  const after = await runAll(root, m.tests);
  const tests = compare(m.tests, before, after);

  if (tests.some((t) => t.verdict === 'regression')) {
    await discardChanges(root);
    await backTo(root, info.branch);
    await git(root, 'branch', '-D', name);
    write(opts.out, up, tests, info.branch, undefined);
    return { upgrade: up, tests, code: 1, message: 'undoing the upgrade breaks a test that passes now, so nothing was committed; see the report' };
  }
  if (!opts.allowDirty) await discardChanges(root);

  const result: RollbackResult = { upgrade: up, tests, code: 0, message: '', branch: { name, pushed: false } };
  try {
    if (opts.push) { await push(root, name); result.branch!.pushed = true; }
    const body = write(opts.out, up, tests, info.branch, name);
    if (opts.pr) {
      result.branch!.pullRequest = await pullRequest(root, name, info.branch, `patch-kit: roll back ${up.subject.replace(/^patch-kit:\s*/, '')}`.slice(0, 120), body);
      log(`Pull request: ${result.branch!.pullRequest}`);
    }
  } catch (e) {
    log(`⚠️ ${(e as Error).message}`);
    result.code = 3;
  } finally {
    await backTo(root, info.branch);
  }
  result.message = `revert of ${up.sha.slice(0, 7)} is on ${name}${result.branch!.pullRequest ? ` (${result.branch!.pullRequest})` : ''}`;
  return result;
}

function write(out: string, up: Upgrade, tests: TestRun[], base: string, branch?: string): string {
  const V: Record<string, string> = { passed: '✅ passed', 'already-failing': '⚠️ was already failing', regression: '⛔ broken by the rollback', skipped: '— not run' };
  const md = [
    `# patch-kit: roll back an upgrade`,
    '',
    `This reverts **${up.subject}** (\`${up.sha.slice(0, 7)}\`, ${up.date.slice(0, 10)}) on \`${base}\`, putting the packages back to the versions before it.`,
    '',
    branch ? `Merging this and deploying makes the code match what a server rollback put back, so the next deploy doesn't bring the upgrade back.` : `**Not committed:** undoing the upgrade breaks a test that passes now.`,
    '',
    '## Tests',
    '',
    tests.length ? ['| Test | Now | After the rollback | Verdict |', '|---|---|---|---|', ...tests.map((t) => `| ${t.name} | ${t.before} | ${t.after} | ${V[t.verdict]} |`)].join('\n') : 'No tests are listed in patchkit.yml.',
    ...tests.filter((t) => t.outputTail && t.verdict !== 'passed').flatMap((t) => ['', `<details><summary>${t.name}: last lines</summary>`, '', '```', t.outputTail!, '```', '</details>']),
    '',
    'The packages this puts back may include the advisories the upgrade fixed. The next scan lists them again, so plan a fixed upgrade.',
  ].join('\n');
  mkdirSync(out, { recursive: true });
  const file = join(out, 'rollback.md');
  writeFileSync(file, md);
  return file;
}

export const hasRollbackReport = (out: string) => existsSync(join(out, 'rollback.md'));
