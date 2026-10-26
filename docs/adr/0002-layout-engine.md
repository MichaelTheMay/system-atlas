# ADR-0002: ELK.js layered layout behind an interface

Status: accepted (2026-10-26)

## Decision

- `elkjs` 0.12.0 via `lib/elk.bundled.js` behind `@atlas/layout`'s `LayoutEngine` interface.
- Input nodes/edges are sorted by ID and `elk.randomSeed` is fixed, so identical graphs produce identical positions (tested). Results carry `LAYOUT_VERSION`; a version change is visible rather than silently reshuffling canvases.
- User overlay positions (`fixed`) override engine output; new nodes are placed by the engine.
- Browser: run in a Web Worker (A07). Node: in-process, or `web-worker` if needed.

## License

elkjs is `EPL-2.0 OR GPL-3.0-or-later`. Atlas uses it unmodified as a dependency under EPL-2.0, which is file-level weak copyleft and compatible with distributing Atlas under MIT. Modifications to elkjs files themselves would have to be published under EPL-2.0. Notice kept in `THIRD-PARTY-NOTICES.md`. (Engineering reading, not legal advice.)
