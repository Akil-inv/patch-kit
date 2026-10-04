import { Manifest, TestRun } from './types';
import { run, tail } from './util';

const ANSI = /\x1b\[[0-9;]*m/g;
const FAILURE = /(^|\s)(FAIL\s|✕|●\s|error TS\d+|Error:|FAILED|AssertionError|Traceback)/;

/** The failure lines first (de-duplicated), then the last lines: enough to see what broke. */
export function summarise(text: string): string {
  const lines = text.replace(ANSI, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  const failures = [...new Set(lines.filter((l) => FAILURE.test(l)).map((l) => l.trim()))].slice(0, 15);
  const end = tail(lines.join('\n'), 12);
  return failures.length ? `${failures.join('\n')}\n…\n${end}` : end;
}

/**
 * The product's own tests are the gate. Each runs before the upgrades and
 * again after, so a test that was already failing is not blamed on them, and
 * one that starts failing is a regression that stops the change.
 */

export type Outcome = { status: 'passed' | 'failed'; output: string; seconds: number };

export async function runTest(root: string, t: NonNullable<Manifest['tests']>[number]): Promise<Outcome> {
  const r = await run(t.run, [], { cwd: root, shell: true, timeoutMs: (t.timeoutMinutes ?? 30) * 60_000, env: { CI: '1' } });
  const output = (r.timedOut ? `timed out after ${t.timeoutMinutes ?? 30} minutes\n` : '') + summarise(r.stdout + '\n' + r.stderr);
  return { status: r.code === 0 && !r.timedOut ? 'passed' : 'failed', output, seconds: r.seconds };
}

export async function runAll(root: string, tests: Manifest['tests']): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  for (const t of tests ?? []) out.set(t.name ?? t.run, await runTest(root, t));
  return out;
}

export function compare(tests: Manifest['tests'], before: Map<string, Outcome>, after: Map<string, Outcome> | null): TestRun[] {
  return (tests ?? []).map((t) => {
    const name = t.name ?? t.run;
    const b = before.get(name);
    const a = after?.get(name);
    const bs = b?.status ?? 'skipped';
    const as = a?.status ?? 'skipped';
    const verdict: TestRun['verdict'] =
      as === 'skipped' ? (bs === 'skipped' ? 'skipped' : bs === 'passed' ? 'passed' : 'already-failing')
      : as === 'passed' ? 'passed'
      : bs === 'failed' ? 'already-failing'
      : 'regression';
    return { name, run: t.run, before: bs, after: as, verdict, outputTail: verdict === 'passed' ? undefined : (a ?? b)?.output, seconds: (b?.seconds ?? 0) + (a?.seconds ?? 0) };
  });
}
