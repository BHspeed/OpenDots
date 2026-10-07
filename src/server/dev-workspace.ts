import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

// The Developer Dot edits OpenDots' own code in a separate git worktree on its
// own branch, runs the checks there, and submits a review. Nothing reaches the
// running app until the owner clicks Apply, which merges the branch.
export interface DevReview {
  id: string;
  branch: string;
  title: string;
  summary: string;
  diff: string;
  checks: string;
  passed: boolean;
  status: 'pending' | 'applied' | 'rejected';
  createdAt: number;
}

/** Files that govern permissions and approvals: the Developer may not edit them. */
export const protectedPaths = [
  'src/shared/capabilities.ts',
  'src/server/team.ts',
  'src/server/workspace.ts',
  'src/server/dev-workspace.ts',
  'src/server/platform-tools.ts',
  'localtools/',
  'mcp.servers.json',
  '.env',
  '.env.example',
  'start-local.ps1',
  'Start OpenDots.cmd',
  '.git',
  'node_modules',
  'data/',
];

function run(
  command: string,
  args: string[],
  cwd: string,
  timeout = 300_000,
): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout,
        maxBuffer: 20_000_000,
        // npx is a .cmd script on Windows and needs the shell; git must not use
        // it, or arguments with spaces (commit messages) are split apart.
        shell: process.platform === 'win32' && command === 'npx',
        windowsHide: true,
      },
      (error, stdout, stderr) =>
        done({
          code: error ? Number((error as { code?: number }).code ?? 1) || 1 : 0,
          output: `${stdout}${stderr}`,
        }),
    );
  });
}

