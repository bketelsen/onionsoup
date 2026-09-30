import { createHash } from 'node:crypto';

export const fail = code => Object.assign(new Error(code), { code });
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
