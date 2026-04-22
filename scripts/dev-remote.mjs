import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from './load-project-env.mjs';

await loadProjectEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const nodeCommand = process.execPath;
const serverEntry = resolve(projectRoot, 'server', 'mock-queue-server.mjs');
const viteEntry = resolve(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const children = [];

function startProcess(args, extraEnv = {}) {
  const child = spawn(nodeCommand, args, {
    stdio: 'inherit',
    cwd: projectRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  children.push(child);
  return child;
}

function shutdown(exitCode = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  process.exit(exitCode);
}

const server = startProcess([serverEntry]);
const vite = startProcess(
  [viteEntry, '--open', '/app.html'],
  {
    VITE_QUEUE_SYNC_MODE: process.env.VITE_QUEUE_SYNC_MODE ?? 'remote',
    VITE_QUEUE_API_BASE_URL: process.env.VITE_QUEUE_API_BASE_URL ?? 'http://127.0.0.1:8787',
    VITE_DEFAULT_STORE_ID: process.env.VITE_DEFAULT_STORE_ID ?? 'RESTO-001',
  }
);

server.on('exit', code => {
  if (code && code !== 0) {
    shutdown(code);
  }
});

vite.on('exit', code => {
  shutdown(code ?? 0);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
