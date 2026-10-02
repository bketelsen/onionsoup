import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { cp, mkdir } from 'node:fs/promises';

// Only this fixed launcher runs before the approved project argv. All mutable build/config/Git state
// stays in the sandbox's size-capped tmpfs; the host snapshot remains read-only at /workspace.
try {
  await cp('/workspace', '/tmp/project', { recursive: true, dereference: false, verbatimSymlinks: true });
  await mkdir('/tmp/empty-git-template', { recursive: true });
  const [executable, ...args] = process.argv.slice(2);
  const child = spawn(executable, args, { cwd: '/tmp/project', env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', () => {
    process.stderr.write('operator_check_project_command_unavailable\n');
    process.exitCode = 125;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 125);
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
} catch {
  process.stderr.write('operator_check_project_copy_failed\n');
  process.exitCode = 125;
}
