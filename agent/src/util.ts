import { spawn } from 'child_process';

export type RunResult = { code: number; stdout: string; stderr: string; seconds: number; timedOut: boolean };

/** Run a command (no shell unless asked), capturing output. Never throws for a non-zero exit. */
export function run(cmd: string, args: string[], opts: { cwd?: string; shell?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: opts.shell ?? false, env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, add: string) => (s.length > 8_000_000 ? s : s + add);
    child.stdout.on('data', (d) => (stdout = cap(stdout, String(d))));
    child.stderr.on('data', (d) => (stderr = cap(stderr, String(d))));
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs) : null;
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, seconds: Math.round((Date.now() - started) / 1000), timedOut });
    });
  });
}

export const tail = (s: string, lines = 30) => s.trim().split('\n').slice(-lines).join('\n');

export async function exists(cmd: string): Promise<boolean> {
  const r = await run('sh', ['-c', `command -v ${cmd}`]);
  return r.code === 0 && r.stdout.trim() !== '';
}

/** "1.2.3" → [1,2,3]; tolerant of "v", pre-release tags and "0.20" */
export function parseVersion(v: string): number[] {
  return (v.replace(/^[^\d]*/, '').split(/[-+]/)[0] || '0').split('.').map((x) => parseInt(x, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Same major version. Below 1.0 the minor version is the breaking one (semver), so 0.115 → 0.133 is not "same". */
export const sameMajor = (a: string, b: string) => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x[0] === y[0] && (x[0] !== 0 || (x[1] ?? 0) === (y[1] ?? 0));
};

export async function fetchJson<T>(url: string, timeoutMs = 15000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Run promises with a limit on how many at once. */
export async function pool<T, R>(items: T[], limit: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await f(items[k]);
    }
  }));
  return out;
}
