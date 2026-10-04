/**
 * What the agent reads (the product's patchkit.yml) and what it writes (the
 * report). The report is also what the registry receives, so its shape is
 * versioned: change it only by adding fields.
 */

export type Ecosystem = 'npm' | 'pip';

export type Manifest = {
  product: string;
  owner?: string;
  environment: 'connected' | 'air-gapped';
  components: { path: string; ecosystem?: Ecosystem }[];
  /** docker-compose files and Dockerfiles whose images are checked. */
  images?: string[];
  /** Test commands, run from the repository root before and after the upgrades. */
  tests?: { name?: string; run: string; timeoutMinutes?: number }[];
  /** Where our own modules' latest versions are listed (a path or URL to modules.json). */
  modules?: string;
  /** Prefix of our own packages, e.g. "@akil-inv/". */
  modulePrefix?: string;
  /** How this product's deploy puts back the previous release (shown in every upgrade PR). */
  deploy?: { rollback?: string };
};

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unrated';
export const SEVERITIES: Severity[] = ['critical', 'high', 'moderate', 'low', 'unrated'];

export type Advisory = { id: string; title: string; url?: string; aliases?: string[] };

/** How a finding gets fixed. */
export type Fix =
  | { kind: 'safe'; how: string }                                   // within the allowed range: the agent does it
  | { kind: 'major'; package: string; to: string; how: string }      // needs a person: an upgrade plan
  | { kind: 'none'; how: string };                                   // no fixed version where we get packages

export type Finding = {
  component: string;          // "apps/api", or "images", or "modules"
  ecosystem: Ecosystem | 'image' | 'module';
  package: string;
  version: string;
  severity: Severity;
  kind: 'vulnerability' | 'end-of-life' | 'deprecated' | 'outdated-module';
  advisories: Advisory[];
  direct: boolean;
  fix: Fix;
  note?: string;
};

export type Change = { component: string; package: string; from: string; to: string };

export type Plan = {
  id: string;                 // "npm:next@16.3.8"
  title: string;              // "Next.js 14.2.35 → 16.3.8"
  component: string;
  package: string;
  from: string;
  to: string;
  severity: Severity;         // the worst finding it fixes
  fixes: string[];            // packages whose findings it clears
  why: string;
  breaking: string[];
  guide?: string;
  whereInCode: string[];      // files that import the package
  command?: string;
};

export type TestRun = {
  name: string;
  run: string;
  before: 'passed' | 'failed' | 'skipped';
  after: 'passed' | 'failed' | 'skipped';
  /** passed: fine. already-failing: failed before the upgrades too. regression: the upgrades broke it. */
  verdict: 'passed' | 'already-failing' | 'regression' | 'skipped';
  outputTail?: string;
  seconds?: number;
};

export type Counts = Record<Severity, number>;

export type Report = {
  schema: 1;
  tool: { name: 'patch-kit-agent'; version: string };
  product: string;
  owner?: string;
  environment: Manifest['environment'];
  /** scan: report only. fix: the agent tried the safe upgrades. */
  mode: 'scan' | 'fix';
  /** From patchkit.yml deploy.rollback: how to put back the previous release on a server. */
  rollbackHow?: string;
  ranAt: string;
  git?: { commit: string; branch: string };
  components: { path: string; ecosystem: Ecosystem; packages: number }[];
  findings: Finding[];
  plans: Plan[];
  changes: Change[];
  tests: TestRun[];
  branch?: { name: string; pushed: boolean; pullRequest?: string };
  summary: { before: Counts; after: Counts; safeFixes: number; plans: number; notChecked: string[] };
};
