/**
 * The shapes credentials take in text, in one place: provider health masks them out of stored errors, friction
 * refuses private keys, and the wiki refuses a page that holds one. Each shape is one documented pattern; add an
 * entry to recognise another.
 */
export const SECRET_SHAPES = {
  /** OpenAI-style provider keys, including partly starred ones quoted back in errors. */
  providerKey: /\bsk-[\w*.…-]*[\w*…]/g,
  /** GitHub tokens: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained (github_pat_). */
  githubToken: /\b(?:gh[pousr]_|github_pat_)\w+/g,
  /** An Authorization header's bearer value. */
  bearer: /\bBearer\s+\S+/gi,
  /** The armour line of a PEM or OpenSSH private key. */
  privateKeyBlock: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  /** Long base64 runs, which also match URL paths: masking only. */
  longBase64: /[A-Za-z0-9+/_=-]{32,}/g,
  /** Long hex runs, which also match commit ids and digests: masking only. */
  longHex: /\b[a-f0-9]{24,}\b/gi,
} as const satisfies Record<string, RegExp>;

export type SecretShape = keyof typeof SECRET_SHAPES;

/** What stored error text masks: everything key-like, erring toward masking too much. */
export const MASKED_SHAPES: readonly SecretShape[] = ['providerKey', 'githubToken', 'bearer', 'privateKeyBlock', 'longBase64', 'longHex'];

/**
 * What a document refuses to hold: only unmistakable credentials. Bearer examples, URLs, digests and commit ids are
 * everyday prose in documentation, so those shapes are left out.
 */
export const REFUSED_SHAPES: readonly SecretShape[] = ['providerKey', 'githubToken', 'privateKeyBlock'];

/** Text with every run of the given shapes replaced. */
export function maskSecretShapes(text: string, shapes: readonly SecretShape[]) {
  return shapes.reduce((masked, shape) => masked.replace(SECRET_SHAPES[shape], '[masked]'), text);
}

/** The shapes found in text, in the order given. */
export function secretShapesIn(text: string, shapes: readonly SecretShape[]) {
  return shapes.filter(shape => text.match(SECRET_SHAPES[shape]) !== null);
}

/** Text with every key-like run masked. Used where the declared keys are not at hand. */
export function maskKeyLike(text: string) {
  return maskSecretShapes(text, MASKED_SHAPES);
}
