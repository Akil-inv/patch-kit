import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Change, Finding } from '../types';
import { compareVersions, run, sameMajor } from '../util';

/**
 * pip: pinned requirements (requirements.txt), checked with pip-audit
 * (PyPI's advisory data). A vulnerable package pinned directly is moved to
 * its first fixed version when that stays on the same major version. One
 * brought in by another package (starlette by fastapi) is fixed by moving
 * that parent forward: the agent finds the parent and the first version of
 * it that allows the fix.
 */

const REQ = 'requirements.txt';
const norm = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

export function readPins(dir: string): Map<string, { name: string; version: string; line: number }> {
  const out = new Map<string, { name: string; version: string; line: number }>();
  const p = join(dir, REQ);
  if (!existsSync(p)) return out;
  readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
    const m = /^\s*([A-Za-z0-9_.\-\[\]]+?)\s*==\s*([^\s;#]+)/.exec(l);
    if (m) out.set(norm(m[1].replace(/\[.*\]/, '')), { name: m[1], version: m[2], line: i });
  });
  return out;
}

type PipAudit = { dependencies: { name: string; version: string; vulns: { id: string; fix_versions: string[]; aliases: string[]; description: string }[] }[] };

async function pypi(pkg: string, version?: string): Promise<any | null> {
  // pip honours the proxy settings; ask it rather than calling PyPI ourselves.
  const r = await run('python3', ['-c', `import json,urllib.request,os
u='https://pypi.org/pypi/${pkg}${version ? '/' + version : ''}/json'
print(urllib.request.urlopen(u, timeout=20).read().decode())`], { timeoutMs: 30_000 });
  try { return r.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
}

/** Does a requirement string like "starlette<0.39.0,>=0.37.2" allow this version? */
export function allows(spec: string, version: string): boolean {
  return spec.split(',').map((s) => s.trim()).filter(Boolean).every((c) => {
    const m = /^(==|!=|>=|<=|>|<|~=)\s*(.+)$/.exec(c);
    if (!m) return true;
    const d = compareVersions(version, m[2].replace(/\.\*$/, ''));
    switch (m[1]) {
      case '==': return m[2].endsWith('.*') ? version.startsWith(m[2].slice(0, -2)) : d === 0;
      case '!=': return d !== 0;
      case '>=': return d >= 0;
      case '<=': return d <= 0;
      case '>': return d > 0;
      case '<': return d < 0;
      case '~=': return d >= 0;
    }
    return true;
  });
}

export function requirementOf(requiresDist: string[] | null | undefined, child: string): string | null {
  for (const r of requiresDist ?? []) {
    if (/;\s*extra\s*==/.test(r)) continue;
    const m = /^([A-Za-z0-9_.\-]+)\s*(?:\[[^\]]*\])?\s*\(?([^;)]*)\)?/.exec(r);
    if (m && norm(m[1]) === norm(child)) return m[2].trim();
  }
  return null;
}

export async function auditPip(component: string, dir: string): Promise<Finding[]> {
  if (!existsSync(join(dir, REQ))) return [];
  const r = await run('pip-audit', ['-r', REQ, '--format', 'json', '--progress-spinner', 'off'], { cwd: dir, timeoutMs: 600_000 });
  let data: PipAudit;
  try { data = JSON.parse(r.stdout); } catch {
    throw new Error(`pip-audit gave no result in ${component} (is pip-audit installed?): ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
  const pins = readPins(dir);
  const findings: Finding[] = [];
  for (const dep of data.dependencies) {
    if (!dep.vulns?.length) continue;
    const fixes = dep.vulns.flatMap((v) => v.fix_versions ?? []);
    const need = fixes.sort(compareVersions).at(-1) ?? null; // the version that fixes them all
    const pinned = pins.get(norm(dep.name));
    let fix: Finding['fix'];
    if (!need) fix = { kind: 'none', how: 'no fixed version is published yet' };
    else if (pinned) {
      fix = sameMajor(dep.version, need)
        ? { kind: 'safe', how: `move the pin to ${dep.name}==${need}` }
        : { kind: 'major', package: dep.name, to: need, how: `move the pin to ${dep.name}==${need} (a major version)` };
    } else {
      fix = await parentFix(dep.name, need, pins);
    }
    findings.push({
      component, ecosystem: 'pip', package: dep.name, version: dep.version,
      severity: 'unrated', kind: 'vulnerability', direct: !!pinned,
      advisories: dep.vulns.map((v) => ({ id: v.id, title: firstLine(v.description), aliases: v.aliases, url: `https://osv.dev/vulnerability/${v.id}` })),
      fix, note: 'PyPI gives no severity; the registry rates these from OSV.',
    });
  }
  return findings;
}

const firstLine = (s: string) => (s ?? '').replace(/^#+\s*\w+\s*/, '').split(/(?<=\.)\s/)[0].slice(0, 160);

/** For a package brought in by another: the pinned parent and the first version of it that allows the fix. */
async function parentFix(child: string, need: string, pins: ReturnType<typeof readPins>): Promise<Finding['fix']> {
  for (const p of pins.values()) {
    const info = await pypi(p.name, p.version);
    const spec = requirementOf(info?.info?.requires_dist, child);
    if (spec === null) continue;
    if (allows(spec, need)) return { kind: 'safe', how: `${p.name} ${p.version} already allows ${child} ${need}: reinstall` };
    const all = await pypi(p.name);
    const versions = Object.keys(all?.releases ?? {}).filter((v) => /^\d+(\.\d+)*$/.test(v) && compareVersions(v, p.version) > 0).sort(compareVersions);
    for (const v of versions) {
      const vi = await pypi(p.name, v);
      const s = requirementOf(vi?.info?.requires_dist, child);
      if (s !== null && allows(s, need)) {
        return sameMajor(p.version, v)
          ? { kind: 'safe', how: `move the pin to ${p.name}==${v}, which allows ${child} ${need}` }
          : { kind: 'major', package: p.name, to: v, how: `upgrade ${p.name} to ${v}, which allows ${child} ${need}` };
      }
    }
    return { kind: 'none', how: `no ${p.name} release allows ${child} ${need} yet` };
  }
  return { kind: 'none', how: `${child} comes from a package that isn't pinned here` };
}

/** Apply the safe pin moves to requirements.txt. */
export function fixPip(component: string, dir: string, findings: Finding[]): Change[] {
  const p = join(dir, REQ);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').split('\n');
  const pins = readPins(dir);
  const changes: Change[] = [];
  for (const f of findings) {
    if (f.component !== component || f.fix.kind !== 'safe') continue;
    const m = /move the pin to ([A-Za-z0-9_.\-\[\]]+)==([^\s,]+)/.exec(f.fix.how);
    if (!m) continue;
    const pin = pins.get(norm(m[1]));
    if (!pin || compareVersions(m[2], pin.version) <= 0) continue;
    lines[pin.line] = lines[pin.line].replace(`==${pin.version}`, `==${m[2]}`);
    changes.push({ component, package: pin.name, from: pin.version, to: m[2] });
    pin.version = m[2];
  }
  if (changes.length) writeFileSync(p, lines.join('\n'));
  return changes;
}

export function countPip(dir: string): number {
  return readPins(dir).size;
}
