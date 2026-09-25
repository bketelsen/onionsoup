function globMatches(pattern: string, value: string) {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${expression}$`, 's').test(value);
}

/** What bash rules decide for one command, with opencode's semantics: the last matching rule wins, and none asks. */
export function bashAction(rules: Record<string, string>, command: string) {
  let action = 'ask';
  for (const [pattern, value] of Object.entries(rules)) if (globMatches(pattern, command.trim())) action = value;
  return action;
}
