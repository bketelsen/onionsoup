/** What one bash rule decides, in opencode's words. */
export type BashDecision = 'allow' | 'ask' | 'deny';

/**
 * opencode's wildcard match: `*` is any text, `?` one character, and a pattern ending in " *" also matches the bare
 * command, so `ls *` matches `ls`.
 */
function globMatches(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  const expression = escaped.endsWith(' .*') ? `${escaped.slice(0, -3)}( .*)?` : escaped;
  return new RegExp(`^${expression}$`, 's').test(value);
}

/**
 * What bash rules decide for one command, with opencode's semantics: the last matching rule wins, and none asks.
 * opencode checks each command of a pipeline or list on its own (`cat x | head` is `cat x` and `head`).
 */
export function bashAction(rules: Record<string, string>, command: string) {
  let action = 'ask';
  for (const [pattern, value] of Object.entries(rules)) if (globMatches(pattern, command.trim())) action = value;
  return action;
}

/** Commands that read files, git history or GitHub state, and nothing else in their plain forms. */
const READERS = [
  'cat *', 'head *', 'tail *', 'wc *', 'ls *', 'pwd', 'tree *', 'file *', 'stat *', 'realpath *', 'basename *',
  'dirname *', 'grep *', 'rg *', 'sed -n *', 'jq *', 'find *', 'diff *', 'sort *', 'cut *',
  'git status*', 'git log*', 'git show*', 'git diff*', 'git rev-parse*', 'git rev-list*', 'git ls-files*',
  'git blame*', 'git merge-base*', 'git describe*', 'git cat-file*', 'git ls-remote*', 'git remote -v', 'git fetch*',
  'git branch', 'git branch -a*', 'git branch -r*', 'git branch --list*', 'git branch --show-current',
  'gh pr view*', 'gh pr list*', 'gh pr checks*', 'gh pr diff*', 'gh pr status*', 'gh issue view*', 'gh issue list*',
  'gh run view*', 'gh run list*', 'gh release view*', 'gh release list*', 'gh repo view*', 'gh api *',
];

/** Flags that turn a reader into a writer, or into a way to run another command. */
const WRITING_FLAGS: Record<string, readonly string[]> = {
  'sed': ['-i', '--in-place'],
  'find': ['-delete', '-exec', '-execdir', '-ok', '-fprint', '-fls'],
  'sort': ['-o', '--output'],
  'tree': ['-o'],
  'file': ['-C', '--compile'],
  'rg': ['--pre'],
  'git log': ['--output'],
  'git show': ['--output'],
  'git diff': ['--output'],
  'git fetch': ['--upload-pack'],
  'git ls-remote': ['--upload-pack'],
  'git branch': ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-u', '--set-upstream-to',
    '--unset-upstream', '-f', '--force', '--edit-description'],
  'gh api': ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', 'graphql'],
};

/** A flag right after the command, or anywhere later. */
function flaggedForms([command, flags]: [string, readonly string[]]) {
  return flags.flatMap(flag => [`${command} ${flag}*`, `${command} * ${flag}*`]);
}

/** Write forms that are not flags: a fetch refspec can move a local branch. */
const WRITING_FORMS = [...Object.entries(WRITING_FLAGS).flatMap(flaggedForms), 'git fetch *:*'];

/**
 * The read-only commands owner chats, reviewer subagents and sandboxed hires share. Readers are allowed, and the
 * write forms of those readers come after them and ask (last match wins in opencode), so `gh api repos/a/b` runs and
 * `gh api -X PATCH repos/a/b` asks. Sessions nobody can answer get these through `unattended`. Bash rules are a
 * convenience, not a boundary (AGENTS rule 3): chat bash is unsandboxed, and a redirect or a script still writes.
 */
export const READ_ONLY_COMMANDS: Record<string, 'allow' | 'ask'> = {
  ...Object.fromEntries(READERS.map(pattern => [pattern, 'allow' as const])),
  ...Object.fromEntries(WRITING_FORMS.map(pattern => [pattern, 'ask' as const])),
};

const UNATTENDED_DECISION: Record<BashDecision, Exclude<BashDecision, 'ask'>> = { allow: 'allow', ask: 'deny', deny: 'deny' };

/** The same rules for a session nobody can answer: a headless ask waits forever, so it denies instead. */
export function unattended(rules: Record<string, BashDecision>) {
  return Object.fromEntries(Object.entries(rules).map(([pattern, decision]) => [pattern, UNATTENDED_DECISION[decision]]));
}
