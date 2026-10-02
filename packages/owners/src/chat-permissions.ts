import { SKILLS_DIRECTORY } from './owner-agents.ts';

/**
 * Read-only commands every owner may run in chat without asking the person. Before this, each owner had its own
 * allowlist and owners asked the person ~700 times in a few days, mostly for `grep -n`, `sed -n` and `git log`. Only
 * commands that cannot write are here (no `gh api`, `echo` or interpreters), and the few flags that make a reader
 * write are sent back to asking. Bash rules are a convenience, not a boundary (AGENTS rule 3): this removes prompts,
 * it does not grant anything the sandbox or the person's gates would otherwise stop.
 */
export const READ_ONLY_CHAT_BASH: Record<string, 'allow' | 'ask'> = {
  'grep *': 'allow',
  'rg *': 'allow',
  'sed -n *': 'allow',
  'sed * -i*': 'ask',
  'sed -n -i*': 'ask',
  'cat *': 'allow',
  'head *': 'allow',
  'tail *': 'allow',
  'wc *': 'allow',
  'ls': 'allow',
  'ls *': 'allow',
  'jq *': 'allow',
  'find *': 'allow',
  'find * -delete*': 'ask',
  'find * -exec*': 'ask',
  'find * -execdir*': 'ask',
  'git status*': 'allow',
  'git log*': 'allow',
  'git diff*': 'allow',
  'git show*': 'allow',
  'git branch': 'allow',
  'git branch -a*': 'allow',
  'git branch -r*': 'allow',
  'git branch --list*': 'allow',
  'git rev-parse*': 'allow',
  'git ls-files*': 'allow',
  'gh pr view*': 'allow',
  'gh pr list*': 'allow',
  'gh pr checks*': 'allow',
  'gh pr diff*': 'allow',
  'gh issue view*': 'allow',
  'gh issue list*': 'allow',
  'gh run view*': 'allow',
  'gh run list*': 'allow',
};

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
 * Last match wins in opencode. Declared rules follow every convenience rule, including configured verification.
 * A declared catch-all deny gets no convenience exceptions; its explicitly configured exceptions still apply.
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
