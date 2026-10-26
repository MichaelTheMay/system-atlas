import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type { Report } from '@reports/shared';

export function ReportPage() {
  const { id } = useParams();
  const [report, setReport] = useState<Report>();
  useEffect(() => {
    fetch(`/reports/${id}`).then((r) => r.json()).then(setReport);
  }, [id]);
  return <article>{report?.body?.summary ?? report?.status}</article>;
}
