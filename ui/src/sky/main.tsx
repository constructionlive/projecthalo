import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../styles/halo.css';
import { Host } from './Host';

// Esc is the app's "back". Claimed here, so macOS doesn't also take it and
// pull the window out of full screen.
window.addEventListener('keydown', (e) => e.key === 'Escape' && e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Host />
  </StrictMode>,
);
