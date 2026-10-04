import { join } from 'path';
import { whereUsed } from './ecosystems/npm';
import { run } from './util';
import { Finding, Plan, Severity } from './types';
import { compareVersions, parseVersion } from './util';

const concrete = (v: string) => /^\d+(\.\d+){1,}$/.test(v) || v.includes(':');

/**
 * Upgrades the agent will not make by itself (a new major version, a new base
 * image) become plans: what to change, why, what is known to break, where the
 * package is used, and the migration guide. A person approves each one.
 */

type Known = { name: string; guide?: string; breaking: (from: number, to: number) => string[] };

const KNOWN: Record<string, Known> = {
  next: {
    name: 'Next.js',
    guide: 'https://nextjs.org/docs/app/guides/upgrading',
    breaking: (f, t) => [
      ...(f < 15 && t >= 15 ? ['Request APIs (cookies, headers, params, searchParams) become async', 'fetch and GET route handlers are no longer cached by default', 'React 19 is required'] : []),
      ...(f < 16 && t >= 16 ? ['Turbopack is the default bundler; check custom webpack config', 'middleware is renamed proxy', 'Node.js 20.9 or later required'] : []),
    ],
  },
  '@nestjs/core': {
    name: 'NestJS',
    guide: 'https://docs.nestjs.com/migration-guide',
    breaking: (f, t) => (f < 11 && t >= 11 ? ['Express 5 path matching (wildcards need names, e.g. *splat)', 'Node.js 20 or later', 'all @nestjs/* packages move together'] : []),
  },
  '@nestjs/graphql': {
    name: 'NestJS GraphQL',
    guide: 'https://docs.nestjs.com/migration-guide',
    breaking: (f, t) => (f < 13 && t >= 13 ? ['needs NestJS 11 and @apollo/server 5', 'all @nestjs/* packages move together'] : []),
  },
  '@nestjs/platform-express': {
    name: 'NestJS (Express platform)',
    guide: 'https://docs.nestjs.com/migration-guide',
    breaking: (f, t) => (f < 11 && t >= 11 ? ['Express 5 underneath: route wildcards and query parsing change', 'all @nestjs/* packages move together'] : []),
  },
  '@apollo/server': {
    name: 'Apollo Server',
    guide: 'https://www.apollographql.com/docs/apollo-server/migration',
    breaking: (f, t) => (f < 5 && t >= 5 ? ['Node.js 20 or later', 'Express integration moves to @as-integrations/express5', 'needs @nestjs/apollo 13 when used with NestJS'] : []),
  },
  fastapi: {
    name: 'FastAPI',
    guide: 'https://fastapi.tiangolo.com/release-notes/',
    breaking: () => ['FastAPI is pre-1.0: minor versions can change behaviour; read the release notes between the two versions', 'brings a newer Starlette (the vulnerable package)'],
  },
  xlsx: {
    name: 'SheetJS (xlsx)',
    guide: 'https://docs.sheetjs.com/docs/getting-started/installation/nodejs',
    breaking: () => ['installed from the SheetJS CDN instead of npm: an air-gapped site needs the tarball in the bundle', 'the API is the same for reading and writing workbooks'],
  },
  node: {
    name: 'Node.js',
    guide: 'https://nodejs.org/en/about/previous-releases',
    breaking: (f, t) => [`rebuild the image on Node ${t}; native modules (bcrypt, prisma engines) are rebuilt by npm ci`, ...(f < 22 && t >= 22 ? ['require() of ES modules is allowed; some packages change which entry they load'] : [])],
  },
  python: { name: 'Python', guide: 'https://docs.python.org/3/whatsnew/', breaking: () => ['rebuild the image; check wheels exist for every pinned package'] },
  postgres: {
    name: 'PostgreSQL',
    guide: 'https://www.postgresql.org/docs/current/upgrading.html',
    breaking: () => ['a new major version cannot read the old data folder: dump and restore (or pg_upgrade); take a backup first'],
  },
};

const ORDER: Severity[] = ['critical', 'high', 'moderate', 'low', 'unrated'];
const worst = (a: Severity, b: Severity) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);

