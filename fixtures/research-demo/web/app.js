// Local-only search over fake data: no network beyond this page's own files.
document.getElementById('search').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const topic = document.getElementById('topic').value.trim().toLowerCase();
  const { sources } = await (await fetch('data/catalog.json')).json();
  const words = topic.split(/\s+/).filter(Boolean);
  const hits = sources.filter((s) => words.some((w) => `${s.title} ${s.tags.join(' ')}`.toLowerCase().includes(w)));
  const results = document.getElementById('results');
  results.innerHTML = hits.length
    ? `<h2>${hits.length} result(s)</h2><ol>${hits.map((s) => `<li data-id="${s.id}">${s.title}</li>`).join('')}</ol>`
    : '<p class="empty">No results.</p>';
});
