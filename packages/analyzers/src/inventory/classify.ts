/**
 * File classification for inventory (plan §7 step 1). Pure functions of the repository-relative
 * path; nothing here reads file contents.
 */

/** Directories never enumerated (gitignore syntax). Applied on top of .gitignore/.atlasignore. */
export const DEFAULT_EXCLUDES = [
  '.git/',
  'node_modules/',
  'bower_components/',
  'jspm_packages/',
  'vendor/',
  'dist/',
  'build/',
  'out/',
  'target/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  '.parcel-cache/',
  'coverage/',
  '.nyc_output/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.ruff_cache/',
  '.gradle/',
  '.idea/',
  'Pods/',
  'DerivedData/',
  '.terraform/',
  '.serverless/',
  '.atlas/local/',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.pyc',
  '.DS_Store',
];

const SECRET_NAMES = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$|sample$|template$|defaults$)[^/]+$/,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.(npmrc|pypirc|netrc|pgpass|htpasswd)$/,
  /(^|\/)credentials(\.json|\.ya?ml)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|env)$/i,
  /(^|\/)service[-_]?account.*\.json$/i,
  /\.tfstate(\.backup)?$/,
  /\.kdbx$/i,
];

/** Files whose content is never read, hashed or stored. */
export function isSecretPath(path: string): boolean {
  return SECRET_NAMES.some((re) => re.test(path));
}

const BINARY_EXT = new Set(
  (
    'png jpg jpeg gif webp bmp ico icns tiff psd ai sketch fig avif heic ' +
    'mp3 mp4 m4a mov avi mkv webm wav flac ogg ' +
    'woff woff2 ttf otf eot ' +
    'zip gz tgz bz2 xz 7z rar tar jar war ear whl egg nupkg deb rpm dmg iso apk aab ipa ' +
    'exe dll so dylib a o obj lib bin dat class pyd wasm node ' +
    'pdf doc docx xls xlsx ppt pptx odt ods ' +
    'sqlite sqlite3 db mdb parquet avro orc feather npy npz pkl h5 onnx pt pth safetensors ckpt'
  ).split(' '),
);

export function hasBinaryExtension(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return path.includes('.') && BINARY_EXT.has(ext);
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  groovy: 'groovy',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  fs: 'fsharp',
  vb: 'vbnet',
  swift: 'swift',
  m: 'objective-c',
  mm: 'objective-c',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  clj: 'clojure',
  cljs: 'clojure',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  jl: 'julia',
  zig: 'zig',
  nim: 'nim',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  tf: 'terraform',
  hcl: 'hcl',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  toml: 'toml',
  xml: 'xml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'config',
  properties: 'properties',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  md: 'markdown',
  mdx: 'markdown',
  rst: 'restructuredtext',
  txt: 'text',
  adoc: 'asciidoc',
  svg: 'svg',
  csv: 'csv',
  tsv: 'csv',
  lock: 'lockfile',
};

const LANG_BY_NAME: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Containerfile: 'dockerfile',
  Makefile: 'make',
  GNUmakefile: 'make',
  Jenkinsfile: 'groovy',
  Gemfile: 'ruby',
  Rakefile: 'ruby',
  Procfile: 'config',
  'go.mod': 'go-module',
  'go.sum': 'lockfile',
};

/** Languages that are programming languages: unsupported ones are coverage gaps, not just inventory. */
export const PROGRAMMING_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'python',
  'go',
  'java',
  'kotlin',
  'scala',
  'groovy',
  'rust',
  'ruby',
  'php',
  'csharp',
  'fsharp',
  'vbnet',
  'swift',
  'objective-c',
  'c',
  'cpp',
  'elixir',
  'erlang',
  'haskell',
  'ocaml',
  'clojure',
  'dart',
  'lua',
  'r',
  'julia',
  'zig',
  'nim',
  'shell',
  'powershell',
  'vue',
  'svelte',
  'astro',
]);

export function detectLanguage(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (LANG_BY_NAME[name]) return LANG_BY_NAME[name];
  if (/^(Dockerfile|Containerfile)\./.test(name) || /\.dockerfile$/i.test(name))
    return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'unknown';
  return LANG_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? 'unknown';
}

export type FileRole =
  | 'source'
  | 'test'
  | 'manifest'
  | 'lockfile'
  | 'config'
  | 'deploy'
  | 'ci'
  | 'schema'
  | 'migration'
  | 'docs'
  | 'other';

const MANIFESTS = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'lerna.json',
  'nx.json',
  'turbo.json',
  'deno.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
  'deps.edn',
  'project.clj',
  'stack.yaml',
]);
const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'npm-shrinkwrap.json',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
  'mix.lock',
  'pubspec.lock',
  'Package.resolved',
  'gradle.lockfile',
]);

export function detectRole(path: string, language: string): FileRole {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const lower = path.toLowerCase();
  if (LOCKFILES.has(name)) return 'lockfile';
  if (
    MANIFESTS.has(name) ||
    /\.(csproj|fsproj|vbproj|gemspec|cabal|nimble)$/.test(name) ||
    /^requirements.*\.txt$/.test(name)
  ) {
    return 'manifest';
  }
  if (
    lower.startsWith('.github/workflows/') ||
    name === '.gitlab-ci.yml' ||
    lower.startsWith('.circleci/') ||
    name === 'Jenkinsfile' ||
    name === 'azure-pipelines.yml' ||
    name === '.travis.yml' ||
    lower.startsWith('.buildkite/')
  ) {
    return 'ci';
  }
  if (
    language === 'dockerfile' ||
    /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name) ||
    language === 'terraform' ||
    [
      'Procfile',
      'fly.toml',
      'vercel.json',
      'netlify.toml',
      'app.yaml',
      'serverless.yml',
      'render.yaml',
      'railway.json',
    ].includes(name) ||
    /(^|\/)(k8s|kubernetes|helm|charts|deploy|deployment|infra)\//.test(lower)
  ) {
    return 'deploy';
  }
  if (
    /(^|\/)(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i.test(path) ||
    ['protobuf', 'graphql'].includes(language) ||
    /\.(avsc|schema\.json)$/.test(name)
  ) {
    return 'schema';
  }
  if (
    language === 'sql' &&
    /(^|\/)(migrations?|migrate|db\/migrate|alembic\/versions|flyway|liquibase)\//i.test(path)
  )
    return 'migration';
  if (/(^|\/)(alembic\/versions|migrations)\/[^/]+\.py$/.test(path)) return 'migration';
  if (
    /(^|\/)(test|tests|__tests__|spec|specs|e2e|testing)\//.test(lower) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /^test_.*\.py$/.test(name) ||
    /_test\.(py|go)$/.test(name) ||
    /Tests?\.(java|kt|cs)$/.test(name)
  ) {
    return 'test';
  }
  if (
    ['markdown', 'restructuredtext', 'asciidoc', 'text'].includes(language) ||
    lower.startsWith('docs/')
  )
    return 'docs';
  if (
    PROGRAMMING_LANGUAGES.has(language) ||
    language === 'sql' ||
    language === 'html' ||
    language === 'css'
  )
    return 'source';
  if (
    ['yaml', 'json', 'toml', 'ini', 'config', 'properties', 'xml', 'hcl', 'make'].includes(
      language,
    ) ||
    name.startsWith('.')
  )
    return 'config';
  return 'other';
}
