/**
 * @atlas/evidence — Evidence store: event ingestion, content-addressed artifacts, redaction (plan §10-11).
 *
 * Not implemented yet: ticket E01 in IMPLEMENTATION_STATUS.md. This module only reserves
 * the package boundary so dependency direction is fixed from the start.
 */
export const PACKAGE_STATUS = {
  name: '@atlas/evidence',
  ticket: 'E01',
  implemented: false,
} as const;
