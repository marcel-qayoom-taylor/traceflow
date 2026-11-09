import fs from 'node:fs';
import path from 'node:path';

export function healthStatus(checks) {
  if (checks.some(check => check.status === 'error')) return 'unhealthy';
  if (!checks.length || checks.some(check => check.status !== 'ok')) return 'degraded';
  return 'healthy';
}

// Parse keys only: values (including multiline quoted values) never leave this module.
function envKeys(text) {
  const pattern = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/mg;
  return [...text.matchAll(pattern)].map(match => match[1]);
}
function read(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('must be a regular file');
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}
export async function preflight(spec, { baseDir, nodeBin, listener, running = false }) {
  const cwd = path.resolve(baseDir, spec.cwd || '.');
  const checks = [];
  const add = (check, status, message) => checks.push({ check, status, message });
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error();
    add('directory', 'ok', 'Working directory exists');
  } catch { return { service: spec.name, ok: false, checks: [{ check: 'directory', status: 'error', message: 'Working directory is missing or inaccessible' }] }; }
  try {
    const requested = ['.nvmrc', '.node-version'].find(file => read(path.join(cwd, file)).trim())
      || (/^(?:node|nodejs)\s+/m.test(read(path.join(cwd, '.tool-versions'))) ? '.tool-versions' : null);
    add('node', requested && !nodeBin ? 'error' : 'ok', requested
      ? nodeBin ? `Repository runtime available (${requested})` : `Install the Node version declared in ${requested}`
      : 'Using inherited Node runtime; no repository version declared');
    const example = envKeys(read(path.join(cwd, '.env.example')));
    const present = new Set([...envKeys(read(path.join(cwd, '.env'))), ...Object.keys(spec.env || {}), ...Object.keys(process.env)]);
    const missing = example.filter(key => !present.has(key));
    add('environment', missing.length ? 'warn' : 'ok', missing.length ? `Missing example keys: ${missing.join(', ')}. Run sync-env-example in this repository.` : 'No missing example keys');
  } catch { add('environment', 'error', 'Cannot inspect environment files; use readable regular files'); }
  const manager = /^(npm|yarn|pnpm)(?:\s|$)/.exec(spec.command || '')?.[1];
  if (manager) {
    const search = [nodeBin, ...(spec.env?.PATH ?? process.env.PATH ?? '').split(path.delimiter).map(directory => path.resolve(cwd, directory || '.'))].filter(Boolean);
    const available = search.some(directory => {
      try { fs.accessSync(path.join(directory, manager), fs.constants.X_OK); return true; } catch { return false; }
    });
    add('package-manager', available ? 'ok' : 'error', available ? `${manager} is available` : `Install or enable ${manager} for this repository`);
  }
  if (spec.port) add('port', listener && !running ? 'error' : 'ok', listener ? running ? 'Service is already running' : 'Port is occupied by another process' : 'Port is available');
  checks.push(await readiness(spec, running));
  return { service: spec.name, ok: !checks.some(check => check.status === 'error'), checks };
}

// Kept separate so startup polling does not repeatedly inspect files and processes.
export async function readiness(spec, running, timeoutMs = 2000) {
  const result = (status, message) => ({ check: 'readiness', status, message });
  if (!spec.healthPath) return result('warn', 'No healthPath configured; process presence does not establish readiness');
  if (!spec.port || !/^\/(?!\/)/.test(spec.healthPath)) {
    return result('error', 'healthPath must be a local absolute path on a configured service port');
  }
  if (!running) return result('warn', 'Service is stopped; readiness has not been verified');
  try {
    const response = await fetch(`http://127.0.0.1:${Number(spec.port)}${spec.healthPath}`, {
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return result(response.ok ? 'ok' : 'error', `Health endpoint returned HTTP ${response.status}`);
  } catch {
    return result('error', 'Health endpoint is unreachable');
  }
}