function knownFor(pkg: string): Known | undefined {
  if (KNOWN[pkg]) return KNOWN[pkg];
  const base = pkg.split('/').pop()!.split(':')[0];
  return KNOWN[base];
}

export async function makePlans(root: string, findings: Finding[], installed: (component: string, pkg: string) => string | undefined): Promise<Plan[]> {
  const groups = new Map<string, { f: Finding[]; component: string; pkg: string; to: string; how: string }>();
  for (const f of findings) {
    if (f.fix.kind !== 'major') continue;
    // One plan per package: an advisory, an end-of-life date and a deprecation notice for
    // @apollo/server are the same piece of work. The concrete target version wins over "5.x" / "latest".
    const pkgKey = f.ecosystem === 'image' ? f.fix.package.split(':')[0] + ':' + f.version : f.fix.package;
    const key = `${f.component}|${pkgKey}`;
    const g = groups.get(key) ?? { f: [], component: f.component, pkg: f.fix.package, to: f.fix.to, how: f.fix.how };
    if (concrete(f.fix.to) && (!concrete(g.to) || compareVersions(f.fix.to, g.to) > 0)) { g.to = f.fix.to; g.how = f.fix.how; }
    g.f.push(f);
    groups.set(key, g);
  }
  const plans: Plan[] = [];
  for (const g of groups.values()) {
    const from = installed(g.component, g.pkg) ?? g.f.find((x) => x.package === g.pkg)?.version ?? '?';
    const k = knownFor(g.pkg);
    const isImage = g.f[0].ecosystem === 'image';
    const product = isImage ? g.pkg.split(':')[0].split('/').pop()! : g.pkg;
    const fromMajor = parseVersion(isImage ? g.f[0].version : from)[0];
    const toMajor = parseVersion(isImage ? g.to.split(':').pop()! : g.to)[0];
    const severity = g.f.map((x) => x.severity).reduce(worst);
    const ids = [...new Set(g.f.flatMap((x) => x.advisories.map((a) => a.id)))];
    plans.push({
      id: `${g.f[0].ecosystem}:${g.pkg}@${g.to}`,
      title: `${k?.name ?? product} ${isImage ? g.f[0].version : from} → ${isImage ? g.to.split(':').pop() : g.to}${g.component === 'images' ? '' : ` (${g.component})`}`,
      component: g.component, package: g.pkg, from: isImage ? g.f[0].version : from, to: g.to, severity,
      fixes: [...new Set(g.f.map((x) => x.package))],
      why: why(g.f),
      breaking: k ? k.breaking(fromMajor, toMajor) : ['a major version: read the changelog between the two versions'],
      guide: k?.guide,
      whereInCode: isImage ? [...new Set(g.f.map((x) => x.note ?? ''))] : g.f[0].ecosystem === 'pip' ? await whereUsedPy(join(root, g.component), g.pkg) : await whereUsed(join(root, g.component), g.pkg),
      command: g.how,
    });
  }
  return plans.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
}

function why(fs: Finding[]): string {
  const parts: string[] = [];
  const vulns = [...new Set(fs.filter((x) => x.kind === 'vulnerability').flatMap((x) => x.advisories.map((a) => a.id)))];
  if (vulns.length) parts.push(`clears ${vulns.length} advisor${vulns.length === 1 ? 'y' : 'ies'} (${vulns.slice(0, 4).join(', ')}${vulns.length > 4 ? '…' : ''})`);
  const eol = fs.find((x) => x.kind === 'end-of-life');
  if (eol) parts.push(eol.advisories[0].title);
  if (fs.some((x) => x.kind === 'deprecated')) parts.push('the installed version is deprecated');
  if (fs.some((x) => x.kind === 'outdated-module')) parts.push('a newer version of our module is out');
  const s = parts.join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function whereUsedPy(dir: string, pkg: string): Promise<string[]> {
  const mod = pkg.toLowerCase().replace(/-/g, '_');
  const r = await run('git', ['grep', '-l', '-E', `^\\s*(from|import)\\s+${mod}(\\.|\\s|$)`, '--', '*.py'], { cwd: dir });
  return r.code === 0 ? r.stdout.trim().split('\n').filter(Boolean).slice(0, 50) : [];
}
