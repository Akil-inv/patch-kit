#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fixNpm } from './ecosystems/npm';
import { fixPip } from './ecosystems/pip';
import { backTo, branchName, commitFiles, discardChanges, dirtyFiles, gitInfo, pullRequest, push, startBranch } from './git';
import { loadManifest } from './manifest';
import { makePlans } from './plans';
import { count, oneLine, toMarkdown } from './report';
import { scan } from './scan';
import { compare, runAll } from './tests';
import { Change, Report, SEVERITIES, Severity } from './types';
import { run } from './util';

const VERSION: string = require('../package.json').version;

const HELP = `patchkit ${VERSION}: find vulnerable, deprecated and end-of-life packages, and fix the safe ones.

Usage:
  patchkit scan [options]          report only; changes nothing
  patchkit fix  [options]          make the safe upgrades on a new branch, run the tests before and after
       --push                      push the branch
       --pr                        open a pull request (implies --push; needs the gh CLI)

Options:
  --root <dir>        the product's repository (default: current folder)
  --manifest <file>   default: patchkit.yml
  --out <dir>         where to write report.json and report.md (default: <root>/.patchkit)
  --fail-on <sev>     exit 2 when a finding at this severity or worse remains (critical, high, moderate, low)
  --no-images         skip container images
  --allow-dirty       let fix run with uncommitted changes (they are not committed)
  -q, --quiet         only the summary line
`;

type Opts = { cmd: string; root: string; manifest: string; out?: string; push: boolean; pr: boolean; failOn?: Severity; images: boolean; allowDirty: boolean; quiet: boolean };

