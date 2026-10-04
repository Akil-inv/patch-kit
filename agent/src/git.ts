import { run } from './util';

/**
 * Git and GitHub: the agent works on its own branch and opens a pull request.
 * It never pushes to the branch it started on, so nothing reaches main
 * without a person merging it.
 */

const git = (root: string, ...args: string[]) => run('git', args, { cwd: root, timeoutMs: 120_000 });

export async function gitInfo(root: string): Promise<{ commit: string; branch: string } | undefined> {
  const c = await git(root, 'rev-parse', 'HEAD');
  const b = await git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  return c.code === 0 ? { commit: c.stdout.trim(), branch: b.stdout.trim() } : undefined;
}

/** Changed or untracked files, ignoring the agent's own report folder. */
export async function dirtyFiles(root: string, ignore = '.patchkit/'): Promise<string[]> {
  const r = await git(root, 'status', '--porcelain');
  return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)).filter((f) => !f.startsWith(ignore));
}

export function branchName(today = new Date()): string {
  return `patchkit/${today.toISOString().slice(0, 10)}`;
}

export async function startBranch(root: string, name: string): Promise<void> {
  const exists = (await git(root, 'rev-parse', '--verify', '--quiet', name)).code === 0;
  // A second run on the same day starts the branch again from where we are.
  const r = await git(root, 'checkout', exists ? '-B' : '-b', name);
  if (r.code !== 0) throw new Error(`could not create branch ${name}: ${r.stderr.trim()}`);
}

/** Commit only the given files (manifests and lockfiles), never what the tests left behind. */
export async function commitFiles(root: string, files: string[], message: string): Promise<boolean> {
  if (!files.length) return false;
  await git(root, 'add', '--', ...files);
  const staged = await git(root, 'diff', '--cached', '--quiet');
  if (staged.code === 0) return false;
  const env = { GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'patch-kit', GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'patch-kit@users.noreply.github.com' };
  const hasUser = (await git(root, 'config', 'user.email')).stdout.trim();
  const args = hasUser ? ['commit', '-m', message] : ['-c', `user.name=${env.GIT_AUTHOR_NAME}`, '-c', `user.email=${env.GIT_AUTHOR_EMAIL}`, 'commit', '-m', message];
  const r = await git(root, ...args);
  if (r.code !== 0) throw new Error(`commit failed: ${r.stderr.trim()}`);
  return true;
}

export async function push(root: string, name: string): Promise<void> {
  const r = await git(root, 'push', '--force-with-lease', '-u', 'origin', name);
  if (r.code !== 0) throw new Error(`push failed: ${r.stderr.trim()}`);
}

/** Put back tracked files the tests changed (e.g. tsconfig.tsbuildinfo). */
export async function discardChanges(root: string): Promise<void> {
  await git(root, 'checkout', '--', '.');
}

export async function backTo(root: string, branch: string): Promise<void> {
  await git(root, 'checkout', branch);
}

/** Open (or find) the pull request for the branch. Returns its URL. */
export async function pullRequest(root: string, head: string, base: string, title: string, bodyFile: string): Promise<string> {
  const existing = await run('gh', ['pr', 'view', head, '--json', 'url', '-q', '.url'], { cwd: root, timeoutMs: 60_000 });
  if (existing.code === 0 && existing.stdout.trim()) {
    await run('gh', ['pr', 'edit', head, '--title', title, '--body-file', bodyFile], { cwd: root, timeoutMs: 60_000 });
    return existing.stdout.trim();
  }
  const r = await run('gh', ['pr', 'create', '--head', head, '--base', base, '--title', title, '--body-file', bodyFile], { cwd: root, timeoutMs: 60_000 });
  if (r.code !== 0) {
    const hint = /not permitted to create|GitHub Actions is not permitted/i.test(r.stderr)
      ? ' (allow it in Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests")' : '';
    throw new Error(`could not open the pull request: ${r.stderr.trim()}${hint}`);
  }
  return r.stdout.trim().split('\n').pop()!;
}
