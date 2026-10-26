import { describe, expect, it } from 'vitest';
import { redactExcerpt } from '../src/index.ts';

describe('redactExcerpt', () => {
  it.each([
    ['const key = "AKIAIOSFODNN7EXAMPLE";', 'AKIAIOSFODNN7EXAMPLE'],
    ['token: ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['API_KEY=sk-live_1234567890abcdefghijkl', 'sk-live_1234567890abcdefghijkl'],
    ['password = "correct horse"', 'correct'],
    ['url = "https://admin:s3cr3tpw@db.example.com/x"', 's3cr3tpw'],
    ['Authorization: Bearer abcdef0123456789abcdef', 'abcdef0123456789abcdef'],
  ])('removes secrets from %s', (text, secret) => {
    const r = redactExcerpt(text);
    expect(r.redacted).toBe(true);
    expect(r.text).not.toContain(secret);
  });
  it('leaves ordinary code alone', () => {
    const r = redactExcerpt('export function getToken(user: User): string {');
    expect(r).toEqual({ text: 'export function getToken(user: User): string {', redacted: false });
  });
});
