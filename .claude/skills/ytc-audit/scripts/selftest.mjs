#!/usr/bin/env node
/**
 * Self-test for guardrail-check.mjs: breaks the repository on purpose, one thing at a time,
 * and confirms the checker notices. An audit that cannot fail proves nothing.
 *
 *   node .claude/skills/ytc-audit/scripts/selftest.mjs
 *
 * It works on a throwaway clone under the system temp folder; your working tree is never touched.
 * Forbidden strings are assembled at run time so this file stays clean under a repository scan.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(here, 'guardrail-check.mjs');
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const j = (...p) => p.join('');

const work = mkdtempSync(path.join(tmpdir(), 'ytc-audit-selftest-'));
const clone = path.join(work, 'repo');
execFileSync('git', ['clone', '--quiet', root, clone], { stdio: 'pipe' });

const file = (f) => path.join(clone, f);
const edit = (f, fn) => writeFileSync(file(f), fn(readFileSync(file(f), 'utf8')));
const restore = () => execFileSync('git', ['checkout', '--quiet', '--', '.'], { cwd: clone });
const runChecker = () => {
  const r = spawnSync('node', [CHECKER, '--json'], { cwd: clone, encoding: 'utf8', maxBuffer: 1 << 26 });
  return Object.fromEntries(JSON.parse(r.stdout).results.map((x) => [x.id, { status: x.status, report: JSON.stringify([x.summary, x.details]) }]));
};

// [what we break, [file edits], check that must react, status it must reach]
const mutations = [
  ['the hook stops blocking (exits 0 always)', () => writeFileSync(file('.claude/hooks/block-emergency-contact.sh'), '#!/usr/bin/env bash\nexit 0\n'), 'hook-behaviour', 'fail'],
  ['the hook matcher no longer covers web tools', () => edit('.claude/settings.json', (s) => s.replace('Bash|WebFetch|WebSearch|mcp__.*', 'Bash')), 'hook-wiring', 'fail'],
  ['all hooks are switched off in settings', () => edit('.claude/settings.json', (s) => s.replace('{', '{ "disableAllHooks": true,')), 'hook-wiring', 'fail'],
  ['an emergency number lands in a directory the build guard skips', () => edit('test/server/helpers.ts', (s) => `${s}\nexport const bad = "call ${j('9', '11')}";\n`), 'guard-scope', 'fail'],
  ['a telephony package is added as a dependency', () => edit('package.json', (s) => s.replace('"dependencies": {', `"dependencies": {\n    "${j('twi', 'lio')}": "^5.0.0",`)), 'telephony-deps', 'fail'],
  ['the mock operator endpoint becomes configurable', () => edit('src/domain/transport.ts', (s) => s.replace(/MOCK_OPERATOR_ENDPOINT = '[^']+'/, "MOCK_OPERATOR_ENDPOINT = process.env.OP ?? 'mock://operator.local'")), 'mock-endpoint', 'fail'],
  ['a server secret is exposed to the browser bundle', () => edit('vite.config.ts', (s) => s.replace("'DEMO_VENUE'", "'DEMO_VENUE', 'GEMINI_API_KEY'")), 'secrets', 'fail'],
  ['an API key is committed in source', () => edit('src/ui/copy.ts', (s) => `${s}\nconst k = "AIza${'A'.repeat(35)}";\n`), 'secrets', 'warn'],
  ['the domain layer imports from the server', () => edit('src/domain/session.ts', (s) => `import { loadConfig } from '../server/config';\n${s}`), 'layers', 'warn'],
  ['a deadline reads the wall clock directly', () => edit('src/domain/incident.ts', (s) => `${s}\nconst sneaky = Date.now() + 60000;\n`), 'clock', 'warn'],
  ['a component hard-codes a colour', () => edit('src/ui/screens/StartScreen.tsx', (s) => s.replace('<div className="logo"', '<div style={{ color: "#ff0000" }} className="logo"')), 'ui-tokens', 'warn'],
  ['secondary text becomes unreadable in the light theme', () => edit('src/styles.css', (s) => s.replace(/(\[data-theme='onyx'\]\s*\{[\s\S]*?--text-secondary:\s*)[^;]+;/, '$1#d0d0d0;')), 'ui-contrast', 'fail'],
  ['a route is renamed without touching docs or the UI', () => edit('src/server/safety/routes.ts', (s) => s.replace('"/sessions/:id/help"', '"/sessions/:id/help-now"')), 'api-drift', 'warn'],
  ['the old product name comes back', () => edit('README.md', (s) => `${s}\nYPC\n`), 'naming', 'warn'],
  ['code reads an undocumented environment variable', () => edit('src/server/config.ts', (s) => `${s}\nexport const NEW_FLAG = process.env.BRAND_NEW_FLAG;\n`), 'env-drift', 'warn'],
];

let failures = 0;
try {
  restore();
  const baseline = runChecker();
  const baseFails = Object.entries(baseline).filter(([, v]) => v.status === 'fail');
  console.log(`Baseline (unmodified clone): ${baseFails.length ? `FAILING already: ${baseFails.map(([k]) => k).join(', ')}` : 'no failing checks'}\n`);
  const rank = { pass: 0, skip: 0, warn: 1, fail: 2 };
  for (const [name, apply, id, want] of mutations) {
    restore();
    apply();
    const after = runChecker();
    const got = after[id]?.status;
    const before = baseline[id]?.status;
    // Caught = the check reaches the expected severity AND its report changed because of our breakage.
    // (Several checks already warn on the real repo, so the status alone cannot rise.)
    const changed = after[id]?.report !== baseline[id]?.report;
    const ok = got !== undefined && rank[got] >= rank[want] && changed;
    if (!ok) failures++;
    console.log(`${ok ? 'CAUGHT ' : 'MISSED '} ${name}\n         ${id}: ${before} -> ${got}${changed ? ', report changed' : ', report UNCHANGED'} (needed ${want} or worse)`);
  }
} finally {
  restore();
  if (path.resolve(work).startsWith(path.resolve(tmpdir()))) rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}
console.log(`\n${mutations.length - failures}/${mutations.length} deliberate breakages were caught.`);
process.exit(failures ? 1 : 0);
