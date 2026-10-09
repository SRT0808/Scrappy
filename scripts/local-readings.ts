import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { uuidPattern } from '../lib/product-contract.js';

// Only the Vite development adapter imports this executor; deployed APIs use Actions.
export function localReadings(root: string) {
  const running = new Map<string, ReturnType<typeof spawn>>();
  let closed = false;
  async function dispatch(id: string, mode: 'reading' | 'product'): Promise<void> {
      if (!uuidPattern.test(id)) throw new Error('Invalid reading ID');
      if (closed) throw new Error('Local reading executor closed');
      const task = `${mode}:${id}`;
      if (running.has(task)) return;
      const python = resolve(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const child = spawn(python, ['-m', 'scrappy.run', '--mode', mode, mode === 'reading' ? '--reading-id' : '--product-id', id], {
        cwd: root, windowsHide: true, shell: false, stdio: 'ignore',
        env: {
          ...process.env,
          PYTHONPATH: resolve(root, 'scraper/src'),
        },
      });
      running.set(task, child);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      child.once('close', code => {
        clearTimeout(timeout);
        running.delete(task);
        if (code !== 0 && child.pid && !closed) console.error(`Local ${mode} ${id} failed; check its history before retrying.`);
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => {
          timeout = setTimeout(() => child.kill(), 180_000);
          resolve();
        });
        child.once('error', () => {
          running.delete(task);
          reject(new Error('Local Python unavailable; install .venv and scraper dependencies.'));
        });
      });
  }
  return {
    dispatch: (id: string) => dispatch(id, 'reading'),
    dispatchProduct: (id: string) => dispatch(id, 'product'),
    close() {
      closed = true;
      for (const child of running.values()) child.kill();
      running.clear();
    },
  };
}
