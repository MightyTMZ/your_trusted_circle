// Wording guard for UI copy and domain messages shown to people.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(SRC).filter((f) => /\.(tsx?|css)$/.test(f));

function scan(re: RegExp): string[] {
  return files.flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .flatMap((line, i) => (re.test(line) ? [`${f.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`] : [])),
  );
}

describe('UI wording', () => {
  it('never describes motion as a fall', () => {
    expect(scan(/\bfall(s|en|ing)?\b|fall detected/i)).toEqual([]);
  });

  it('never implies a person is safe', () => {
    expect(scan(/\b(is|are|they're|they are|you're|marked|now|confirmed|feel)\s+safe\b|\bsafe now\b|\bmark(ed)? (as )?safe\b/i)).toEqual(
      [],
    );
  });

  it('labels emergency services as simulated wherever they are named in copy', () => {
    const lines = scan(/emergency services/i).filter((l) => !/simulated/i.test(l));
    expect(lines).toEqual([]);
  });
});
