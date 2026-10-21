import { inventory } from './git.mjs';
import { integer, relativePath, text } from './io.mjs';

export const CONTEXT_BYTES = 8192;
export const DEFAULT_CONTEXT_FILES = 12;

function excluded(file) {
  return /(^|\/)(\.git|\.leanloop|node_modules|\.venv|venv|vendor|dist|build|coverage)(\/|$)/i.test(file) ||
    /(^|\/)(\.env[^/]*|id_rsa|id_ed25519|credentials[^/]*|secrets[^/]*)$/i.test(file) ||
    /\.(pem|key|p12|pfx|jks|keystore)$/i.test(file);
}

export function rankPaths(paths, query, scopes = [], limit = DEFAULT_CONTEXT_FILES) {
  text(query, 'Query', 1000);
  integer(limit, 'Context file limit', 1, 30);
  for (const scope of scopes) relativePath(scope, 'Context scope');
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9_-]+/).filter(term => term.length > 1))];
  const ranked = paths.filter(file => !excluded(file) &&
    (!scopes.length || scopes.some(scope => file === scope || file.startsWith(`${scope}/`))))
    .map(file => {
      const lower = file.toLowerCase();
      const basename = lower.split('/').at(-1);
      const score = terms.reduce((sum, term) => sum + (basename.includes(term) ? 5 : lower.includes(term) ? 2 : 0), 0);
      return { path: file, score };
    })
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const result = {
    kind: 'filename-candidates',
    query,
    scannedPaths: paths.length,
    matchingPaths: ranked.length,
    maxBytes: CONTEXT_BYTES,
    files: [],
    truncated: false,
    note: 'Filename ranking only, not a symbol/dependency map. Prefer editor code intelligence. No source contents were read.',
  };
  for (const entry of ranked.slice(0, limit)) {
    result.files.push(entry);
    if (Buffer.byteLength(`${JSON.stringify(result)}\n`) > CONTEXT_BYTES - 32) {
      result.files.pop();
      break;
    }
  }
  result.truncated = result.files.length < ranked.length;
  return result;
}

export function context(root, query, scopes, limit) {
  return rankPaths(inventory(root), query, scopes, limit);
}
