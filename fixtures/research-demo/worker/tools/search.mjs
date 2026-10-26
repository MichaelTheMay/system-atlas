import { readFileSync } from 'node:fs';

/** Tool 1: search a local, fake catalog of sources (no network). */
export function search(topic, catalogPath) {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const words = topic.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.sources
    .map((s) => ({ ...s, score: words.filter((w) => `${s.title} ${s.tags.join(' ')}`.toLowerCase().includes(w)).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
