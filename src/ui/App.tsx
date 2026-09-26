import { DebugPage } from './DebugPage';

// Two routes don't justify a router dependency yet; revisit when the editor gets real views.
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/debug') return <DebugPage />;
  return <HomePage />;
}

function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Video Editor</h1>
      <p className="text-neutral-400">
        Free, open-source, in-browser video editor. Your videos never leave this device.
      </p>
      <a
        href="/debug"
        className="inline-flex min-h-11 items-center justify-center rounded-lg bg-neutral-800 px-4 font-medium active:bg-neutral-700"
      >
        Device capability report
      </a>
    </main>
  );
}
