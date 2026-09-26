import { BenchPage } from './BenchPage';
import { DebugPage } from './DebugPage';
import { EditorPage } from './EditorPage';

// Two routes don't justify a router dependency yet; revisit when the editor gets real views.
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/debug') return <DebugPage />;
  if (path === '/bench') return <BenchPage />;
  return <EditorPage />;
}
