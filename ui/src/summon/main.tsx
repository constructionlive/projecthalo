import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../styles/halo.css';
import { Summon } from './Summon';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Summon />
  </StrictMode>,
);
