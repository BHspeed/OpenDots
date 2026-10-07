import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { LiveBrowser } from './browser-live.js';

const inputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    x: z.number().min(0).max(20000),
    y: z.number().min(0).max(20000),
    button: z.enum(['left', 'right']).optional(),
  }),
  z.object({
    type: z.literal('wheel'),
    dx: z.number().min(-5000).max(5000),
    dy: z.number().min(-5000).max(5000),
  }),
  z.object({ type: z.literal('key'), key: z.string().min(1).max(40) }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(2000) }),
]);

export function browserRoutes(live: LiveBrowser) {
  const app = new Hono();
  const failure = (error: unknown) =>
    error instanceof Error ? error.message : 'Browser action failed.';
  app.get('/browser/status', async (c) => c.json(await live.status()));
  app.get('/browser/stream', (c) =>
    streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      let sending = false;
      await live.stream((frame) => {
        // Drop frames while the previous one is still being written.
        if (sending) return;
        sending = true;
        void stream
          .writeSSE({ event: 'frame', data: JSON.stringify(frame) })
          .catch(() => controller.abort())
          .finally(() => (sending = false));
      }, controller.signal);
    }),
  );
  app.post('/browser/start', async (c) => {
    const body = z
      .object({ url: z.string().max(2048).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    try {
      await live.start(body.success ? body.data.url : undefined);
      return c.json(await live.status());
    } catch (error) {
      return c.json({ error: failure(error) }, 502);
    }
  });
  app.post('/browser/navigate', async (c) => {
    const body = z
      .union([
        z.object({ url: z.string().min(1).max(2048) }),
        z.object({ action: z.enum(['back', 'forward', 'reload']) }),
      ])
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid navigation.' }, 400);
    try {
      if ('url' in body.data) await live.goto(body.data.url);
      else await live.navigate(body.data.action);
      return c.json(await live.status());
    } catch (error) {
      return c.json({ error: failure(error) }, 502);
    }
  });
  app.post('/browser/takeover', async (c) => {
    const body = z
      .object({ on: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid takeover.' }, 400);
    live.setTakeover(body.data.on);
    return c.json(await live.status());
  });
  app.post('/browser/input', async (c) => {
    const body = inputSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid input event.' }, 400);
    try {
      await live.input(body.data);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: failure(error) }, 409);
    }
  });
  return app;
}
