import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CGROUP_ROOT = '/sys/fs/cgroup';

export interface CgroupBudget {
  memoryBytes: number;
  tasksMax?: number;
  swapBytes?: number;
}

function membershipDirectory() {
  const memberships = readFileSync('/proc/self/cgroup', 'utf8').split('\n').filter(line => line.startsWith('0::'));
  if (memberships.length !== 1) return undefined;
  const path = memberships[0]!.slice(3);
  if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)) return undefined;
  if (path === '/') return CGROUP_ROOT;
  if (path.slice(1).split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  return join(CGROUP_ROOT, path);
}

function kernelLimit(directory: string, controller: string, permitsZero: boolean) {
  const value = readFileSync(join(directory, controller), 'utf8').trim();
  if (value === 'max') return Infinity;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error('cgroup_limit_invalid');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || (!permitsZero && limit === 0)) throw new Error('cgroup_limit_invalid');
  return limit;
}

function validBudget(budget: CgroupBudget) {
  return Number.isSafeInteger(budget.memoryBytes) && budget.memoryBytes > 0
    && (budget.tasksMax === undefined || Number.isSafeInteger(budget.tasksMax) && budget.tasksMax > 0)
    && (budget.swapBytes === undefined || Number.isSafeInteger(budget.swapBytes) && budget.swapBytes >= 0);
}

/** Only actual cgroup v2 ancestry can prove an inherited budget; no environment or caller path is evidence. */
export function inheritedCgroupBudget(budget: CgroupBudget): boolean {
  if (!validBudget(budget)) return false;
  let hasMemoryCap = false;
  let hasTasksCap = budget.tasksMax === undefined;
  let hasSwapCap = budget.swapBytes === undefined;
  try {
    let directory = membershipDirectory();
    while (directory && directory !== CGROUP_ROOT) {
      const memory = kernelLimit(directory, 'memory.max', false);
      const tasks = budget.tasksMax === undefined ? Infinity : kernelLimit(directory, 'pids.max', false);
      const swap = budget.swapBytes === undefined ? Infinity : kernelLimit(directory, 'memory.swap.max', true);
      hasMemoryCap ||= memory <= budget.memoryBytes;
      hasTasksCap ||= budget.tasksMax !== undefined && tasks <= budget.tasksMax;
      hasSwapCap ||= budget.swapBytes !== undefined && swap <= budget.swapBytes;
      if (hasMemoryCap && hasTasksCap && hasSwapCap) return true;
      directory = dirname(directory);
    }
  } catch {
    // Missing or malformed kernel evidence requires the caller's original systemd scope.
    return false;
  }
  return false;
}
