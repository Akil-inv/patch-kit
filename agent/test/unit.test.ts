import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { eolStatus, lineOf } from '../src/eol';
import { findImages, parseImage, scanImages } from '../src/ecosystems/images';
import { checkModules } from '../src/ecosystems/modules';
import { allows, requirementOf } from '../src/ecosystems/pip';
import { loadManifest } from '../src/manifest';
import { makePlans } from '../src/plans';
import { count, toMarkdown } from '../src/report';
import { compare, summarise } from '../src/tests';
import { Finding, Report } from '../src/types';
import { compareVersions, sameMajor } from '../src/util';

const dir = () => mkdtempSync(join(tmpdir(), 'pk-'));
const day = new Date('2026-10-04T00:00:00Z');

describe('versions', () => {
  it('compares', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('v2.0', '2.0.0')).toBe(0);
    expect(compareVersions('0.38.6', '0.40.0')).toBe(-1);
  });
  it('treats a 0.x minor as a major (semver)', () => {
    expect(sameMajor('4.1.0', '4.9.2')).toBe(true);
    expect(sameMajor('4.1.0', '5.0.0')).toBe(false);
    expect(sameMajor('0.115.0', '0.115.4')).toBe(true);
    expect(sameMajor('0.115.0', '0.133.0')).toBe(false);
  });
});

describe('end of life', () => {
  it('finds the line from an image tag', () => {
    expect(lineOf('node', '20-bookworm-slim')).toBe('20');
    expect(lineOf('python', '3.11-slim')).toBe('3.11');
    expect(lineOf('python', '3.1')).toBe(null);
    expect(lineOf('postgres', '16-alpine')).toBe('16');
  });
  it('knows what has ended', () => {
    expect(eolStatus('node', '20', day)).toMatchObject({ ended: true, latest: '24' });
    expect(eolStatus('node', '22', day)).toMatchObject({ ended: false });
    expect(eolStatus('python', '3.10', day)!.daysLeft).toBe(27);
  });
});

describe('images', () => {
  it('reads Dockerfiles (skipping build stages) and compose files', () => {
    const d = dir();
    mkdirSync(join(d, 'api'));
    writeFileSync(join(d, 'api/Dockerfile'), 'FROM node:20-slim AS build\nRUN x\nFROM build AS dev\nFROM --platform=linux/amd64 node:20-slim\nFROM ${BASE}\n');
    writeFileSync(join(d, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:13-alpine\n  web:\n    image: nginx:alpine\n  x:\n    build: .\n');
    const refs = findImages(d, ['api/Dockerfile', 'docker-compose.yml']);
    expect(refs.map((r) => `${r.image}@${r.file}:${r.line}`)).toEqual([
      'node:20-slim@api/Dockerfile:1', 'node:20-slim@api/Dockerfile:4', 'postgres:13-alpine@docker-compose.yml:3', 'nginx:alpine@docker-compose.yml:5',
    ]);
  });
  it('parses registry ports and digests', () => {
    expect(parseImage('registry.local:5000/team/app:1.2@sha256:abc')).toEqual({ name: 'registry.local:5000/team/app', tag: '1.2' });
    expect(parseImage('registry.local:5000/team/app')).toEqual({ name: 'registry.local:5000/team/app', tag: 'latest' });
  });
  it('reports ended images, moving tags, and that OS packages were not checked', async () => {
    const r = await scanImages('/', [
      { image: 'postgres:13-alpine', name: 'postgres', tag: '13-alpine', file: 'c.yml', line: 3 },
      { image: 'nginx:alpine', name: 'nginx', tag: 'alpine', file: 'c.yml', line: 5 },
    ], day);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].fix).toMatchObject({ kind: 'major', to: 'postgres:17-alpine' });
    expect(r.notChecked.join(' ')).toMatch(/nginx:alpine/);
    expect(r.notChecked.join(' ')).toMatch(/Trivy/);
  });
});

describe('pip requirement specs', () => {
  it('reads a parent requirement', () => {
    expect(requirementOf(['starlette<0.39.0,>=0.37.2', 'pydantic>=1.7'], 'Starlette')).toBe('starlette<0.39.0,>=0.37.2'.slice(9));
    expect(requirementOf(['httpx>=0.23; extra == "all"'], 'httpx')).toBe(null);
  });
  it('checks a version against a spec', () => {
    expect(allows('<0.39.0,>=0.37.2', '0.40.0')).toBe(false);
    expect(allows('<0.49.0,>=0.40.0', '0.40.0')).toBe(true);
    expect(allows('==0.4.*', '0.4.9')).toBe(true);
  });
});

describe('manifest', () => {
  it('says what to fix', () => {
    const d = dir();
    writeFileSync(join(d, 'patchkit.yml'), 'environment: offline\ncomponents: [missing]\n');
    expect(() => loadManifest(d)).toThrow(/product:[\s\S]*environment:[\s\S]*missing/);
  });
  it('detects ecosystems and fills defaults', () => {
    const d = dir();
    mkdirSync(join(d, 'api'));
    mkdirSync(join(d, 'py'));
    writeFileSync(join(d, 'api/package.json'), '{}');
    writeFileSync(join(d, 'py/requirements.txt'), 'x==1\n');
    writeFileSync(join(d, 'patchkit.yml'), 'product: p\ncomponents: [api/, py]\ntests: ["npm test"]\n');
    const m = loadManifest(d);
    expect(m.components).toEqual([{ path: 'api', ecosystem: 'npm' }, { path: 'py', ecosystem: 'pip' }]);
    expect(m.tests).toEqual([{ name: 'npm test', run: 'npm test', timeoutMinutes: 30 }]);
    expect(m.environment).toBe('connected');
  });
});

