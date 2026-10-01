import { spawn } from 'node:child_process';
import { constants } from 'node:os';

// Host-owned argv and one explicit permit are the only inputs. EOF must never authorize execution.
let decided = false;
let child;
function refuse() {
  if (decided) return;
  decided = true;
  process.exit(125);
}
process.stdin.once('end', refuse);
process.stdin.once('error', refuse);
process.stdin.once('data', permit => {
  if (decided) return;
  if (permit.length !== 1 || permit[0] !== 1) return refuse();
  decided = true;
  process.stdin.destroy();
  const [executable, ...args] = process.argv.slice(2);
  try { child = spawn(executable, args, { stdio: ['ignore', 'inherit', 'inherit'], env: process.env }); }
  catch { process.exit(125); }
  child.once('error', () => process.exit(125));
  child.once('exit', (code, signal) => process.exit(code ?? (signal ? 128 + constants.signals[signal] : 125)));
});
process.on('SIGTERM', () => {
  if (child) child.kill('SIGTERM');
  else process.exit(125);
});
process.stdin.resume();
