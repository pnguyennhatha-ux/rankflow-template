import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { resolveSchema } from './data/schema';

const el = document.getElementById('root');
const render = () => el && createRoot(el).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

// Resolve table/field ids by name before first render (falls back to demo mode outside Lark after 8 s).
Promise.race([import('@lark-opdev/block-bitable-api').then(({ bitable }) => resolveSchema(bitable)), new Promise((r) => setTimeout(r, 8000))])
  .catch((e) => console.warn('[rankflow] schema resolve failed', e))
  .finally(render);
