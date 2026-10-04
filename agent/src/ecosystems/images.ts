import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';
import { eolStatus } from '../eol';
import { Finding, Severity } from '../types';
import { exists, run } from '../util';

/**
 * Container images: the base images in Dockerfiles (FROM) and the images in
 * docker-compose files. Each is checked for end of life against the agent's
 * built-in table. When Trivy is installed (and PATCHKIT_TRIVY=1), the
 * operating-system packages inside each image are scanned too; otherwise the
 * report says they were not checked, rather than pretending they are clean.
 */

export type ImageRef = { image: string; name: string; tag: string; file: string; line: number };

const PRODUCT: Record<string, string> = { node: 'node', python: 'python', postgres: 'postgres' };

export function parseImage(ref: string): { name: string; tag: string } {
  const noDigest = ref.split('@')[0];
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  if (colon > slash) return { name: noDigest.slice(0, colon), tag: noDigest.slice(colon + 1) };
  return { name: noDigest, tag: 'latest' };
}

export function findImages(root: string, files: string[]): ImageRef[] {
  const out: ImageRef[] = [];
  const stages = new Set<string>();
  for (const file of files) {
    const p = join(root, file);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    if (/(^|\/)Dockerfile[^/]*$/.test(file)) {
      text.split('\n').forEach((l, i) => {
        const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
        if (!m) return;
        if (m[2]) stages.add(m[2].toLowerCase());
        if (stages.has(m[1].toLowerCase()) || m[1].includes('$')) return; // an earlier stage or a build arg
        out.push({ image: m[1], ...parseImage(m[1]), file, line: i + 1 });
      });
    } else {
      const doc = YAML.parse(text) ?? {};
      const lines = text.split('\n');
      for (const svc of Object.values<any>(doc.services ?? {})) {
        if (typeof svc?.image !== 'string' || svc.image.includes('$')) continue;
        const line = lines.findIndex((l) => l.includes(`image: ${svc.image}`)) + 1;
        out.push({ image: svc.image, ...parseImage(svc.image), file, line });
      }
    }
  }
  return out;
}

/** The files to look in: the manifest's list, or each component's Dockerfile plus docker-compose.yml. */
export function imageFiles(root: string, components: string[], listed?: string[]): string[] {
  if (listed?.length) return listed;
  const files = components.map((c) => `${c}/Dockerfile`).filter((f) => existsSync(join(root, f)));
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) if (existsSync(join(root, f))) files.push(f);
  return files;
}

export async function scanImages(root: string, refs: ImageRef[], today = new Date()): Promise<{ findings: Finding[]; notChecked: string[] }> {
  const findings: Finding[] = [];
  const notChecked: string[] = [];
  const floating: string[] = [];
  for (const r of refs) {
    const base = r.name.split('/').pop()!;
    const product = PRODUCT[base];
    if (!/\d/.test(r.tag)) floating.push(r.image);
    if (!product) continue;
    const s = eolStatus(product, r.tag, today);
    if (!s || s.daysLeft > 180) continue;
    const newTag = s.latest ? r.tag.replace(s.line, s.latest) : undefined;
    findings.push({
      component: 'images', ecosystem: 'image', package: r.image, version: r.tag, kind: 'end-of-life', direct: true,
      severity: s.ended ? 'high' : 'moderate',
      advisories: [{ id: `eol:${product}@${s.line}`, title: s.ended ? `${product} ${s.line} stopped getting security fixes on ${s.ends}` : `${product} ${s.line} stops getting security fixes on ${s.ends} (${s.daysLeft} days)` }],
      fix: newTag ? { kind: 'major', package: r.image, to: `${r.name}:${newTag}`, how: `change ${r.file} line ${r.line} to ${r.name}:${newTag}` } : { kind: 'none', how: 'no supported line is known' },
      note: `${r.file}:${r.line}`,
    });
  }
  if (floating.length) notChecked.push(`images on moving tags (${floating.join(', ')}): pin a version so the registry knows what runs`);

  if (process.env.PATCHKIT_TRIVY === '1' && (await exists('trivy'))) {
    for (const image of [...new Set(refs.map((r) => r.image))]) findings.push(...(await trivy(image)));
  } else {
    notChecked.push('operating-system packages inside images (install Trivy and set PATCHKIT_TRIVY=1)');
  }
  return { findings, notChecked };
}

const TSEV: Record<string, Severity> = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'moderate', LOW: 'low' };

async function trivy(image: string): Promise<Finding[]> {
  const r = await run('trivy', ['image', '--quiet', '--scanners', 'vuln', '--severity', 'CRITICAL,HIGH', '--format', 'json', image], { timeoutMs: 900_000 });
  let data: any;
  try { data = JSON.parse(r.stdout); } catch { return []; }
  const byPkg = new Map<string, Finding>();
  for (const res of data.Results ?? []) {
    for (const v of res.Vulnerabilities ?? []) {
      const key = `${v.PkgName}@${v.InstalledVersion}`;
      const f = byPkg.get(key) ?? {
        component: 'images', ecosystem: 'image', package: `${image} › ${v.PkgName}`, version: v.InstalledVersion,
        severity: 'low', kind: 'vulnerability', direct: false, advisories: [],
        fix: v.FixedVersion ? { kind: 'safe', how: `rebuild ${image} (fixed in ${v.FixedVersion})` } : { kind: 'none', how: 'no fixed package in the distribution yet' },
      } as Finding;
      f.advisories.push({ id: v.VulnerabilityID, title: v.Title ?? v.VulnerabilityID, url: v.PrimaryURL });
      const sev = TSEV[v.Severity] ?? 'unrated';
      if (['critical', 'high', 'moderate', 'low', 'unrated'].indexOf(sev) < ['critical', 'high', 'moderate', 'low', 'unrated'].indexOf(f.severity)) f.severity = sev;
      byPkg.set(key, f);
    }
  }
  return [...byPkg.values()];
}
