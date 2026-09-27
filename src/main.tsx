import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { restoreSaved } from './state/persistence';
import { App } from './ui/App';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');
const el = root;

// Before the first render, so the editor starts with the saved timeline (a few ms: metadata
// from localStorage plus opening the stored copies in OPFS).
void restoreSaved()
  .catch((err: unknown) => console.warn('[persistence] restore failed', err))
  .finally(() =>
    createRoot(el).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