describe('our own modules', () => {
  const index = { modules: { '@akil-inv/auth-kit': { latest: '0.2.1', advisories: [{ id: 'AK-1', title: 'old mailer', below: '0.2.1', severity: 'high' as const }] } } };
  it('flags an affected version', () => {
    const f = checkModules('api', new Map([['@akil-inv/auth-kit', '0.2.0'], ['left-pad', '1.0.0']]), '@akil-inv/', index);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'high', kind: 'vulnerability', fix: { kind: 'safe' } });
  });
  it('is quiet when current', () => {
    expect(checkModules('api', new Map([['@akil-inv/auth-kit', '0.2.1']]), '@akil-inv/', index)).toEqual([]);
  });
});

const finding = (p: Partial<Finding>): Finding => ({
  component: 'apps/api', ecosystem: 'npm', package: 'x', version: '1.0.0', severity: 'moderate', kind: 'vulnerability',
  advisories: [{ id: 'GHSA-1', title: 't' }], direct: true, fix: { kind: 'none', how: '-' }, ...p,
});

describe('plans', () => {
  it('merges an advisory, an end-of-life date and a deprecation into one plan with a concrete version', async () => {
    const fs = [
      finding({ package: '@apollo/server', kind: 'end-of-life', severity: 'high', advisories: [{ id: 'eol', title: 'ended' }], fix: { kind: 'major', package: '@apollo/server', to: '5.x', how: 'a' } }),
      finding({ package: '@apollo/server', fix: { kind: 'major', package: '@apollo/server', to: '5.5.1', how: 'b' } }),
      finding({ package: '@apollo/server', kind: 'deprecated', severity: 'low', fix: { kind: 'major', package: '@apollo/server', to: 'latest', how: 'c' } }),
      finding({ package: 'qs', fix: { kind: 'safe', how: 'npm audit fix' } }),
    ];
    const plans = await makePlans('/nonexistent', fs, () => '4.13.0');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ to: '5.5.1', severity: 'high', from: '4.13.0', title: 'Apollo Server 4.13.0 → 5.5.1 (apps/api)' });
    expect(plans[0].why).toMatch(/advisory[\s\S]*ended[\s\S]*deprecated/);
  });
});

describe('test verdicts', () => {
  const tests = [{ name: 'a', run: 'a' }, { name: 'b', run: 'b' }, { name: 'c', run: 'c' }, { name: 'd', run: 'd' }];
  const o = (s: 'passed' | 'failed') => ({ status: s, output: s, seconds: 1 });
  it('tells a regression from a test that was already failing', () => {
    const before = new Map([['a', o('passed')], ['b', o('failed')], ['c', o('passed')], ['d', o('failed')]]);
    const after = new Map([['a', o('passed')], ['b', o('failed')], ['c', o('failed')], ['d', o('passed')]]);
    expect(compare(tests, before, after).map((t) => t.verdict)).toEqual(['passed', 'already-failing', 'regression', 'passed']);
  });
  it('keeps the failure lines and drops colour codes', () => {
    const s = summarise('\x1b[31mFAIL src/a.spec.ts\x1b[39m\n' + Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'));
    expect(s.startsWith('FAIL src/a.spec.ts')).toBe(true);
    expect(s).not.toMatch(/\x1b/);
    expect(s).toMatch(/line 49$/);
  });
});

describe('report', () => {
  it('renders a fix report', () => {
    const findings = [finding({ severity: 'critical' }), finding({ package: 'qs', fix: { kind: 'safe', how: 'npm audit fix' } })];
    const r: Report = {
      schema: 1, tool: { name: 'patch-kit-agent', version: '0' }, product: 'demo', environment: 'connected', mode: 'fix', ranAt: '2026-10-04T00:00:00Z',
      components: [{ path: 'apps/api', ecosystem: 'npm', packages: 3 }], findings, plans: [], changes: [{ component: 'apps/api', package: 'qs', from: '6.1', to: '6.2' }],
      tests: [{ name: 'unit', run: 'x', before: 'passed', after: 'failed', verdict: 'regression', outputTail: 'boom' }],
      summary: { before: count(findings), after: count(findings.slice(0, 1)), safeFixes: 1, plans: 0, notChecked: ['images'] },
    };
    const md = toMarkdown(r);
    expect(md).toMatch(/\| \*\*total\*\* \| \*\*2\*\* \| \*\*1\*\* \|/);
    expect(md).toMatch(/broke 1 test/);
    expect(md).toMatch(/\| apps\/api \| qs \| 6.1 \| 6.2 \|/);
    expect(md).toMatch(/## Not checked\n\n- images/);
  });
});
