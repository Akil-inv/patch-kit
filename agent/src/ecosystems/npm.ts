import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Advisory, Change, Finding, Severity } from '../types';
import { pool, run } from '../util';

/**
 * npm: what is installed (package-lock.json), what npm's advisory service
 * knows about it (npm audit, the GitHub Advisory Database), which direct
 * dependencies are deprecated, and the upgrades npm can make within the
 * ranges in package.json (npm audit fix, never --force).
 */

type Lock = { packages?: Record<string, { version?: string; dev?: boolean }> };

export function readLock(dir: string): Map<string, string> {
  const p = join(dir, 'package-lock.json');
  const out = new Map<string, string>();
  if (!existsSync(p)) return out;
  const lock: Lock = JSON.parse(readFileSync(p, 'utf8'));
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if (!path || !info.version) continue;
    // The top-level copy of each package (node_modules/<name>), not nested duplicates.
    const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path);
    if (m) out.set(m[1], info.version);
  }
  return out;
}

export function directDeps(dir: string): { prod: Record<string, string>; dev: Record<string, string> } {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return { prod: pkg.dependencies ?? {}, dev: pkg.devDependencies ?? {} };
}

const SEV: Record<string, Severity> = { critical: 'critical', high: 'high', moderate: 'moderate', low: 'low', info: 'low' };

/** Packages whose fixed versions are published somewhere other than npm. */
const ELSEWHERE: Record<string, { to: string; how: string }> = {
  xlsx: {
    to: '0.20.3',
    how: 'SheetJS publishes fixed versions on its own site, not npm: npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
  },
};

export async function auditNpm(component: string, dir: string): Promise<Finding[]> {
  const r = await run('npm', ['audit', '--json', '--omit=dev'], { cwd: dir, timeoutMs: 180_000 });
  let data: any;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new Error(`npm audit gave no result in ${component}: ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
  if (data.error) throw new Error(`npm audit failed in ${component}: ${data.error.summary ?? JSON.stringify(data.error).slice(0, 300)}`);
  const lock = readLock(dir);
  const { prod } = directDeps(dir);
  const findings: Finding[] = [];
  for (const [name, v] of Object.entries<any>(data.vulnerabilities ?? {})) {
    // Only the package that is itself vulnerable; npm also lists every package that depends on it.
    const own = (v.via ?? []).filter((x: any) => typeof x === 'object');
    if (!own.length) continue;
    const advisories: Advisory[] = own.map((x: any) => ({
      id: x.url ? String(x.url).split('/').pop() : String(x.source),
      title: x.title,
      url: x.url,
    }));
    const fa = v.fixAvailable;
    let fix: Finding['fix'];
    if (fa === true) fix = { kind: 'safe', how: 'npm audit fix (within the ranges in package.json)' };
    else if (fa && typeof fa === 'object' && !fa.isSemVerMajor) fix = { kind: 'safe', how: `npm audit fix updates ${fa.name} to ${fa.version}` };
    else if (fa && typeof fa === 'object') fix = { kind: 'major', package: fa.name, to: fa.version, how: `upgrade ${fa.name} to ${fa.version} (a major version)` };
    else if (ELSEWHERE[name]) fix = { kind: 'major', package: name, to: ELSEWHERE[name].to, how: ELSEWHERE[name].how };
    else fix = { kind: 'none', how: 'no fixed version is published yet' };
    findings.push({
      component, ecosystem: 'npm', package: name, version: lock.get(name) ?? v.range ?? '?',
      severity: SEV[v.severity] ?? 'unrated', kind: 'vulnerability', advisories, direct: name in prod, fix,
    });
  }
  return findings;
}

/** Direct dependencies whose installed version is marked deprecated on npm. */
export async function deprecatedNpm(component: string, dir: string): Promise<Finding[]> {
  const lock = readLock(dir);
  const { prod } = directDeps(dir);
  const names = Object.keys(prod).filter((n) => lock.has(n) && !prod[n].startsWith('file:'));
  const results = await pool(names, 8, async (name) => {
    const version = lock.get(name)!;
    const r = await run('npm', ['view', `${name}@${version}`, 'deprecated', '--json'], { cwd: dir, timeoutMs: 30_000 });
    const text = r.stdout.trim();
    if (r.code !== 0 || !text) return null;
    let msg: string;
    try { msg = JSON.parse(text); } catch { msg = text; }
    if (!msg || typeof msg !== 'string') return null;
    return {
      component, ecosystem: 'npm', package: name, version, severity: 'low', kind: 'deprecated', direct: true,
      advisories: [{ id: 'deprecated', title: msg.slice(0, 300) }],
      fix: { kind: 'major', package: name, to: 'latest', how: 'replace or upgrade, as the deprecation notice says' },
    } as Finding;
  });
  return results.filter((x): x is Finding => !!x);
}

/** The upgrades npm can make without leaving package.json's ranges. Returns what changed. */
export async function fixNpm(component: string, dir: string): Promise<{ changes: Change[]; log: string }> {
  const before = readLock(dir);
  const r = await run('npm', ['audit', 'fix'], { cwd: dir, timeoutMs: 600_000 });
  const after = readLock(dir);
  const changes: Change[] = [];
  for (const [name, v] of after) {
    const old = before.get(name);
    if (old && old !== v) changes.push({ component, package: name, from: old, to: v });
  }
  return { changes, log: (r.stdout + r.stderr).slice(-4000) };
}

export function countNpm(dir: string): number {
  return readLock(dir).size;
}

/** Files in a component that import a package (for upgrade plans). */
export async function whereUsed(dir: string, pkg: string): Promise<string[]> {
  const esc = pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const r = await run('git', ['grep', '-l', '-E', `(from|require\\(|import\\()\\s*['"]${esc}(/[^'"]*)?['"]`, '--', ':!**/node_modules/**', ':!**/*.lock', ':!**/package-lock.json'], { cwd: dir });
  return r.code === 0 ? r.stdout.trim().split('\n').filter(Boolean).slice(0, 50) : [];
}
