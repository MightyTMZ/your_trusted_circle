#!/usr/bin/env node
/**
 * YTC guardrail and consistency checks: the deterministic half of the ytc-audit skill.
 *
 *   node .claude/skills/ytc-audit/scripts/guardrail-check.mjs            readable report
 *   node .claude/skills/ytc-audit/scripts/guardrail-check.mjs --json     machine-readable
 *   node .claude/skills/ytc-audit/scripts/guardrail-check.mjs --only hook-behaviour,secrets
 *
 * Read-only: it never edits a file, installs anything or uses the network. It only runs
 * the project's own PreToolUse hook (with made-up payloads) to see that the hook really blocks.
 *
 * Exit code 1 if any check FAILs, so it can also gate CI. Everything it says is a fact it
 * measured. Judgement (is this Date.now() acceptable? does this test prove the rule?) is
 * left to whoever reads the report.
 *
 * It never writes an emergency number, telephony URI or provider name literally: the
 * test payloads are assembled at run time, and the deny-list is read from the project's own
 * build guard (tests/safety-guard.test.ts), so a repository-wide scan of this folder stays clean.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ───────────────────────────── setup ─────────────────────────────

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? new Set(argv[i + 1].split(',')) : null;
})();

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
let ROOT;
try {
  ROOT = git(['rev-parse', '--show-toplevel']).trim();
} catch {
  console.error('Run this inside the YTC git repository.');
  process.exit(2);
}
process.chdir(ROOT);

// Committed files plus new files not yet committed (but not ignored ones): a pre-merge audit
// must see the file someone just added, which is exactly when a forbidden string would slip in.
const tracked = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
const TEXT = /\.(?:[cm]?[jt]sx?|json|css|html|md|sh|ya?ml|svg|txt|py|toml)$/i;
const CODE = /\.(?:[cm]?[jt]sx?|sh|html|css|py|ya?ml)$/i;
const textFiles = tracked.filter((f) => TEXT.test(f) && f !== 'package-lock.json');
const cache = new Map();
const read = (f) => {
  if (!cache.has(f)) {
    try {
      cache.set(f, readFileSync(f, 'utf8'));
    } catch {
      cache.set(f, '');
    }
  }
  return cache.get(f);
};
const lines = (f) => read(f).split(/\r?\n/);
const isComment = (l) => /^\s*(\/\/|\*|\/\*|#)/.test(l);
const join = (...p) => p.join('');
const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cap = (arr, n = 12) => (arr.length > n ? [...arr.slice(0, n), `… and ${arr.length - n} more`] : arr);
const res = (status, summary, details = []) => ({ status, summary, details });

const results = [];
function check(id, title, fn) {
  if (ONLY && !ONLY.has(id)) return;
  let r;
  try {
    r = fn();
  } catch (err) {
    r = res('fail', `The check itself crashed: ${err.message}`);
  }
  results.push({ id, title, ...r });
}

// The project's own deny-list, read from its build guard so the two never drift apart.
const GUARD = 'tests/safety-guard.test.ts';
function guardPatterns() {
  const src = read(GUARD);
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name}\\s*=\\s*(\\/.+\\/[a-z]*);`));
    if (!m) return null;
    const lit = m[1];
    const cut = lit.lastIndexOf('/');
    try {
      return new RegExp(lit.slice(1, cut), lit.slice(cut + 1));
    } catch {
      return null;
    }
  };
  const fromGuard = { number: grab('EMERGENCY_NUMBER'), uri: grab('TELEPHONY_URI'), provider: grab('PROVIDER') };
  const fallback = {
    number: new RegExp(`(^|[^0-9])(\\+?1[- .]?)?(${[join('9', '11'), join('1', '12'), join('9', '33')].join('|')})([^0-9]|$)`),
    uri: new RegExp(`\\b(${join('te', 'l')}|${join('si', 'p')}|${join('s', 'ms')}|${join('call', 'to')}):`, 'i'),
    provider: new RegExp([join('twi', 'lio'), join('tel', 'nyx'), join('pli', 'vo')].join('|'), 'i'),
  };
  return {
    ...Object.fromEntries(Object.entries(fromGuard).map(([k, v]) => [k, v ?? fallback[k]])),
    fromGuard: Boolean(fromGuard.number && fromGuard.uri && fromGuard.provider),
  };
}
const DENY = guardPatterns();

// ───────────────────────── 1. the agent guard really blocks ─────────────────────────

const HOOK = '.claude/hooks/block-emergency-contact.sh';
check('hook-behaviour', 'Agent guard: the PreToolUse hook blocks and allows what it should', () => {
  if (!existsSync(HOOK)) return res('fail', `${HOOK} does not exist. CLAUDE.md names it as the agent guard.`);
  const details = [];
  let status = 'pass';
  const bump = (s) => {
    if (s === 'fail' || (s === 'warn' && status === 'pass')) status = s;
  };

  // A bash script with Windows line endings fails with exit 127 on macOS/Linux, which Claude Code
  // treats as a non-blocking error: the guard would silently stop guarding. Ask git which side has CRLF.
  const eol = git(['ls-files', '--eol', HOOK]).match(/i\/(\S+)\s+w\/(\S+)/);
  const [inIndex, inTree] = eol ? [eol[1], eol[2]] : ['?', '?'];
  if (inIndex === 'crlf') {
    details.push('The COMMITTED hook has CRLF line endings. On macOS/Linux bash fails on it (exit 127) and a failing hook does not block: the guard fails open.');
    bump('fail');
  } else if (inTree === 'crlf') {
    details.push('Only this checkout has CRLF (the commit is LF; core.autocrlf converted it). It works under Git Bash, but the same conversion on any machine that runs the hook through a stricter shell would break it.');
    bump('warn');
  }
  if (!tracked.includes('.gitattributes') || !/\.sh\b[^\n]*eol=lf/.test(read('.gitattributes'))) {
    details.push('No .gitattributes rule pins *.sh to LF, so nothing stops a checkout from turning the hook into CRLF.');
    bump('warn');
  }
  const mode = git(['ls-files', '-s', HOOK]).split(/\s+/)[0];
  if (mode !== '100755') {
    details.push(`Git records the hook with mode ${mode}, not 100755. settings.json runs it directly, so on macOS/Linux a non-executable hook fails open.`);
    bump('warn');
  }

  const bash = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' });
  if (bash.error) {
    details.push('bash is not available here, so the hook could not be exercised.');
    return res(status === 'pass' ? 'skip' : status, 'Could not run the hook (no bash).', details);
  }

  // Run it the way Claude Code does: execute the file itself, so the shebang line counts.
  // (`bash file.sh` would hide a CRLF shebang, which is exactly how this guard can fail open.)
  const run = (input) =>
    spawnSync('bash', ['-c', `"$PWD/${HOOK}"`], { input, encoding: 'utf8', cwd: ROOT, timeout: 15000 });
  const payload = (tool_input) => JSON.stringify({ tool_name: 'Bash', tool_input });
  const number = join('9', '11');
  const cases = [
    // [label, stdin, expected exit code]
    ['emergency number in a command', payload({ command: `echo ${number}` }), 2],
    ['emergency number with a +1 prefix', payload({ command: `echo +1-${number}` }), 2],
    ['the other two emergency numbers', payload({ command: `echo ${join('1', '12')} ${join('9', '33')}` }), 2],
    ['telephony URI', payload({ command: `open ${join('te', 'l')}:+15555550100` }), 2],
    ['SIP URI in a URL field', payload({ url: `${join('si', 'p')}:x@example.test` }), 2],
    ['SMS URI', payload({ command: `open ${join('s', 'ms')}:5555550100` }), 2],
    ['telephony provider in a URL', payload({ url: `https://api.${join('twi', 'lio')}.com/x` }), 2],
    ['number buried in a nested field', payload({ options: { deep: [`x ${number} y`] } }), 2],
    ['unparseable input that contains a number (fails closed)', `not json ${number}`, 2],
    ['ordinary command', payload({ command: 'git status' }), 0],
    ['npm test', payload({ command: 'npm test' }), 0],
    ['digits that merely contain the pattern', payload({ command: `echo ses_19${join('1', '12')}x` }), 0],
    ['valid JSON with no tool input', JSON.stringify({ tool_name: 'Bash' }), 0],
  ];
  const wrong = [];
  for (const [label, input, want] of cases) {
    const r = run(input);
    if (r.error || r.status !== want) {
      wrong.push(`${label}: expected exit ${want}, got ${r.error ? r.error.message : r.status}${r.stderr ? ` (${short(r.stderr.trim(), 70)})` : ''}`);
    }
  }
  if (wrong.length) {
    details.push(...wrong.map((w) => `WRONG: ${w}`));
    bump('fail');
  }
  const brand = read(HOOK).match(/\bY[A-Z]{2}\b(?= safety)/);
  if (brand && brand[0] !== 'YTC') {
    details.push(`The block message calls the product "${brand[0]}", not YTC.`);
    bump('warn');
  }
  details.unshift(`${cases.length - wrong.length}/${cases.length} hook scenarios behaved as expected.`);
  return res(status, status === 'pass' ? 'The hook blocks every forbidden form and lets ordinary calls through.' : status === 'fail' ? 'The hook has problems (see details).' : 'The hook behaves correctly, but has weaknesses (see details).', details);
});

// ───────────────────────── 2. the hook is actually wired in ─────────────────────────

check('hook-wiring', 'Agent guard: registered in settings and covering the risky tools', () => {
  const details = [];
  let status = 'pass';
  if (!tracked.includes('.claude/settings.json')) return res('fail', '.claude/settings.json is not tracked, so the guard is not shared with the team.');
  const files = ['.claude/settings.json', '.claude/settings.local.json'].filter((f) => existsSync(f));
  let registered = null;
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(read(f));
    } catch {
      details.push(`${f} is not valid JSON.`);
      status = 'fail';
      continue;
    }
    if (j.disableAllHooks) {
      details.push(`${f} sets disableAllHooks: the guard is off.`);
      status = 'fail';
    }
    if (f.endsWith('local.json') && j.hooks) details.push(`${f} (untracked) defines hooks and may override the shared ones.`);
    for (const entry of j.hooks?.PreToolUse ?? []) {
      if ((entry.hooks ?? []).some((h) => String(h.command).includes('block-emergency-contact.sh'))) registered = entry.matcher ?? '';
    }
  }
  if (registered === null) return res('fail', 'No PreToolUse entry runs block-emergency-contact.sh.', details);
  let re;
  try {
    re = new RegExp(`^(?:${registered})$`);
  } catch {
    return res('fail', `The matcher "${registered}" is not a valid pattern.`, details);
  }
  const mustCover = ['Bash', 'WebFetch', 'WebSearch', 'mcp__example__tool'];
  const missing = mustCover.filter((t) => !re.test(t));
  if (missing.length) {
    details.push(`The matcher "${registered}" does not cover: ${missing.join(', ')}.`);
    status = 'fail';
  }
  const uncovered = ['Write', 'Edit', 'Agent', 'Skill', 'NotebookEdit'].filter((t) => !re.test(t));
  details.push(`Not covered by the hook (so only the build guard catches them): ${uncovered.join(', ')}.`);
  return res(status, status === 'pass' ? `Registered with matcher "${registered}".` : 'The guard is not fully wired in.', details);
});

// ───────────────────────── 3. the build guard looks everywhere ─────────────────────────

check('guard-scope', 'Build guard: what it scans, and what it misses', () => {
  const src = read(GUARD);
  if (!src) return res('fail', `${GUARD} does not exist. CLAUDE.md requires a test that fails the build.`);
  const list = (name) => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : [];
  };
  const dirs = list('SCAN_DIRS');
  const files = list('SCAN_FILES');
  const details = [`Scans directories: ${dirs.join(', ') || '(none)'}; files: ${files.join(', ') || '(none)'}.`];
  if (!DENY.fromGuard) details.push('Could not read the deny-list from the guard test; used built-in equivalents.');
  const titles = [...src.matchAll(/\bit\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  details.push(`Guard assertions: ${titles.map((t) => `"${t}"`).join('; ') || '(none)'}.`);

  const scanned = (f) => dirs.some((d) => f.startsWith(`${d}/`)) || files.includes(f);
  const unscanned = tracked.filter((f) => TEXT.test(f) && f !== 'package-lock.json' && !scanned(f));
  const tops = new Map();
  for (const f of unscanned) {
    const top = f.includes('/') ? f.split('/')[0] : f;
    tops.set(top, (tops.get(top) ?? 0) + 1);
  }
  const codeTops = [...new Set(unscanned.filter((f) => CODE.test(f)).map((f) => (f.includes('/') ? f.split('/')[0] : f)))];
  if (codeTops.length) details.push(`Code outside the scan: ${codeTops.join(', ')}.`);

  const hits = [];
  for (const f of unscanned) {
    if (f === GUARD || f === HOOK) continue; // the deny-lists themselves (CLAUDE.md excludes them)
    lines(f).forEach((l, i) => {
      for (const [kind, re] of [['emergency number', DENY.number], ['telephony URI', DENY.uri], ['telephony provider', DENY.provider]]) {
        if (re.test(l)) hits.push({ f, i: i + 1, kind, code: CODE.test(f) });
      }
    });
  }
  const codeHits = hits.filter((h) => h.code);
  const docHits = hits.filter((h) => !h.code);
  if (docHits.length) details.push(`Mentions in documentation (expected where a rule is described): ${[...new Set(docHits.map((h) => h.f))].join(', ')}.`);
  for (const h of cap(codeHits, 10)) details.push(`HIT outside the scan: ${h.f}:${h.i} (${h.kind})`);
  const status = codeHits.length ? 'fail' : codeTops.length ? 'warn' : 'pass';
  return res(status, status === 'pass' ? 'The guard covers all code.' : codeHits.length ? 'Forbidden strings exist in code the guard does not scan.' : 'The guard does not scan some code directories (no forbidden strings found there today).', details);
});

// ───────────────────────── 4. mock-only transport ─────────────────────────

check('mock-endpoint', 'Mock-only transport: the operator endpoint is a fixed local constant', () => {
  const details = [];
  let status = 'pass';
  const t = 'src/domain/transport.ts';
  const m = read(t).match(/MOCK_OPERATOR_ENDPOINT\s*=\s*['"]([^'"]+)['"]/);
  if (!m) return res('fail', `${t} does not define MOCK_OPERATOR_ENDPOINT as a string constant.`);
  if (m[1] !== 'mock://operator.local') {
    details.push(`MOCK_OPERATOR_ENDPOINT is "${m[1]}", expected mock://operator.local.`);
    status = 'fail';
  }
  if (/process\.env|import\.meta\.env/.test(read(t))) {
    details.push(`${t} reads the environment.`);
    status = 'fail';
  }
  const mocks = [];
  for (const f of textFiles.filter((x) => x.startsWith('src/'))) lines(f).forEach((l, i) => /mock:\/\//.test(l) && mocks.push(`${f}:${i + 1}`));
  details.push(`mock:// appears at: ${cap(mocks, 8).join(', ') || '(nowhere)'}.`);

  // Environment variables read by the agent and the call routes: only provider credentials are expected.
  const allowed = new Set(['GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
  const used = new Map();
  for (const f of textFiles.filter((x) => x.startsWith('src/agent/') || x.startsWith('src/server/voice/'))) {
    for (const m2 of read(f).matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)|\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) used.set(m2[1] ?? m2[2], f);
  }
  const odd = [...used.keys()].filter((k) => !allowed.has(k));
  details.push(`Environment variables read by the agent and call routes: ${[...used.keys()].join(', ') || '(none)'}.`);
  if (odd.length) {
    details.push(`Unexpected variables there (could they redirect a call?): ${odd.join(', ')}.`);
    if (status === 'pass') status = 'warn';
  }
  const hosts = new Set();
  for (const f of textFiles.filter((x) => x.startsWith('src/agent/') || x.startsWith('src/server/voice/'))) {
    lines(f).forEach((l) => !isComment(l) && [...l.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].forEach((h) => hosts.add(h[1])));
  }
  details.push(`Hosts written into the agent and call code: ${[...hosts].join(', ') || '(none)'}.`);
  return res(status, status === 'pass' ? 'One fixed constant, not configurable from the environment.' : 'See details.', details);
});

// ───────────────────────── 5. no telephony dependency ─────────────────────────

check('telephony-deps', 'No telephony or dispatch SDK among the dependencies', () => {
  const names = new Set();
  try {
    const pkg = JSON.parse(read('package.json'));
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) Object.keys(pkg[k] ?? {}).forEach((n) => names.add(n));
  } catch {
    return res('fail', 'package.json is unreadable.');
  }
  let lockCount = 0;
  if (existsSync('package-lock.json')) {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    for (const k of Object.keys(lock.packages ?? {})) {
      names.add(k.replace(/^.*node_modules\//, ''));
      lockCount++;
    }
  } else {
    return res('warn', 'No package-lock.json, so transitive dependencies could not be checked.');
  }
  const bad = [...names].filter((n) => DENY.provider.test(n));
  return bad.length ? res('fail', `Telephony-like packages: ${bad.join(', ')}`) : res('pass', `${lockCount} locked packages checked; none match the provider deny-list.`);
});

// ───────────────────────── 6. secrets ─────────────────────────

check('secrets', 'No credentials committed; no secret exposed to the browser bundle', () => {
  const details = [];
  let status = 'pass';
  const envFiles = tracked.filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith('.env.example'));
  if (envFiles.length) {
    details.push(`Tracked environment files: ${envFiles.join(', ')}`);
    status = 'fail';
  }
  if (!/^\.env$/m.test(read('.gitignore'))) {
    details.push('.gitignore does not ignore .env.');
    status = 'fail';
  }
  const patterns = [
    ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
    ['OpenAI-style key', /\bsk-[A-Za-z0-9]{20,}/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
    ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
    ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['database URL with a password', /mongodb(?:\+srv)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]{3,}@/],
    ['Google OAuth client id', /\b\d{8,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/],
    ['hard-coded secret assignment', /(?:api[_-]?key|secret|token|passw(?:or)?d)\s*[:=]\s*["'`][A-Za-z0-9_\-/+=]{20,}["'`]/i],
  ];
  const found = [];
  for (const f of textFiles) {
    lines(f).forEach((l, i) => {
      for (const [kind, re] of patterns) {
        const m = l.match(re);
        if (m) found.push(`${f}:${i + 1} ${kind} (${m[0].slice(0, 4)}…, ${m[0].length} chars)`);
      }
    });
  }
  if (found.length) {
    details.push(...cap(found, 12).map((x) => `Possible secret: ${x}`));
    if (status === 'pass') status = 'warn';
  }
  // Variables handed to the browser bundle by the build config.
  const vite = read('vite.config.ts');
  const client = vite.match(/CLIENT_ENV\s*=\s*\[([^\]]*)\]/);
  if (client) {
    const names = [...client[1].matchAll(/['"]([A-Z0-9_]+)['"]/g)].map((m) => m[1]);
    details.push(`Exposed to the browser bundle: ${names.join(', ')}.`);
    const risky = names.filter((n) => /SECRET|TOKEN|PRIVATE|PASSWORD|GEMINI|ELEVENLABS|MONGO|CLIENT_SECRET/.test(n));
    if (risky.length) {
      details.push(`A server-side secret is exposed to the browser: ${risky.join(', ')}`);
      status = 'fail';
    }
  } else if (/import\.meta\.env\.VITE_/.test(textFiles.map(read).join('\n'))) {
    details.push('VITE_-prefixed variables are read by client code; check none is a secret.');
  }
  return res(status, status === 'pass' ? 'No credentials found; only map settings reach the browser.' : 'See details.', details);
});

// ───────────────────────── 7. architecture: layers ─────────────────────────

const LAYER_RULES = {
  // layer: layers it may import. Derived from CLAUDE.md "Keep these components separate".
  shared: ['shared'],
  timeline: ['timeline', 'shared'],
  detector: ['detector', 'timeline', 'shared'],
  sensors: ['sensors', 'timeline', 'detector', 'shared'],
  agent: ['agent', 'timeline', 'shared'],
  server: ['server', 'shared', 'timeline', 'agent'],
  domain: ['domain', 'shared'],
  ui: ['ui', 'domain', 'shared'],
};
const layerOf = (f) => {
  const m = f.match(/^src\/([^/]+)\//);
  return m ? m[1] : f.startsWith('src/') ? 'app' : null;
};
check('layers', 'Architecture: components stay separate (import directions)', () => {
  const bad = [];
  const typeOnly = [];
  let edges = 0;
  for (const f of textFiles.filter((x) => /^src\/.*\.(?:ts|tsx)$/.test(x))) {
    const from = layerOf(f);
    const rule = LAYER_RULES[from];
    if (!rule) continue;
    for (const m of read(f).matchAll(/(?:^|\n)\s*(?:import|export)\b([^;'"]*?)\bfrom\s*(['"])([^'"]+)\2/g)) {
      const spec = m[3];
      if (!spec.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      const to = layerOf(target);
      if (!to || to === 'app') continue;
      edges++;
      if (rule.includes(to)) continue;
      const entry = `${f} → ${target} (${from} must not use ${to})`;
      (/^\s*type\b/.test(m[1]) ? typeOnly : bad).push(entry);
    }
  }
  const details = [`${edges} cross-file imports inside src/ checked against: ${Object.entries(LAYER_RULES).map(([k, v]) => `${k}→{${v.join(',')}}`).join('  ')}.`];
  details.push(...cap(bad, 15).map((b) => `VIOLATION: ${b}`));
  if (typeOnly.length) details.push(`Type-only crossings (compile away, so usually acceptable): ${cap(typeOnly, 6).join('; ')}`);
  details.push('The rules are inferred from CLAUDE.md, not written in it: confirm a violation is real before reporting it as one.');
  return res(bad.length ? 'warn' : 'pass', bad.length ? `${bad.length} import(s) cross a component boundary.` : 'No component imports across a forbidden boundary.', details);
});

// ───────────────────────── 8. one injectable clock ─────────────────────────

check('clock', 'Architecture: one injectable clock for all deadlines', () => {
  const allow = new Set(['src/shared/clock.ts', 'src/domain/clock.ts', 'src/server/main.ts']);
  const core = ['domain', 'timeline', 'agent', 'detector', 'sensors', 'server', 'shared'];
  const hits = [];
  const edge = [];
  const defaults = [];
  for (const f of textFiles.filter((x) => /^src\/.*\.(?:ts|tsx)$/.test(x) && !allow.has(x))) {
    lines(f).forEach((l, i) => {
      if (isComment(l)) return;
      if (!/\bDate\.now\(\)|\bnew Date\(\)|\bperformance\.now\(\)/.test(l)) return;
      if (/clockOffsetMs/.test(l)) return; // the documented offset-clock adapter
      if (/(\?\?|=)\s*\(?\(\)\s*=>\s*(?:new Date\(\)|Date\.now\(\)|performance\.now\(\))/.test(l)) {
        defaults.push(`${f}:${i + 1}`); // default for an injected clock parameter: the injection point itself
        return;
      }
      if (f === 'src/agent/demo.ts') return; // command-line demo timing, not a deadline
      (core.includes(layerOf(f)) ? hits : edge).push(`${f}:${i + 1}  ${short(l.trim(), 70)}`);
    });
  }
  const details = [`Allowed clock sources: ${[...allow].join(', ')} (and lines using clockOffsetMs).`];
  details.push(...cap(hits, 20).map((h) => `Direct clock read in a core layer: ${h}`));
  if (defaults.length) details.push(`Defaults for injected clock parameters (fine, they are the injection points): ${defaults.join(', ')}.`);
  if (edge.length) details.push(`UI/edge clock reads (${edge.length}), e.g. ${edge.slice(0, 3).join(' | ')}`);
  details.push('Decide per line: reading the time for a display or an id is fine; reading it to set or compare a deadline is not.');
  return res(hits.length ? 'warn' : 'pass', hits.length ? `${hits.length} direct clock read(s) in core layers.` : 'Core layers take time only from the injected clock.', details);
});

// ───────────────────────── 9. scenarios feed inputs only ─────────────────────────

check('scenario-forcing', 'Scenario scripts provide inputs; they do not force detector outputs', () => {
  const targets = tracked.filter((f) => /^src\/timeline\/fixtures\/|^src\/domain\/scenarios\.ts$|^src\/ui\/DemoControls\.tsx$|^src\/agent\/demo\.ts$|^src\/sensors\/synthetic\.ts$/.test(f));
  const forbidden = /sensor\.motion_anomaly_observed|sensor\.motion_pattern_observed|sensor\.baseline_calibrated|observations\.push|checkIns\.push|incidents\.push|openIncident\(/;
  const hits = [];
  for (const f of targets) lines(f).forEach((l, i) => !isComment(l) && forbidden.test(l) && hits.push(`${f}:${i + 1}  ${short(l.trim(), 80)}`));
  const details = [`Scenario files read: ${targets.join(', ') || '(none found)'}.`, ...cap(hits, 15)];
  return res(hits.length ? 'warn' : 'pass', hits.length ? `${hits.length} line(s) in scenario code mention detector outputs or incident creation. Read them: is it an input or a forced result?` : 'Scenario files contain no direct detector outputs.', details);
});

// ───────────────────────── 10. front end: tokens ─────────────────────────

check('ui-tokens', 'UI: no hard-coded colours, radii or fonts in components', () => {
  const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;
  const files = tracked.filter((f) => /^src\/ui\/.*\.(?:ts|tsx)$/.test(f) && f !== 'src/ui/theme.ts');
  const perFile = new Map();
  const samples = [];
  const add = (f, i, kind, l) => {
    perFile.set(f, (perFile.get(f) ?? 0) + 1);
    if (samples.length < 14) samples.push(`${f}:${i + 1} ${kind}: ${short(l.trim(), 70)}`);
  };
  for (const f of files) {
    lines(f).forEach((l, i) => {
      if (isComment(l)) return;
      if (hex.test(l) && !/href|location\.hash|replaceState|\.hash\b|#root|#login/.test(l)) add(f, i, 'hex colour', l);
      else if (/\brgba?\(|\bhsla?\(/.test(l)) add(f, i, 'colour function', l);
      if (/borderRadius:\s*\d|fontFamily\s*:/.test(l)) add(f, i, 'radius/font', l);
    });
  }
  // Colours written straight into rules in the stylesheet instead of a --token.
  const css = lines('src/styles.css');
  let cssLoose = 0;
  css.forEach((l, i) => {
    if (/^\s*--/.test(l) || isComment(l)) return;
    if (hex.test(l) || /\brgba?\(/.test(l)) {
      cssLoose++;
      if (samples.length < 14) samples.push(`src/styles.css:${i + 1} colour outside a token: ${short(l.trim(), 70)}`);
    }
  });
  const total = [...perFile.values()].reduce((a, b) => a + b, 0) + cssLoose;
  const details = [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f}: ${n}`);
  if (cssLoose) details.push(`src/styles.css: ${cssLoose} colour value(s) outside --token declarations.`);
  details.push(...samples);
  return res(total ? 'warn' : 'pass', total ? `${total} hard-coded value(s) in ${perFile.size} component file(s) and the stylesheet rules.` : 'Components and rules use tokens only.', details);
});

// Contrast of the text tokens against their backgrounds, per theme.
function parseColor(v) {
  v = v.trim();
  let m = v.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  return null;
}
const over = (fg, bg) => [0, 1, 2].map((i) => Math.round(fg[i] * fg[3] + bg[i] * (1 - fg[3])));
const lum = ([r, g, b]) => {
  const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
function tokenBlocks() {
  const css = read('src/styles.css');
  const block = (re) => {
    const m = css.match(re);
    return m ? Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()])) : null;
  };
  const themes = {};
  const root = block(/(?:^|\n):root\s*\{([\s\S]*?)\n\}/);
  if (root) themes.mono = root;
  for (const m of css.matchAll(/\[data-theme=['"](\w+)['"]\]\s*\{([\s\S]*?)\n\}/g)) {
    themes[m[1]] = { ...(root ?? {}), ...Object.fromEntries([...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()])) };
  }
  return themes;
}
check('ui-contrast', 'UI: text tokens meet contrast in every theme', () => {
  const themes = tokenBlocks();
  const names = Object.keys(themes);
  if (!names.length) return res('skip', 'Could not read the theme tokens from src/styles.css.');
  const pairs = [
    ['--text-primary', '--bg-base'], ['--text-primary', '--surface'],
    ['--text-secondary', '--bg-base'], ['--text-secondary', '--surface'],
    ['--text-tertiary', '--bg-base'], ['--text-tertiary', '--surface'],
    ['--accent-ink', '--accent'], ['--danger-ink', '--danger'],
  ];
  const details = [];
  let worst = 'pass';
  for (const theme of names) {
    const t = themes[theme];
    for (const [fgName, bgName] of pairs) {
      const bg = t[bgName] && parseColor(t[bgName]);
      const fg = t[fgName] && parseColor(t[fgName]);
      if (!bg || !fg) continue;
      const bgSolid = bg.slice(0, 3);
      const r = ratio(over(fg, bgSolid), bgSolid);
      const verdict = r >= 4.5 ? 'ok' : r >= 3 ? 'below 4.5:1 (large text only)' : 'below 3:1';
      if (r < 4.5) worst = r < 3 ? 'fail' : worst === 'fail' ? 'fail' : 'warn';
      details.push(`${theme}: ${fgName} on ${bgName} = ${r.toFixed(2)}:1 ${verdict}`);
    }
  }
  const bad = details.filter((d) => !d.endsWith('ok'));
  return res(worst, bad.length ? `${bad.length} token pair(s) under 4.5:1.` : `All ${details.length} pairs reach 4.5:1 in ${names.join(' and ')}.`, [...bad, `(${details.length - bad.length} pairs ok)`]);
});

check('theme-consistency', 'UI: the themes written in the docs match the themes in the code', () => {
  const m = read('src/ui/theme.ts').match(/THEMES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const code = m ? [...m[1].matchAll(/name:\s*['"]([^'"]+)['"]/g)].map((x) => x[1]) : [];
  if (!code.length) return res('skip', 'Could not read THEMES from src/ui/theme.ts.');
  const details = [`Themes in code: ${code.join(', ')}.`];
  let status = 'pass';
  for (const f of ['CLAUDE.md', 'docs/ui-guidelines.md']) {
    for (const x of read(f).matchAll(/\bthemes?\s*\(([^)]+)\)/gi)) {
      const named = x[1].split(/,|\band\b/).map((s) => s.trim()).filter((s) => /^[A-Z]/.test(s));
      if (!named.length) continue; // e.g. "tinted themes (orange, gold, ...)" is prose, not a list of ours
      const missing = named.filter((n) => !code.includes(n));
      const unmentioned = code.filter((n) => !named.includes(n));
      if (missing.length || unmentioned.length) {
        status = 'warn';
        details.push(`${f} lists (${x[1].trim()}) but code has ${code.join(', ')}.`);
      }
    }
    const words = { two: 2, both: 2, three: 3, four: 4, five: 5 };
    for (const c of read(f).matchAll(/\b(?:all )?(two|three|four|five|both) themes\b/gi)) {
      const n = words[c[1].toLowerCase()];
      details.push(`${f} says "${c[0]}"${n === code.length ? '' : ` but the code has ${code.length}`}.`);
      if (n !== code.length) status = 'warn';
    }
  }
  const themeIds = Object.keys(tokenBlocks()).map((t) => (t === 'mono' ? 'mono (:root)' : t));
  details.push(`Theme token blocks in styles.css: ${themeIds.join(', ')}.`);
  return res(status, status === 'pass' ? 'Docs and code name the same themes.' : 'Docs and code disagree about the themes.', details);
});

// ───────────────────────── 11. documentation and code agree ─────────────────────────

const normPath = (p) =>
  '/' + p.split(/[?#]/)[0].replace(/\$\{[^}]*\}/g, ':p').replace(/:[A-Za-z_]\w*(\{(?:[^{}]|\{[^{}]*\})*\})?/g, ':p').replace(/\/+$/g, '').replace(/^\/+/, '');

function codeRoutes() {
  const app = read('src/server/app.ts');
  const prefixFor = new Map();
  for (const m of app.matchAll(/app\.route\(\s*["']([^"']+)["']\s*,\s*(\w+)\(/g)) prefixFor.set(m[2], m[1]);
  const routes = new Map(); // normalised path → "file (METHOD)"
  const add = (prefix, p, method, f) => {
    if (p === '*' || p === '/*') return;
    const full = normPath(`${prefix}/${p}`.replace(/\/+/g, '/'));
    routes.set(full === '/' ? '/' : full, `${f} (${method})`);
  };
  for (const f of tracked.filter((x) => /^src\/server\/.*\.ts$/.test(x))) {
    const text = read(f);
    let prefix = '';
    for (const m of text.matchAll(/export function (\w+)\(/g)) if (prefixFor.has(m[1])) prefix = prefixFor.get(m[1]);
    if (f === 'src/server/app.ts') prefix = '';
    for (const m of text.matchAll(/\b(?:r|app|router)\.(get|post|patch|put|delete)\(\s*(["'`])([^"'`]+)\2/g)) add(prefix, m[3], m[1].toUpperCase(), f);
    for (const m of text.matchAll(/\b(?:r|app)\.on\(\s*\[([^\]]*)\]\s*,\s*(["'`])([^"'`]+)\2/g)) add(prefix, m[3], m[1].replace(/["'\s]/g, ''), f);
  }
  return routes;
}

check('api-drift', 'Docs and code: every endpoint is documented, and the UI only calls endpoints that exist', () => {
  const code = codeRoutes();
  if (!code.size) return res('skip', 'No routes could be read from src/server.');
  const docText = read('docs/backend.md');
  const docPaths = new Set();
  for (const line of docText.split(/\r?\n/)) {
    let last = null;
    for (const m of line.matchAll(/(\/api\/[A-Za-z0-9_:\-/.{}]+|\.\.\.\/[A-Za-z0-9_:\-]+)/g)) {
      let p = m[1].replace(/[.,)]+$/, '');
      if (p.startsWith('.../')) {
        if (!last) continue;
        p = last.replace(/\/[^/]+$/, '') + p.slice(3);
      }
      last = p;
      docPaths.add(normPath(p));
    }
  }
  const undocumented = [...code.keys()].filter((p) => p.startsWith('/api/') && !docPaths.has(p));
  const missing = [...docPaths].filter((p) => !code.has(p));
  // What the front end calls: string literals shaped like API paths in the two client modules.
  const uiPaths = new Map();
  for (const f of ['src/ui/api.ts', 'src/ui/operator/api.ts', 'src/ui/hooks/useServerSession.tsx']) {
    for (const m of read(f).matchAll(/[`'"](\/(?:api\/)?[a-z][A-Za-z0-9_\-/${}.:]*)[`'"]/g)) {
      const raw = m[1];
      if (raw === '/api' || raw.startsWith('/api${')) continue; // a template that builds the prefix, not a path
      const full = normPath(raw.startsWith('/api/') ? raw : `/api${raw}`);
      if (full !== '/api' && !/\.(?:png|js|css|svg)$/.test(full)) uiPaths.set(full, f);
    }
  }
  const uiOrphans = [...uiPaths.keys()].filter((p) => !code.has(p) && ![...code.keys()].some((c) => c.startsWith(`${p}/`) && c.endsWith('/:p')));
  const details = [`${code.size} routes read from src/server, ${docPaths.size} paths read from docs/backend.md, ${uiPaths.size} paths called by the UI.`];
  details.push(...cap(undocumented, 12).map((p) => `Route not in docs/backend.md: ${p}  [${code.get(p)}]`));
  details.push(...cap(missing, 8).map((p) => `Documented but no matching route: ${p}`));
  details.push(...cap(uiOrphans, 8).map((p) => `UI calls a path with no matching route: ${p}  [${uiPaths.get(p)}]`));
  details.push('Heuristic: paths are compared with parameters collapsed and methods ignored. Confirm each item by reading the route.');
  const n = undocumented.length + missing.length + uiOrphans.length;
  return res(n ? 'warn' : 'pass', n ? `${n} mismatch(es) between routes, docs and the UI.` : 'Routes, docs and UI calls agree.', details);
});

check('env-drift', 'Docs and code: environment variables used vs listed in .env.example', () => {
  const example = new Set([...read('.env.example').matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=/gm)].map((m) => m[1]));
  if (!example.size) return res('warn', 'No .env.example (or it lists nothing).');
  const used = new Map();
  const files = ['vite.config.ts', 'scripts/dev.mjs', ...tracked.filter((f) => /^src\/server\/.*\.ts$/.test(f))];
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)|\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) used.set(m[1] ?? m[2], f);
    for (const m of text.matchAll(/\bpick\(\s*env\s*,([^)]*)\)/g)) for (const q of m[1].matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)) used.set(q[1], f);
    const list = text.match(/CLIENT_ENV\s*=\s*\[([^\]]*)\]/);
    if (list) for (const q of list[1].matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)) used.set(q[1], f);
  }
  const ignore = new Set(['NODE_ENV']);
  const undocumented = [...used.keys()].filter((k) => !example.has(k) && !ignore.has(k));
  const unused = [...example].filter((k) => !used.has(k));
  const details = [`${used.size} variables read in code, ${example.size} listed in .env.example.`];
  details.push(...undocumented.map((k) => `Used but not in .env.example: ${k}  [${used.get(k)}]`));
  details.push(...unused.map((k) => `In .env.example but never read: ${k}`));
  return res(undocumented.length || unused.length ? 'warn' : 'pass', undocumented.length || unused.length ? 'The example environment file and the code disagree.' : 'Every variable is documented and used.', details);
});

check('reference-docs', 'CLAUDE.md: the reference documents exist and nothing important is unlinked', () => {
  const md = read('CLAUDE.md');
  if (!md) return res('fail', 'CLAUDE.md is missing.');
  const links = [];
  for (const m of md.matchAll(/\]\(([^)]+)\)/g)) links.push(m[1]);
  const details = [];
  const broken = [];
  const linkedFiles = new Set();
  for (let l of links) {
    if (/^(https?:|#|mailto:)/.test(l)) continue;
    let p = decodeURIComponent(l.split('#')[0]).replace(/^\.\//, '');
    linkedFiles.add(p);
    if (!existsSync(p)) broken.push(p);
  }
  if (broken.length) details.push(...broken.map((p) => `Linked but missing: ${p}`));
  // Documents CLAUDE.md says it keeps linked.
  const wanted = [
    ['product specification', /spec/i], ['KAZE brief', /kaze/i], ['data schema', /schema|timeline\.md/i], ['evaluation protocol', /eval/i],
  ];
  const linkText = links.join(' ') + ' ' + [...md.matchAll(/\[([^\]]+)\]\(/g)].map((m) => m[1]).join(' ');
  const absent = wanted.filter(([, re]) => !re.test(linkText)).map(([n]) => n);
  if (absent.length) details.push(`CLAUDE.md says it keeps these linked, but no link names: ${absent.join(', ')}.`);
  const docs = tracked.filter((f) => /^docs\/[^/]+\.(?:md|png|svg)$/.test(f));
  const unlinked = docs.filter((f) => !linkedFiles.has(f) && !md.includes(f));
  if (unlinked.length) details.push(`Docs not linked from CLAUDE.md: ${unlinked.join(', ')}.`);
  const readmeLines = lines('README.md').filter((l) => l.trim()).length;
  if (readmeLines < 15) details.push(`README.md has only ${readmeLines} non-empty lines (no setup or run instructions?).`);
  const status = broken.length ? 'fail' : details.length ? 'warn' : 'pass';
  return res(status, status === 'pass' ? 'All reference documents exist and are linked.' : 'Gaps in the reference documents.', details);
});

// ───────────────────────── 12. housekeeping ─────────────────────────

check('naming', 'Naming: the product is YTC everywhere', () => {
  const hits = [];
  // This skill's own files discuss the old name on purpose, so they are not searched.
  for (const f of textFiles.filter((x) => !x.startsWith('.claude/skills/ytc-audit/'))) {
    lines(f).forEach((l, i) => /ypc/i.test(l) && hits.push(`${f}:${i + 1}  ${short(l.trim(), 80)}`));
  }
  return hits.length
    ? res('warn', `${hits.length} leftover "YPC" reference(s). Separate user-visible text (fix) from internal storage keys (renaming drops people's saved state).`, cap(hits, 15))
    : res('pass', 'No "YPC" anywhere.');
});

check('ci', 'Automation: the guardrail tests run on every push', () => {
  const wf = tracked.filter((f) => /^\.github\/workflows\/.*\.ya?ml$/.test(f));
  if (!wf.length) return res('warn', 'No GitHub Actions workflow. The build guard and tests only run if someone remembers to run them.');
  const text = wf.map(read).join('\n');
  const details = [`Workflows: ${wf.join(', ')}.`];
  const runs = (re) => re.test(text);
  if (!runs(/\bnpm (?:run )?test\b|vitest/)) details.push('No step appears to run the test suite.');
  if (!runs(/typecheck|tsc/)) details.push('No step appears to type-check.');
  return res(details.length > 1 ? 'warn' : 'pass', details.length > 1 ? 'CI exists but may skip checks.' : 'CI runs the tests and the type check.', details);
});

check('tests-for-guardrails', 'Each guardrail has a test that would fail if it broke', () => {
  const map = [
    ['no real emergency path (build guard)', /safety-guard/],
    ['wording rules: no "fall", never "safe" (copy guard)', /copy-guard/],
    ['escalation: deadlines, repeats, ack vs resolve', /escalation\.test|safety\.test/],
    ['consent: only your own', /consent\.test|sessions\.test/],
    ['location relay: never stored, consent-filtered', /relay\.test|events\.test/],
    ['voice agent: grounding and red-team', /tests\/agent\/(?:guard|redteam|agent)/],
    ['voice calls: silence, disconnect, failure', /tests\/voice\/calls/],
    ['raw recordings kept apart / provenance', /sensors\.test|timeline\.test|schema\.test/],
  ];
  const testFiles = tracked.filter((f) => /^tests?\/.*\.test\.ts$/.test(f));
  const details = map.map(([label, re]) => `${testFiles.some((f) => re.test(f)) ? 'has a test file' : 'NO TEST FILE'}: ${label}`);
  const missing = details.filter((d) => d.startsWith('NO'));
  details.push(`${testFiles.length} test files in total. A file existing is not proof it covers the rule: read it.`);
  return res(missing.length ? 'warn' : 'pass', missing.length ? `${missing.length} guardrail area(s) have no obvious test file.` : 'Every guardrail area has a test file.', details);
});

// ───────────────────────── report ─────────────────────────

const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
if (AS_JSON) {
  console.log(JSON.stringify({ root: ROOT, counts, results }, null, 2));
} else {
  const tag = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };
  console.log(`YTC guardrail check  (${ROOT})\n`);
  for (const r of results) {
    console.log(`[${tag[r.status] ?? r.status}] ${r.title}  (${r.id})`);
    console.log(`       ${r.summary}`);
    for (const d of r.details) console.log(`         - ${d}`);
    console.log('');
  }
  console.log(`Summary: ${['pass', 'warn', 'fail', 'skip'].map((s) => `${counts[s] ?? 0} ${s}`).join(', ')}`);
}
process.exit(counts.fail ? 1 : 0);
