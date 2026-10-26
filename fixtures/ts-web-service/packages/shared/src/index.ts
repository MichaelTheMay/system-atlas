export interface Report {
  id: string;
  topic: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  body?: { summary: string; sources: string[] };
}

export const REPORT_QUEUE = 'report-jobs';