function parse(argv: string[]): Opts {
  const o: Opts = { cmd: argv[0] ?? 'help', root: process.cwd(), manifest: 'patchkit.yml', push: false, pr: false, images: true, allowDirty: false, quiet: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (!v) throw new Error(`${a} needs a value`); return v; };
    if (a === '--root') o.root = resolve(val());
    else if (a === '--manifest') o.manifest = val();
    else if (a === '--out') o.out = resolve(val());
    else if (a === '--push') o.push = true;
    else if (a === '--pr') { o.pr = true; o.push = true; }
    else if (a === '--fail-on') { const s = val() as Severity; if (!SEVERITIES.includes(s)) throw new Error(`--fail-on: one of ${SEVERITIES.join(', ')}`); o.failOn = s; }
    else if (a === '--no-images') o.images = false;
    else if (a === '--allow-dirty') o.allowDirty = true;
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let o: Opts;
  try { o = parse(argv); } catch (e) { console.error(`patchkit: ${(e as Error).message}\n\n${HELP}`); return 64; }
  if (o.cmd === 'version' || o.cmd === '--version') { console.log(VERSION); return 0; }
  if (o.cmd !== 'scan' && o.cmd !== 'fix') { console.log(HELP); return o.cmd === 'help' || o.cmd === '--help' || o.cmd === '-h' ? 0 : 64; }

  const log = (s: string) => { if (!o.quiet) console.error(s); };
  const m = loadManifest(o.root, o.manifest);
  const out = o.out ?? join(o.root, '.patchkit');
  const git = await gitInfo(o.root);
  log(`patchkit ${VERSION}: ${m.product} (${m.environment})`);

  if (o.cmd === 'fix') {
    if (!git) throw new Error('fix needs a git repository');
    const dirty = await dirtyFiles(o.root);
    if (dirty.length && !o.allowDirty) throw new Error(`uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}). Commit them, or pass --allow-dirty.`);
  }

  log('Scanning');
  const s0 = await scan(o.root, m, log, { images: o.images });
  const plans = await makePlans(o.root, s0.findings, s0.installed);
  const before = count(s0.findings);
  const safe = s0.findings.filter((f) => f.fix.kind === 'safe' && (f.ecosystem === 'npm' || f.ecosystem === 'pip'));

  const report: Report = {
    schema: 1, tool: { name: 'patch-kit-agent', version: VERSION },
    product: m.product, owner: m.owner, environment: m.environment, mode: o.cmd as 'scan' | 'fix', ranAt: new Date().toISOString(), git,
    components: s0.components, findings: s0.findings, plans, changes: [], tests: [],
    summary: { before, after: before, safeFixes: safe.length, plans: plans.length, notChecked: s0.notChecked },
  };
  let code = 0;

  if (o.cmd === 'fix' && safe.length) {
    log(`Running ${m.tests?.length ?? 0} test(s) before the upgrades`);
    const tb = await runAll(o.root, m.tests);
    const name = branchName();
    await startBranch(o.root, name);
    const changes: Change[] = [];
    for (const c of m.components) {
      if (!safe.some((f) => f.component === c.path)) continue;
      const dir = join(o.root, c.path);
      log(`Upgrading ${c.path}`);
      if (c.ecosystem === 'npm') changes.push(...(await fixNpm(c.path, dir)).changes);
      else {
        const moved = fixPip(c.path, dir, s0.findings);
        changes.push(...moved);
        // Install the new pins so the tests after run against them (set PATCHKIT_PIP_INSTALL=0 to skip).
        if (moved.length && process.env.PATCHKIT_PIP_INSTALL !== '0') {
          const r = await run('python3', ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'], { cwd: dir, timeoutMs: 900_000 });
          if (r.code !== 0) log(`  pip install failed in ${c.path}: ${r.stderr.trim().split('\n').pop()}`);
        }
      }
    }
    report.changes = changes;
    log(`Running the tests again`);
    const ta = changes.length ? await runAll(o.root, m.tests) : null;
    report.tests = compare(m.tests, tb, ta);
    const broken = report.tests.some((t) => t.verdict === 'regression');

    if (broken || !changes.length) {
      // Put the files back; nothing is committed.
      if (!o.allowDirty) await discardChanges(o.root);
      await backTo(o.root, git!.branch);
      await run('git', ['branch', '-D', name], { cwd: o.root });
      if (broken) { log('⛔ The upgrades broke a test; nothing committed. (Run npm ci to reset node_modules.)'); code = 1; }
    } else {
      log('Checking what is left');
      const s1 = await scan(o.root, m, () => {}, { images: o.images });
      report.summary.after = count(s1.findings);
      // Plans from what is left: a safe upgrade can clear a finding a plan was for (multer).
      report.plans = await makePlans(o.root, s1.findings, s1.installed);
      report.summary.plans = report.plans.length;
      const md = toMarkdown(report);
      const title = `patch-kit: ${changes.length} safe upgrade${changes.length > 1 ? 's' : ''} (${m.product})`;
      const touched = [...new Set(changes.map((c) => c.component))].flatMap((c) =>
        ['package.json', 'package-lock.json', 'requirements.txt'].map((f) => join(c, f)).filter((f) => existsSync(join(o.root, f))));
      await commitFiles(o.root, touched, `${title}\n\n${changes.map((c) => `${c.component}: ${c.package} ${c.from} → ${c.to}`).join('\n')}`);
      if (!o.allowDirty) await discardChanges(o.root);
      report.branch = { name, pushed: false };
      try {
        if (o.push) { await push(o.root, name); report.branch.pushed = true; }
        if (o.pr) {
          mkdirSync(out, { recursive: true });
          const body = join(out, 'pr.md');
          writeFileSync(body, md);
          report.branch.pullRequest = await pullRequest(o.root, name, git!.branch, title, body);
          log(`Pull request: ${report.branch.pullRequest}`);
        }
      } catch (e) {
        log(`⚠️ ${(e as Error).message}`);
        report.summary.notChecked.push(`publishing the branch: ${(e as Error).message}`);
        code = 3;
      } finally {
        await backTo(o.root, git!.branch);
      }
    }
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(out, 'report.md'), toMarkdown(report));
  console.log(oneLine(report));
  log(`Report: ${join(out, 'report.md')}`);

  if (o.failOn && code === 0) {
    const worst = SEVERITIES.slice(0, SEVERITIES.indexOf(o.failOn) + 1);
    if (worst.some((s) => report.summary.after[s] > 0)) code = 2;
  }
  return code;
}

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error(`patchkit: ${e.message}`); process.exit(1); });
}
