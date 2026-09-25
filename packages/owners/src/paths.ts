import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where a person's owners and onionsoup's state live. Onionsoup ships the engine; your owners (declarations,
 * charters, freelancer models, model families) live in your own config directory, and everything the runtime
 * writes (notebooks, ledger, checkouts, desks, evidence, tools) lives in its home.
 */
export function configDirectory() {
  return resolve(process.env.ONIONSOUP_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'onionsoup'));
}

export function homeDirectory() {
  return resolve(process.env.ONIONSOUP_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'onionsoup'));
}

export function stateDirectory() {
  return join(homeDirectory(), 'state');
}
