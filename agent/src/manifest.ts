import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';
import { Ecosystem, Manifest } from './types';

/** Read and check patchkit.yml. Errors say exactly what to fix. */
export function loadManifest(root: string, file = 'patchkit.yml'): Manifest {
  const path = join(root, file);
  if (!existsSync(path)) throw new Error(`No ${file} in ${root}. Add one to enrol this product (see the patch-kit README).`);
  const raw = YAML.parse(readFileSync(path, 'utf8')) ?? {};
  const problems: string[] = [];
  if (typeof raw.product !== 'string' || !raw.product) problems.push('product: give the product a name');
  const env = raw.environment ?? 'connected';
  if (!['connected', 'air-gapped'].includes(env)) problems.push('environment: connected or air-gapped');
  if (!Array.isArray(raw.components) || raw.components.length === 0) problems.push('components: list at least one folder');
  const components = (raw.components ?? []).map((c: any, i: number) => {
    const p = typeof c === 'string' ? c : c?.path;
    if (typeof p !== 'string' || !p) { problems.push(`components[${i}]: needs a path`); return null; }
    const eco: Ecosystem | undefined = c?.ecosystem ?? detect(root, p);
    if (!eco) problems.push(`components[${i}] (${p}): no package.json or requirements.txt found; set ecosystem: npm or pip`);
    return { path: p.replace(/\/$/, ''), ecosystem: eco };
  }).filter(Boolean);
  const tests = (raw.tests ?? []).map((t: any, i: number) => {
    const runCmd = typeof t === 'string' ? t : t?.run;
    if (typeof runCmd !== 'string') problems.push(`tests[${i}]: needs run: <command>`);
    return { name: t?.name ?? runCmd, run: runCmd, timeoutMinutes: t?.timeoutMinutes ?? 30 };
  });
  const images = raw.images === undefined ? [] : Array.isArray(raw.images) ? raw.images : [raw.images];
  if (raw.deploy !== undefined && (typeof raw.deploy !== 'object' || (raw.deploy.rollback !== undefined && typeof raw.deploy.rollback !== 'string'))) problems.push('deploy: rollback: <how to put back the previous release>');
  if (problems.length) throw new Error(`${file} needs fixing:\n  - ${problems.join('\n  - ')}`);
  return { product: raw.product, owner: raw.owner, environment: env, components, images, tests, modules: raw.modules, modulePrefix: raw.modulePrefix ?? '@akil-inv/', deploy: raw.deploy };
}

function detect(root: string, p: string): Ecosystem | undefined {
  if (existsSync(join(root, p, 'package.json'))) return 'npm';
  if (existsSync(join(root, p, 'requirements.txt')) || existsSync(join(root, p, 'pyproject.toml'))) return 'pip';
  return undefined;
}
