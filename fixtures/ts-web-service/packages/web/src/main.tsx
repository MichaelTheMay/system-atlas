import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { NewReportPage } from './pages/NewReport.tsx';
import { ReportPage } from './pages/Report.tsx';

const router = createBrowserRouter([
  { path: '/', element: <NewReportPage /> },
  { path: '/reports/:id', element: <ReportPage /> },
]);

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