export class DevWorkspace {
  private db: DatabaseSync;
  readonly worktree: string;
  private branch?: string;
  private lastChecks = { text: 'Checks have not been run yet.', passed: false };
  constructor(
    readonly repo: string,
    databasePath: string,
    worktree = resolve(repo, '..', `${repo.split(sep).at(-1)}-dev`),
  ) {
    this.worktree = worktree;
    if (databasePath !== ':memory:')
      mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS dev_reviews(id TEXT PRIMARY KEY, branch TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, diff TEXT NOT NULL, checks TEXT NOT NULL, passed INTEGER NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL);`);
  }
  private git(args: string[], cwd = this.repo) {
    return run('git', args, cwd);
  }
  /** Resolves a repo-relative path inside the worktree; refuses protected or escaping paths. */
  private path(file: string, forWrite = false) {
    const rel = normalize(file.replace(/^[/\\]+/, '')).replaceAll('\\', '/');
    const full = resolve(this.worktree, rel);
    if (relative(this.worktree, full).startsWith('..'))
      throw new Error('Path is outside the OpenDots code.');
    if (
      forWrite &&
      protectedPaths.some(
        (p) => rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`),
      )
    )
      throw new Error(
        `${rel} is protected (permissions, approvals, tools or secrets). The Developer cannot change it; describe the change for the owner instead.`,
      );
    return { rel, full };
  }
  private requireActive() {
    if (!this.branch || !existsSync(this.worktree))
      throw new Error('No change in progress. Call dev_start first.');
  }
  /**
   * Removes the working copy. The shared node_modules junction is unlinked
   * first: a forced worktree removal follows junctions on Windows and would
   * delete the main checkout's installed packages.
   */
  private async removeWorktree() {
    const modules = join(this.worktree, 'node_modules');
    try {
      if (lstatSync(modules).isSymbolicLink()) {
        try {
          unlinkSync(modules);
        } catch {
          rmdirSync(modules); // junctions are removed as directories
        }
      }
    } catch {
      // No link present.
    }
    if (existsSync(modules))
      throw new Error(
        'Refusing to remove the dev workspace: its node_modules is not a link.',
      );
    await this.git(['worktree', 'remove', '--force', this.worktree]);
    await this.git(['worktree', 'prune']);
  }
  /** Fresh branch + worktree from the current code. */
  async start(title: string) {
    const head = (
      await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])
    ).output.trim();
    if (existsSync(this.worktree)) await this.discard();
    const branch = `dev/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 30)}`;
    const added = await this.git([
      'worktree',
      'add',
      '-b',
      branch,
      this.worktree,
      head,
    ]);
    if (added.code)
      throw new Error(
        `Could not create the dev workspace: ${added.output.slice(0, 500)}`,
      );
    // Share installed packages instead of reinstalling (a junction needs no admin rights).
    const modules = join(this.worktree, 'node_modules');
    if (!existsSync(modules))
      symlinkSync(join(this.repo, 'node_modules'), modules, 'junction');
    this.branch = branch;
    this.lastChecks = { text: 'Checks have not been run yet.', passed: false };
    return { branch, based_on: head, workspace: this.worktree };
  }
  async discard() {
    await this.removeWorktree();
    if (this.branch) await this.git(['branch', '-D', this.branch]);
    this.branch = undefined;
  }
  list(dir = '.') {
    this.requireActive();
    const { full, rel } = this.path(dir);
    return readdirSync(full, { withFileTypes: true })
      .filter((e) => !['node_modules', '.git', 'data', 'dist'].includes(e.name))
      .map(
        (e) =>
          `${rel === '.' ? '' : `${rel}/`}${e.name}${e.isDirectory() ? '/' : ''}`,
      );
  }
  read(file: string, start = 1, end = 400) {
    this.requireActive();
    const { full, rel } = this.path(file);
    const lines = readFileSync(full, 'utf8').split('\n');
    const from = Math.max(1, start);
    const to = Math.min(lines.length, end > 0 ? end : from + 400);
    return {
      path: rel,
      total_lines: lines.length,
      lines: `${from}-${to}`,
      text: lines
        .slice(from - 1, to)
        .map((line, i) => `${from + i}: ${line}`)
        .join('\n'),
    };
  }
  async search(pattern: string) {
    this.requireActive();
    const found = await this.git(
      [
        'grep',
        '-n',
        '-I',
        '--max-count=20',
        '-e',
        pattern,
        '--',
        'src',
        'tests',
      ],
      this.worktree,
    );
    return found.output.split('\n').filter(Boolean).slice(0, 80);
  }
  write(file: string, content: string) {
    this.requireActive();
    const { full, rel } = this.path(file, true);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return { written: rel, chars: content.length };
  }
  /** Exact text replacement (safer than rewriting whole files). */
  edit(file: string, find: string, replace: string) {
    this.requireActive();
    const { full, rel } = this.path(file, true);
    const text = readFileSync(full, 'utf8');
    const count = text.split(find).length - 1;
    if (count === 0)
      throw new Error(
        `The text to replace was not found in ${rel}. Re-read the file and copy it exactly.`,
      );
    if (count > 1)
      throw new Error(
        `The text appears ${count} times in ${rel}; include more surrounding lines so it is unique.`,
      );
    writeFileSync(full, text.replace(find, replace));
    return { edited: rel };
  }
  /** Type-check, lint and the full test suite, summarised for the model. */
  async checks() {
    this.requireActive();
    const steps: [string, string[]][] = [
      ['Type-check', ['tsc', '--noEmit']],
      ['Lint', ['eslint', 'src', 'tests']],
      ['Tests', ['vitest', 'run', '--reporter=dot']],
    ];
    const parts: string[] = [];
    let passed = true;
    for (const [name, args] of steps) {
      const result = await run('npx', args, this.worktree);
      const tail = result.output
        // Strip ANSI colour codes from tool output.
        .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
        .trim()
        .split('\n')
        .slice(-40)
        .join('\n');
      parts.push(
        `## ${name}: ${result.code === 0 ? 'PASS' : 'FAIL'}\n${result.code === 0 ? '' : tail}`,
      );
      if (result.code !== 0) passed = false;
    }
    this.lastChecks = { text: parts.join('\n\n').slice(0, 12000), passed };
    return this.lastChecks;
  }
  async diff() {
    this.requireActive();
    await this.git(['add', '-A'], this.worktree);
    return (
      await this.git(['diff', '--cached', '--stat', '--patch'], this.worktree)
    ).output;
  }
  /** Commit the branch and hand it to the owner for review. */
  async submit(title: string, summary: string): Promise<DevReview> {
    this.requireActive();
    const checks = await this.checks();
    const diff = await this.diff();
    if (!diff.trim()) throw new Error('There are no changes to submit.');
    const commit = await this.git(
      [
        '-c',
        'user.name=OpenDots Developer',
        '-c',
        'user.email=developer@opendots.local',
        'commit',
        '-q',
        '-m',
        `${title}\n\n${summary}`,
      ],
      this.worktree,
    );
    if (commit.code)
      throw new Error(`Commit failed: ${commit.output.slice(0, 400)}`);
    const review: DevReview = {
      id: randomUUID(),
      branch: this.branch!,
      title: title.slice(0, 120),
      summary: summary.slice(0, 2000),
      diff: diff.slice(0, 200_000),
      checks: checks.text,
      passed: checks.passed,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO dev_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        review.id,
        review.branch,
        review.title,
        review.summary,
        review.diff,
        review.checks,
        +review.passed,
        review.status,
        review.createdAt,
      );
    // The branch keeps the work; free the worktree for the next change.
    await this.removeWorktree();
    this.branch = undefined;
    return review;
  }
  reviews(): DevReview[] {
    return (
      this.db
        .prepare('SELECT * FROM dev_reviews ORDER BY createdAt DESC LIMIT 50')
        .all() as unknown as DevReview[]
    ).map((r) => ({ ...r, passed: !!r.passed }));
  }
  private review(id: string) {
    const review = this.reviews().find((r) => r.id === id);
    if (!review || review.status !== 'pending')
      throw new Error('No pending review with that id.');
    return review;
  }
  /** Merge an approved branch into the current branch of the main checkout. */
  async apply(id: string) {
    const review = this.review(id);
    const merged = await this.git([
      '-c',
      'user.name=OpenDots Developer',
      '-c',
      'user.email=developer@opendots.local',
      'merge',
      '--no-ff',
      '-m',
      `Merge developer change: ${review.title}`,
      review.branch,
    ]);
    if (merged.code) {
      await this.git(['merge', '--abort']);
      throw new Error(
        `Merge failed; nothing changed. ${merged.output.slice(0, 600)}`,
      );
    }
    await this.git(['branch', '-d', review.branch]);
    this.db
      .prepare("UPDATE dev_reviews SET status='applied' WHERE id=?")
      .run(id);
    return {
      applied: review.title,
      note: 'Restart OpenDots to load the change.',
    };
  }
  async reject(id: string) {
    const review = this.review(id);
    await this.git(['branch', '-D', review.branch]);
    this.db
      .prepare("UPDATE dev_reviews SET status='rejected' WHERE id=?")
      .run(id);
    return { rejected: review.title };
  }
  /** Repo files and sizes for orientation (excludes generated folders). */
  overview() {
    this.requireActive();
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (
          [
            'node_modules',
            '.git',
            'data',
            'dist',
            'output',
            '.venv',
            'browser-profile',
          ].includes(e.name)
        )
          continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx|css|py|json|md)$/.test(e.name))
          out.push(
            `${relative(this.worktree, full).replaceAll('\\', '/')} (${Math.ceil(statSync(full).size / 1024)} KB)`,
          );
      }
    };
    walk(this.worktree);
    return out;
  }
}
