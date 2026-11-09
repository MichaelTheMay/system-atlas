import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { OrderPage } from './pages/Order.tsx';

const router = createBrowserRouter([{ path: '/admin/orders/:id', element: <OrderPage /> }]);

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
