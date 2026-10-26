/** Tool 2: deterministic "summary" of the selected sources. */
export function summarize(topic, sources) {
  const titles = sources.map((s) => s.title);
  return `${sources.length} source(s) on "${topic}": ${titles.join('; ')}.`;
}
