import { DebugPage } from './DebugPage';
import { ImportPage } from './ImportPage';

// Two routes don't justify a router dependency yet; revisit when the editor gets real views.
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/debug') return <DebugPage />;
  return <ImportPage />;
}
