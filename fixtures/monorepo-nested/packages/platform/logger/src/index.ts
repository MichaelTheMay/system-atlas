export function log(message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ message, ...fields }));
}
