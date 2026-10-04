import { compareVersions } from './util';

/**
 * End-of-life dates the agent knows without the internet. Air-gapped sites
 * get updates to this table in the cyclic bundle; connected sites get them
 * with each agent release. Dates are the end of security support.
 */
export const EOL: Record<string, Record<string, string>> = {
  node: { '16': '2023-09-11', '18': '2025-04-30', '20': '2026-04-30', '22': '2027-04-30', '24': '2028-04-30' },
  python: { '3.8': '2024-10-07', '3.9': '2025-10-31', '3.10': '2026-10-31', '3.11': '2027-10-31', '3.12': '2028-10-31', '3.13': '2029-10-31' },
  postgres: { '12': '2024-11-21', '13': '2025-11-13', '14': '2026-11-12', '15': '2027-11-11', '16': '2028-11-09', '17': '2029-11-08' },
  '@apollo/server': { '4': '2026-01-26' },
};

/** The newest supported line for each, used to suggest where to move. */
export const LATEST_LINE: Record<string, string> = { node: '24', python: '3.13', postgres: '17', '@apollo/server': '5' };

export type EolStatus = { line: string; ends: string; ended: boolean; daysLeft: number; latest?: string };

/** "20-bookworm-slim" → line "20"; "3.11-slim" → "3.11"; "16-alpine" → "16". */
export function lineOf(product: string, version: string): string | null {
  const table = EOL[product];
  if (!table) return null;
  const v = version.replace(/^v/, '');
  // The longest line that the version starts with ("3.11" beats "3.1").
  const lines = Object.keys(table).sort((a, b) => b.length - a.length);
  return lines.find((l) => v === l || v.startsWith(l + '.') || v.startsWith(l + '-')) ?? null;
}

export function eolStatus(product: string, version: string, today = new Date()): EolStatus | null {
  const line = lineOf(product, version);
  if (!line) return null;
  const ends = EOL[product][line];
  const daysLeft = Math.floor((Date.parse(ends) - today.getTime()) / 86_400_000);
  const latest = LATEST_LINE[product];
  return { line, ends, ended: daysLeft < 0, daysLeft, latest: latest && compareVersions(latest, line) > 0 ? latest : undefined };
}

const RUNTIMES = new Set(['node', 'python', 'postgres']);

/** Libraries in the EOL table (e.g. @apollo/server 4) found among installed packages. */
export function eolPackages(component: string, ecosystem: 'npm' | 'pip', installed: Map<string, string>, direct: Set<string>, today = new Date()) {
  const out: import('./types').Finding[] = [];
  for (const name of Object.keys(EOL)) {
    if (RUNTIMES.has(name)) continue;
    const version = installed.get(name);
    if (!version) continue;
    const s = eolStatus(name, version.split('.')[0], today);
    if (!s || s.daysLeft > 180) continue;
    out.push({
      component, ecosystem, package: name, version, kind: 'end-of-life', direct: direct.has(name),
      severity: s.ended ? 'high' : 'moderate',
      advisories: [{ id: `eol:${name}@${s.line}`, title: s.ended ? `${name} ${s.line} stopped getting security fixes on ${s.ends}` : `${name} ${s.line} stops getting security fixes on ${s.ends} (${s.daysLeft} days)` }],
      fix: s.latest ? { kind: 'major', package: name, to: `${s.latest}.x`, how: `upgrade ${name} to ${s.latest}` } : { kind: 'none', how: 'no supported line is known' },
    });
  }
  return out;
}
