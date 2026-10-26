#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { barChartPng } from './png.mjs';
import { search } from './tools/search.mjs';
import { summarize } from './tools/summarize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const topic = arg('topic', 'solar storage');
const maxSources = Number(arg('sources', '5'));
const out = arg('out', 'out');

// Optional instrumentation through the documented ingestion protocol (docs/evidence.md). Without the
// ATLAS_* variables this program runs exactly the same and records nothing.
const atlas = process.env.ATLAS_INGEST_URL && process.env.ATLAS_RUN_ID && process.env.ATLAS_RUN_TOKEN;
let seq = 0;
async function record(type, payload) {
  if (!atlas) return;
  const res = await fetch(`${process.env.ATLAS_INGEST_URL}/api/v1/runs/${process.env.ATLAS_RUN_ID}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-run-token': process.env.ATLAS_RUN_TOKEN },
    body: JSON.stringify([{ producerId: `research-worker:${process.pid}`, producerEventId: String(seq), sequence: seq++, type, occurredAt: new Date().toISOString(), payload }]),
  });
  if (!res.ok) console.error(`atlas: could not record ${type}: ${res.status}`);
}

console.log(`researching "${topic}"`);
await record('tool.call.requested', { tool: 'search', input: { topic } });
const found = search(topic, join(here, '..', 'web', 'data', 'catalog.json')).slice(0, maxSources);
await record('tool.call.completed', { tool: 'search', results: found.length });
console.log(`search tool: ${found.length} source(s)`);
if (found.length < 3) console.error(`warning: only ${found.length} source(s) found for "${topic}"`);

await record('tool.call.requested', { tool: 'summarize', input: { sources: found.length } });
const summary = summarize(topic, found);
await record('tool.call.completed', { tool: 'summarize' });

mkdirSync(out, { recursive: true });
const report = { topic, summary, sources: found.map(({ id, title, url, score }) => ({ id, title, url, score })), generatedAt: new Date().toISOString() };
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(out, 'chart.png'), barChartPng(found.map((s) => s.score)));
writeFileSync(
  join(out, 'report.html'),
  `<!doctype html><meta charset="utf-8"><title>${topic}</title><h1>Research: ${topic}</h1><p>${summary}</p><ol>${found.map((s) => `<li>${s.title}</li>`).join('')}</ol>`,
);
console.log(`wrote ${join(out, 'report.json')}, chart.png, report.html`);

await record('assertion.result', { outcome: found.length >= 3 ? 'pass' : 'fail', description: 'report cites at least 3 sources', source: 'test' });
// exit 0 even when the assertion fails: process success and task success are different things
