import {
  InMemoryAgentRunner,
  ɵGLOBAL_STORE as memory,
  type AgentRunnerRunRequest,
} from '@copilotkit/runtime/v2';
import type { BaseEvent, Message } from '@ag-ui/client';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// Durable local conversations: the SDK's in-memory runner handles streaming,
// replay, and stop semantics; each finished run is mirrored into SQLite and
// rehydrated on startup, so no conversation data leaves this machine.
export class SqliteAgentRunner extends InMemoryAgentRunner {
  private db: DatabaseSync;
  constructor(path: string) {
    super({ maxRunsPerThread: 200 });
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS local_threads(id TEXT PRIMARY KEY, agentId TEXT NOT NULL, messages TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_runs(threadId TEXT NOT NULL, runId TEXT NOT NULL, agentId TEXT NOT NULL, parentRunId TEXT, events TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, runId));`);
    this.rehydrate();
  }
  private rehydrate() {
    const threads = this.db
      .prepare('SELECT id, messages FROM local_threads')
      .all() as { id: string; messages: string }[];
    const runs = this.db.prepare(
      'SELECT runId, agentId, parentRunId, events, createdAt FROM local_runs WHERE threadId = ? ORDER BY createdAt',
    );
    for (const thread of threads) {
      const rows = runs.all(thread.id) as {
        runId: string;
        agentId: string;
        parentRunId: string | null;
        events: string;
        createdAt: number;
      }[];
      if (!rows.length) continue;
      memory.getOrCreate(thread.id);
      rows.forEach((row, index) =>
        memory.appendRun(thread.id, {
          threadId: thread.id,
          runId: row.runId,
          agentId: row.agentId,
          parentRunId: row.parentRunId,
          events: JSON.parse(row.events) as BaseEvent[],
          // appendRun keeps the latest non-empty snapshot at thread level.
          messages:
            index === rows.length - 1
              ? (JSON.parse(thread.messages) as Message[])
              : [],
          createdAt: row.createdAt,
        }),
      );
    }
  }
  run(request: AgentRunnerRunRequest) {
    const events = super.run(request);
    // Subscribe independently so the run persists even if the client disconnects.
    events.subscribe({
      complete: () => this.persist(request.threadId, request.input.runId),
      error: () => this.persist(request.threadId, request.input.runId),
    });
    return events;
  }
  private persist(threadId: string, runId: string) {
    const store = memory.peek(threadId);
    const run = store?.historicRuns.find((item) => item.runId === runId);
    if (!store || !run) return;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO local_threads(id, agentId, messages, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updatedAt = excluded.updatedAt`,
      )
      .run(
        threadId,
        run.agentId,
        JSON.stringify(store.messagesSnapshot),
        store.createdAt ?? now,
        now,
      );
    this.db
      .prepare(
        'INSERT OR REPLACE INTO local_runs(threadId, runId, agentId, parentRunId, events, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        threadId,
        runId,
        run.agentId,
        run.parentRunId,
        JSON.stringify(run.events),
        run.createdAt,
      );
  }
}
