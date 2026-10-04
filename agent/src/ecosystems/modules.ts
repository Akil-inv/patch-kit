import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { Finding, Severity } from '../types';
import { compareVersions, fetchJson, sameMajor } from '../util';

/**
 * Our own modules (auth-kit and the like). Public advisory databases know
 * nothing about them, so their latest versions and advisories come from the
 * registry's modules.json. A connected product reads it by URL; an
 * air-gapped one reads the copy that arrived in the last bundle.
 */

export type ModuleIndex = {
  updated?: string;
  modules: Record<string, {
    latest: string;
    repo?: string;
    advisories?: { id: string; title: string; below: string; severity?: Severity; url?: string }[];
  }>;
};

export async function loadModuleIndex(root: string, where?: string): Promise<{ index: ModuleIndex | null; from?: string; problem?: string }> {
  const src = process.env.PATCHKIT_MODULES || where;
  if (!src) return { index: null, problem: 'our own modules (set modules: in patchkit.yml to the registry\'s modules.json)' };
  try {
    if (/^https?:\/\//.test(src)) {
      const index = await fetchJson<ModuleIndex>(src);
      return index ? { index, from: src } : { index: null, problem: `our own modules (could not read ${src})` };
    }
    const p = isAbsolute(src) ? src : join(root, src);
    if (!existsSync(p)) return { index: null, problem: `our own modules (${src} not found)` };
    return { index: JSON.parse(readFileSync(p, 'utf8')), from: src };
  } catch (e) {
    return { index: null, problem: `our own modules (${src}: ${(e as Error).message})` };
  }
}

/** Compare installed versions of our modules with the index. */
export function checkModules(component: string, installed: Map<string, string>, prefix: string, index: ModuleIndex): Finding[] {
  const out: Finding[] = [];
  for (const [name, version] of installed) {
    if (!name.startsWith(prefix)) continue;
    const entry = index.modules[name];
    if (!entry) continue;
    const hits = (entry.advisories ?? []).filter((a) => compareVersions(version, a.below) < 0);
    const behind = compareVersions(version, entry.latest) < 0;
    if (!hits.length && !behind) continue;
    const order: Severity[] = ['critical', 'high', 'moderate', 'low', 'unrated'];
    const severity = hits.length ? hits.map((h) => h.severity ?? 'moderate').sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] : 'low';
    out.push({
      component, ecosystem: 'module', package: name, version, severity,
      kind: hits.length ? 'vulnerability' : 'outdated-module', direct: true,
      advisories: hits.length ? hits.map((h) => ({ id: h.id, title: h.title, url: h.url })) : [{ id: 'outdated', title: `${entry.latest} is available` }],
      fix: sameMajor(version, entry.latest)
        ? { kind: 'safe', how: `update ${name} to ${entry.latest} (from the registry, or the vendored tarball in the bundle)` }
        : { kind: 'major', package: name, to: entry.latest, how: `upgrade ${name} to ${entry.latest} (a major version)` },
    });
  }
  return out;
}
