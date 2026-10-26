# Expected graphs

Hand-authored from reading each fixture's source, before and independently of the analyzers
(plan §16). Tests compare analyzer output with these files and report precision/recall per
analyzer and relation kind. Do not regenerate these from extractor output.

They live outside the fixture roots so they are not part of any fixture's scanned inventory.

## Identity keys

| Key | Entity |
|---|---|
| `system` | the registered root |
| `pkg:<dir>` | package declared by a manifest (`.` for the root) |
| `ext:npm:<name>`, `ext:pypi:<name>` | third-party library imported by code |
| `ts:module:<path>`, `py:module:<path>` | source module |
| `ts:symbol:<path>#<name>`, `py:symbol:<path>#<name>` | exported/public top-level symbol |
| `endpoint:<pkgdir>:<METHOD> <route>` | HTTP endpoint declared in code |
| `ui:<pkgdir>:<route>` | UI route/screen declared in code |
| `entry:<pkgdir>:<name>` | declared entrypoint (package bin/main, console script) |
| `entry:docker:<path>` | Dockerfile CMD/ENTRYPOINT |
| `compose:<service>` | Docker Compose service |
| `queue:<name>` | message queue |
| `table:<name>` | SQL table declared by a migration |
