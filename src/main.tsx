import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { restoreSaved } from './state/persistence';
import { App } from './ui/App';

// Before the first render, so the editor starts with the saved timeline.
restoreSaved();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
