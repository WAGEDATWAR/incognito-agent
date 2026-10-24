import { spawn } from 'node:child_process';

/** Kills a process and everything it spawned (a shell command's children survive a plain kill()). */
export function killTree(p) {
  if (!p.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(-p.pid, 'SIGKILL'); } catch { p.kill('SIGKILL'); }
  }
}

/** Spawns a long-running child so killTree() can take its whole group down. On Windows, bare commands like `npx` need a shell. */
export function spawnServer(command, args, { cwd, env }) {
  const needsShell = process.platform === 'win32' && !/[\\/]/.test(command) && !/\.(exe|com)$/i.test(command);
  const quote = (a) => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return needsShell
    ? spawn([command, ...args].map(quote).join(' '), { cwd, env, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
}
