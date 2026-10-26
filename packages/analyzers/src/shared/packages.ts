import type { InventoryFile } from '../types.ts';

const MANIFEST_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'pubspec.yaml',
]);

export const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const packageKey = (dir: string) => `pkg:${dir || '.'}`;

/** Directories that hold a manifest; these are the package entities the manifest analyzer emits. */
export function manifestDirs(files: readonly InventoryFile[]): string[] {
  return [
    ...new Set(
      files
        .filter((f) => f.role === 'manifest' && MANIFEST_NAMES.has(baseName(f.path)))
        .map((f) => dirOf(f.path)),
    ),
  ].sort();
}

/** Nearest enclosing package directory of a path, or undefined when none encloses it. */
export function nearestPackageDir(path: string, dirs: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const d of dirs) {
    if (d === '' || path === d || path.startsWith(`${d}/`)) {
      if (best === undefined || d.length > best.length) best = d;
    }
  }
  return best;
}

export function ownerKeyFor(path: string, dirs: readonly string[]): string {
  const d = nearestPackageDir(path, dirs);
  return d === undefined ? 'system' : packageKey(d);
}

/** Normalize a URL path template so code-side consumers and route declarations can be compared. */
export function routeShape(path: string): string {
  const clean = path.split('?')[0]!.replace(/\/+$/, '') || '/';
  return clean
    .split('/')
    .map((seg) => (/^(:\w+|\{[^}]+\}|<[^>]+>|\$\{[^}]*\}|\*)$/.test(seg) ? ':' : seg))
    .join('/');
}
