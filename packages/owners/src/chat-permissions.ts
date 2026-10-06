import { READ_ONLY_COMMANDS } from './bash-rules.ts';
import { SKILLS_DIRECTORY } from './owner-agents.ts';

/**
 * Read-only commands every owner may run in chat without asking the person: the list reviewers and hires share
 * (files, git history, GitHub reads including `gh api` GETs), whose write forms ask, plus waiting on a CI run, which
 * the person can stop. Before a shared baseline, each owner had its own allowlist and owners asked the person ~700
 * times in a few days, mostly for `grep -n`, `sed -n` and `git log`. Bash rules are a convenience, not a boundary
 * (AGENTS rule 3): chat bash is unsandboxed, so this removes prompts; it grants nothing the person's gates would stop.
 */
export const READ_ONLY_CHAT_BASH: Record<string, 'allow' | 'ask'> = { ...READ_ONLY_COMMANDS, 'gh run watch*': 'allow' };

/**
 * Routine development in an already-authorized repository workspace. These rules reduce prompts, not authority:
 * chat bash is still unsandboxed, repository scripts can have effects, and host publication/resource gates remain.
 */
export const LOCAL_DEVELOPMENT_BASH: Record<string, 'allow'> = {
  'npm test*': 'allow',
  'pnpm test*': 'allow',
  'yarn test*': 'allow',
  ...Object.fromEntries(['npm', 'pnpm', 'yarn'].flatMap(runner =>
    ['test', 'build', 'check', 'typecheck', 'lint', 'format', 'dev'].map(script => [`${runner} run ${script}*`, 'allow' as const]))),
  'node --test*': 'allow',
  'go test*': 'allow',
  'go vet*': 'allow',
  'go build*': 'allow',
  'pytest*': 'allow',
  'python -m pytest*': 'allow',
  'python3 -m pytest*': 'allow',
  'cargo test*': 'allow',
  'cargo check*': 'allow',
  'cargo build*': 'allow',
  'make test*': 'allow',
  'make check*': 'allow',
  'make build*': 'allow',
  'make lint*': 'allow',
};

/**
 * Last match wins in opencode. The order is the owner's catch-all, then the conveniences (the read-only floor, local
 * development, configured verification) minus any pattern the owner declared, then the owner's declared rules: a
 * declared `deny` or `ask` beats a convenience allow, and a declared `allow` beats a write form's ask. A declared
 * catch-all deny gets no conveniences at all; its explicitly configured exceptions still apply.
 */
export function chatBash(ownerBash: Record<string, string>, verify: readonly string[], canDevelop = false) {
  const { '*': catchAll = 'ask', ...specific } = ownerBash;
  const baseline: Record<string, string> = catchAll === 'deny' ? {} : {
    '*': catchAll,
    ...READ_ONLY_CHAT_BASH,
    ...(canDevelop ? LOCAL_DEVELOPMENT_BASH : {}),
    ...Object.fromEntries(verify.map(command => [`${command}*`, 'allow'])),
  };
  return Object.fromEntries<string>([
    ['*', catchAll],
    ...Object.entries(baseline).filter(([pattern]) => pattern !== '*' && !(pattern in specific)),
    ...Object.entries(specific),
  ]);
}

/**
 * Paths outside an owner's directory it may touch without asking: its own scratch space under opencode's temporary
 * directory, and the skills it works by (a skill's supporting prompts sit next to it). Other owners' desks and
 * onionsoup's state still ask.
 */
export const CHAT_EXTERNAL_DIRECTORIES: Record<string, 'allow' | 'ask'> = {
  '*': 'ask',
  '/tmp/opencode/*': 'allow',
  [`${SKILLS_DIRECTORY.replace(/\/$/, '')}/*`]: 'allow',
};
