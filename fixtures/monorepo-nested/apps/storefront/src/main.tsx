import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { CheckoutPage } from './pages/Checkout.tsx';
import { ProductsPage } from './pages/Products.tsx';

const router = createBrowserRouter([
  { path: '/', element: <ProductsPage /> },
  { path: '/checkout', element: <CheckoutPage /> },
]);

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
