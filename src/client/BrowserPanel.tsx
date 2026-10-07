import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Globe,
  Hand,
  RotateCw,
} from 'lucide-react';
import { api, authHeaders } from './api';

interface Frame {
  data: string;
  url: string;
  width: number;
  height: number;
  takeover: boolean;
}
interface Status {
  running: boolean;
  url: string;
  title: string;
  takeover: boolean;
}
const specialKeys = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

// Live view of the Dots' own browser. The owner can watch the agent, navigate,
// and take control (their clicks, scrolling and typing go to the page while the
// agent's browser tools wait), then hand control back.
export function BrowserPanel() {
  const [status, setStatus] = useState<Status>();
  const [frame, setFrame] = useState<Frame>();
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [error, setError] = useState('');
  const wheel = useRef(0);
  const takeover = frame?.takeover ?? status?.takeover ?? false;

  const refresh = () =>
    api<Status>('/browser/status')
      .then(setStatus)
      .catch(() => undefined);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!editing && frame?.url) setAddress(frame.url);
  }, [frame?.url, editing]);

  // Frames arrive as server-sent events over fetch (so auth headers apply).
  useEffect(() => {
    if (!status?.running) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/browser/stream', {
          headers: authHeaders(),
          signal: controller.signal,
        });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = chunk
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (data) setFrame(JSON.parse(data) as Frame);
          }
        }
      } catch {
        // Stream closed (tab hidden, browser closed or server restart).
      }
    })();
    return () => controller.abort();
  }, [status?.running]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Browser action failed.');
    } finally {
      setBusy(false);
    }
  };
  const send = (event: Record<string, unknown>) =>
    api('/browser/input', 'POST', event).catch((e) =>
      setError(e instanceof Error ? e.message : 'Input failed.'),
    );
  const point = (event: React.MouseEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * (frame?.width ?? 0),
      y: ((event.clientY - box.top) / box.height) * (frame?.height ?? 0),
    };
  };
  // Some sign-ins (e.g. Google) refuse any remotely controlled browser. This
  // opens the same profile in a plain window; logins carry over to the Dots.
  const signIn = (
    <div className="browser-signin">
      {signInOpen ? (
        <span>
          A plain Chrome window opened on the Dots&apos; profile. Sign in there,
          close that window, then start the browser again.
        </span>
      ) : (
        <>
          <span>Site won&apos;t let you sign in here?</span>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api('/browser/signin', 'POST', {
                  url:
                    address && !address.startsWith('about:')
                      ? address
                      : 'https://accounts.google.com',
                });
                setSignInOpen(true);
              })
            }
          >
            Sign in normally
          </button>
        </>
      )}
    </div>
  );
  if (!status) return <p className="computer-panel">Checking the browser…</p>;
  if (!status.running)
    return (
      <div className="browser-panel browser-empty">
        <Globe size={28} />
        <p>
          Your Dots have their own browser window. Start it here, or ask a Dot
          with the Web browser tool to open a site.
        </p>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void run(() =>
              api('/browser/start', 'POST', { url: 'https://duckduckgo.com' }),
            )
          }
        >
          {busy ? 'Starting…' : 'Start browser'}
        </button>
        {signIn}
        {error && <p className="chat-error">{error}</p>}
      </div>
    );

  return (
    <div className="browser-panel">
      <form
        className="browser-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          void run(() => api('/browser/navigate', 'POST', { url: address }));
        }}
      >
        <button
          type="button"
          className="icon-button"
          aria-label="Back"
          onClick={() =>
            void run(() => api('/browser/navigate', 'POST', { action: 'back' }))
          }
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Forward"
          onClick={() =>
            void run(() =>
              api('/browser/navigate', 'POST', { action: 'forward' }),
            )
          }
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Reload"
          onClick={() =>
            void run(() =>
              api('/browser/navigate', 'POST', { action: 'reload' }),
            )
          }
        >
          <RotateCw size={15} />
        </button>
        <input
          aria-label="Address"
          value={address}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button
          type="button"
          className={`browser-control ${takeover ? 'owner' : ''}`}
          onClick={() =>
            void run(() => api('/browser/takeover', 'POST', { on: !takeover }))
          }
        >
          {takeover ? <Bot size={14} /> : <Hand size={14} />}
          {takeover ? 'Hand back' : 'Take control'}
        </button>
      </form>
      <div
        className={`browser-view ${takeover ? 'owner' : ''}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!takeover) return;
          const combo = e.ctrlKey || e.metaKey || e.altKey;
          if (combo && e.key.length === 1) {
            e.preventDefault();
            void send({
              type: 'key',
              key: `${e.ctrlKey ? 'Control+' : ''}${e.altKey ? 'Alt+' : ''}${e.metaKey ? 'Meta+' : ''}${e.key}`,
            });
          } else if (specialKeys.has(e.key)) {
            e.preventDefault();
            void send({ type: 'key', key: e.key });
          } else if (e.key.length === 1) {
            e.preventDefault();
            void send({ type: 'text', text: e.key });
          }
        }}
        onPaste={(e) => {
          if (!takeover) return;
          const text = e.clipboardData.getData('text');
          if (text) void send({ type: 'text', text: text.slice(0, 2000) });
        }}
      >
        {frame ? (
          <img
            alt={`Live view of ${frame.url}`}
            src={`data:image/jpeg;base64,${frame.data}`}
            draggable={false}
            onClick={(e) => {
              if (!takeover) return;
              e.currentTarget.parentElement?.focus();
              void send({ type: 'click', ...point(e) });
            }}
            onContextMenu={(e) => {
              if (!takeover) return;
              e.preventDefault();
              void send({ type: 'click', button: 'right', ...point(e) });
            }}
            onWheel={(e) => {
              if (!takeover) return;
              wheel.current += e.deltaY;
              if (Math.abs(wheel.current) < 60) return;
              void send({ type: 'wheel', dx: 0, dy: wheel.current });
              wheel.current = 0;
            }}
          />
        ) : (
          <p className="muted">Connecting to the live view…</p>
        )}
        <span className={`browser-badge ${takeover ? 'owner' : ''}`}>
          {takeover
            ? 'You have control. Dots are waiting.'
            : 'Dots are in control. Watching live.'}
        </span>
      </div>
      {signIn}
      {error && <p className="chat-error">{error}</p>}
    </div>
  );
}
