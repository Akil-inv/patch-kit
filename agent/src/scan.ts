import { join } from 'path';
import { eolPackages } from './eol';
import { findImages, imageFiles, scanImages } from './ecosystems/images';
import { checkModules, loadModuleIndex } from './ecosystems/modules';
import { auditNpm, countNpm, deprecatedNpm, directDeps, readLock } from './ecosystems/npm';
import { auditPip, countPip, readPins } from './ecosystems/pip';
import { Ecosystem, Finding, Manifest } from './types';
import { exists } from './util';

export type ScanResult = {
  components: { path: string; ecosystem: Ecosystem; packages: number }[];
  findings: Finding[];
  notChecked: string[];
  /** installed version of a package in a component (for plans) */
  installed: (component: string, pkg: string) => string | undefined;
};

export type Log = (msg: string) => void;

export async function scan(root: string, m: Manifest, log: Log = () => {}, opts: { images?: boolean } = {}): Promise<ScanResult> {
  const findings: Finding[] = [];
  const notChecked: string[] = [];
  const components: ScanResult['components'] = [];
  const versions = new Map<string, Map<string, string>>();
  const modules = await loadModuleIndex(root, m.modules);
  if (modules.problem) notChecked.push(modules.problem);
  const havePipAudit = await exists('pip-audit');

  for (const c of m.components) {
    const dir = join(root, c.path);
    const eco = c.ecosystem!;
    log(`  ${c.path} (${eco})`);
    if (eco === 'npm') {
      const lock = readLock(dir);
      versions.set(c.path, lock);
      components.push({ path: c.path, ecosystem: eco, packages: countNpm(dir) });
      if (!lock.size) { notChecked.push(`${c.path}: no package-lock.json, so npm audit cannot see exact versions`); continue; }
      findings.push(...(await auditNpm(c.path, dir)));
      findings.push(...(await deprecatedNpm(c.path, dir)));
      const direct = new Set(Object.keys(directDeps(dir).prod));
      findings.push(...eolPackages(c.path, 'npm', lock, direct));
      if (modules.index) findings.push(...checkModules(c.path, lock, m.modulePrefix ?? '@akil-inv/', modules.index));
    } else {
      const pins = readPins(dir);
      const installed = new Map([...pins.values()].map((p) => [p.name.toLowerCase(), p.version]));
      versions.set(c.path, installed);
      components.push({ path: c.path, ecosystem: eco, packages: countPip(dir) });
      if (!pins.size) { notChecked.push(`${c.path}: no pinned requirements.txt (name==version)`); continue; }
      if (!havePipAudit) { notChecked.push(`${c.path}: pip-audit is not installed (pip install pip-audit)`); continue; }
      findings.push(...(await auditPip(c.path, dir)));
    }
  }

  if (opts.images !== false) {
    log('  images');
    const refs = findImages(root, imageFiles(root, m.components.map((c) => c.path), m.images));
    const r = await scanImages(root, refs);
    findings.push(...r.findings);
    notChecked.push(...r.notChecked);
  }

  return {
    components, findings, notChecked,
    installed: (component, pkg) => versions.get(component)?.get(pkg) ?? versions.get(component)?.get(pkg.toLowerCase()),
  };
}
