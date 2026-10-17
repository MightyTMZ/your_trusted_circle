// Build guard: fails if any path to real emergency services appears in source
// or dependencies. This file holds the denylist and is excluded from its own scan.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SELF = relative(ROOT, __filename);

const EMERGENCY_NUMBER = /(^|[^0-9])(\+?1[- .]?)?(911|112|933)([^0-9]|$)/;
const TELEPHONY_URI = /\b(tel|sip|sips|sms|callto):/i;
const PROVIDER =
  /twilio|vonage|nexmo|plivo|telnyx|bandwidth\.com|sinch|signalwire|messagebird|vapi\.ai|retellai|bland\.ai|rapidsos/i;

const SCAN_DIRS = ['src', 'tests'];
const SCAN_FILES = ['index.html', 'vite.config.ts', 'package.json', 'tsconfig.json'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function sourceFiles(): string[] {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).concat(SCAN_FILES.map((f) => join(ROOT, f)));
  return files.map((f) => relative(ROOT, f)).filter((f) => f !== SELF);
}

describe('no real emergency-contact path', () => {
  it('source contains no emergency numbers, telephony URIs, or telephony providers', () => {
    const hits: string[] = [];
    for (const f of sourceFiles()) {
      readFileSync(join(ROOT, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const [name, re] of [
            ['emergency number', EMERGENCY_NUMBER],
            ['telephony URI', TELEPHONY_URI],
            ['telephony provider', PROVIDER],
          ] as const) {
            if (re.test(line)) hits.push(`${f}:${i + 1} ${name}: ${line.trim().slice(0, 80)}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it('no dependency (direct or transitive) is a telephony or dispatch SDK', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
    const names = Object.keys(lock.packages).map((k) => k.replace(/^.*node_modules\//, ''));
    expect(names.filter((n) => PROVIDER.test(n))).toEqual([]);
  });

  it('the mock operator endpoint is a fixed local constant', async () => {
    const { MOCK_OPERATOR_ENDPOINT } = await import('../src/domain/transport');
    expect(MOCK_OPERATOR_ENDPOINT).toBe('mock://operator.local');
    const src = readFileSync(join(ROOT, 'src/domain/transport.ts'), 'utf8');
    expect(src).not.toMatch(/import\.meta\.env|process\.env/);
  });
});
