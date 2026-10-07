import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevWorkspace } from '../src/server/dev-workspace.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

it('edits on a branch, refuses protected files, and only merges on apply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-dev-'));
  const repo = join(root, 'app');
  mkdirSync(join(repo, 'src', 'shared'), { recursive: true });
  mkdirSync(join(repo, 'node_modules'));
  writeFileSync(
    join(repo, 'src', 'math.ts'),
    'export const add = (a: number, b: number) => a - b;\n',
  );
  writeFileSync(
    join(repo, 'src', 'shared', 'capabilities.ts'),
    'export const groups = [];\n',
  );
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '-m',
    'init',
  );
  const dev = new DevWorkspace(repo, ':memory:', join(root, 'app-dev'));
  try {
    // Checks are the real project's job; stub them for this throwaway repo.
    dev.checks = async () => ({ text: '## Tests: PASS', passed: true });
    await dev.start('fix add');
    expect(() => dev.write('src/shared/capabilities.ts', 'hacked')).toThrow(
      /protected/,
    );
    expect(() => dev.read('../secret.txt')).toThrow(/outside/);
    dev.edit('src/math.ts', 'a - b', 'a + b');
    // The live checkout is untouched until apply.
    expect(readFileSync(join(repo, 'src', 'math.ts'), 'utf8')).toContain(
      'a - b',
    );
    const review = await dev.submit(
      'Fix add',
      'add() subtracted instead of adding.',
    );
    expect(review).toMatchObject({ passed: true, status: 'pending' });
    expect(review.diff).toContain(
      '+export const add = (a: number, b: number) => a + b;',
    );
    await dev.apply(review.id);
    expect(readFileSync(join(repo, 'src', 'math.ts'), 'utf8')).toContain(
      'a + b',
    );
    expect(dev.reviews()[0].status).toBe('applied');
    expect(git(repo, 'branch', '--list', 'dev/*').trim()).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
