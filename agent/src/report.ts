import { Counts, Finding, Report, SEVERITIES } from './types';

export function count(findings: Finding[]): Counts {
  const c = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Counts;
  for (const f of findings) c[f.severity]++;
  return c;
}

const total = (c: Counts) => SEVERITIES.reduce((n, s) => n + c[s], 0);
const fmt = (c: Counts) => SEVERITIES.filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(', ') || 'none';
const esc = (s: string) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const ICON: Record<string, string> = { critical: '🔴', high: '🟠', moderate: '🟡', low: '⚪', unrated: '⚫' };

/** The pull request body and the human-readable report. */
export function toMarkdown(r: Report): string {
  const out: string[] = [];
  const { before, after } = r.summary;
  out.push(`# patch-kit: ${r.product}`);
  out.push('');
  out.push(`Scanned ${r.ranAt.slice(0, 16).replace('T', ' ')} UTC${r.git ? ` at \`${r.git.commit.slice(0, 7)}\` (${r.git.branch})` : ''}: ${r.components.map((c) => `${c.path} (${c.ecosystem}, ${c.packages} packages)`).join(', ')}.`);
  out.push('');
  if (r.mode === 'scan') {
    out.push('| | Findings |', '|---|---|');
    for (const s of SEVERITIES) if (before[s]) out.push(`| ${ICON[s]} ${s} | ${before[s]} |`);
    out.push(`| **total** | **${total(before)}** |`);
  } else {
    out.push(`| | Before | After this branch |`);
    out.push(`|---|---|---|`);
    for (const s of SEVERITIES) if (before[s] || after[s]) out.push(`| ${ICON[s]} ${s} | ${before[s]} | ${after[s]} |`);
    out.push(`| **total** | **${total(before)}** | **${total(after)}** |`);
  }
  out.push('');

  const regressions = r.tests.filter((t) => t.verdict === 'regression');
  if (regressions.length) {
    out.push(`> **⛔ The upgrades broke ${regressions.length} test${regressions.length > 1 ? 's' : ''}.** The changes were not committed; see Tests below.`);
    out.push('');
  }

  out.push(r.mode === 'scan' ? `## Safe upgrades ready (${r.summary.safeFixes})` : `## Fixed in this branch (${r.changes.length})`);
  out.push('');
  if (r.mode === 'scan') {
    const safe = r.findings.filter((f) => f.fix.kind === 'safe');
    if (safe.length) {
      out.push('`patchkit fix` makes these on a branch and runs the tests before and after.', '', '| Where | Package | Version | Severity | How |', '|---|---|---|---|---|');
      for (const f of safe) out.push(`| ${f.component} | ${f.package} | ${f.version} | ${f.severity} | ${esc(f.fix.how)} |`);
    } else out.push('None.');
  } else if (r.changes.length) {
    out.push('Upgrades inside the version ranges the product already allows. Nothing here changes a major version.');
    out.push('');
    out.push('| Where | Package | From | To |');
    out.push('|---|---|---|---|');
    for (const c of r.changes) out.push(`| ${c.component} | ${c.package} | ${c.from} | ${c.to} |`);
  } else out.push('No safe upgrades to make.');
  out.push('');

  out.push('## Tests');
  out.push('');
  if (r.tests.length) {
    out.push('| Test | Before | After | Verdict |');
    out.push('|---|---|---|---|');
    const V: Record<string, string> = { passed: '✅ passed', 'already-failing': '⚠️ was already failing', regression: '⛔ broken by the upgrades', skipped: '— not run' };
    for (const t of r.tests) out.push(`| ${esc(t.name)} | ${t.before} | ${t.after} | ${V[t.verdict]} |`);
    for (const t of r.tests.filter((x) => x.outputTail && x.verdict !== 'passed')) {
      out.push('', `<details><summary>${esc(t.name)}: last lines</summary>`, '', '```', t.outputTail!, '```', '</details>');
    }
  } else if (r.mode === 'scan') out.push('Tests run with `patchkit fix`, before and after the upgrades.');
  else out.push('No tests are listed in patchkit.yml, so nothing checked these upgrades. Add them under `tests:`.');
  out.push('');

  out.push(`## Needs a person: upgrade plans (${r.plans.length})`);
  out.push('');
  if (r.plans.length) {
    out.push('These change a major version or a base image. The agent does not make them; each is a separate piece of work to approve.');
    for (const p of r.plans) {
      out.push('', `### ${ICON[p.severity]} ${esc(p.title)}`, '', `**Why:** ${esc(p.why)}  `, `**Fixes:** ${p.fixes.map((x) => `\`${x}\``).join(', ')}  `);
      if (p.command) out.push(`**How:** ${esc(p.command)}  `);
      if (p.guide) out.push(`**Guide:** ${p.guide}  `);
      if (p.breaking.length) out.push('', '**What changes:**', ...p.breaking.map((b) => `- ${b}`));
      const where = p.whereInCode.filter(Boolean);
      if (where.length) out.push('', `**Used in** (${where.length} file${where.length > 1 ? 's' : ''}): ${where.slice(0, 12).map((w) => `\`${w}\``).join(', ')}${where.length > 12 ? ', …' : ''}`);
    }
  } else out.push('None.');
  out.push('');

  const stuck = r.findings.filter((f) => f.fix.kind === 'none');
  if (stuck.length) {
    out.push(`## No fix published yet (${stuck.length})`, '', '| Where | Package | Version | Severity | Why |', '|---|---|---|---|---|');
    for (const f of stuck) out.push(`| ${f.component} | ${f.package} | ${f.version} | ${f.severity} | ${esc(f.fix.how)} |`);
    out.push('');
  }

  if (r.summary.notChecked.length) {
    out.push('## Not checked', '', ...r.summary.notChecked.map((n) => `- ${n}`), '');
  }

  out.push(`<details><summary>All findings before the fixes (${r.findings.length})</summary>`, '');
  out.push('| Where | Package | Version | Kind | Severity | Advisories | Fix |', '|---|---|---|---|---|---|---|');
  for (const f of r.findings) {
    const adv = f.advisories.slice(0, 3).map((a) => (a.url ? `[${esc(a.id)}](${a.url})` : esc(a.id))).join(', ') + (f.advisories.length > 3 ? ` +${f.advisories.length - 3}` : '');
    out.push(`| ${f.component} | ${f.package}${f.direct ? '' : ' (indirect)'} | ${f.version} | ${f.kind} | ${f.severity} | ${adv} | ${f.fix.kind}: ${esc(f.fix.how)} |`);
  }
  out.push('', '</details>', '');
  out.push(`<sub>patch-kit agent ${r.tool.version} · ${r.environment} · report schema ${r.schema}</sub>`);
  return out.join('\n');
}

export function oneLine(r: Report): string {
  if (r.mode === 'scan') return `${r.product}: ${fmt(r.summary.before)}; ${r.summary.safeFixes} safe fix(es) ready, ${r.plans.length} upgrade plan(s)`;
  if (r.tests.some((t) => t.verdict === 'regression')) return `${r.product}: ${fmt(r.summary.before)}; the upgrades broke a test, so nothing was committed; ${r.plans.length} upgrade plan(s)`;
  if (!r.changes.length) return `${r.product}: ${fmt(r.summary.before)}; no safe upgrades to make; ${r.plans.length} upgrade plan(s)`;
  return `${r.product}: ${fmt(r.summary.before)} → ${fmt(r.summary.after)}; ${r.changes.length} package(s) upgraded on ${r.branch?.name ?? 'a branch'}, ${r.plans.length} upgrade plan(s)`;
}
