import { useState } from 'react';

export function NewReportPage() {
  const [topic, setTopic] = useState('');
  async function submit() {
    const res = await fetch('/reports', { method: 'POST', body: JSON.stringify({ topic }) });
    const report = await res.json();
    window.location.href = `/reports/${report.id}`;
  }
  return (
    <form onSubmit={(e) => (e.preventDefault(), submit())}>
      <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      <button>Research</button>
    </form>
  );
}
