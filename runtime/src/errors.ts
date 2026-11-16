export class AppError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function requireValue(condition: unknown, code = "INVALID_ARGUMENT"): asserts condition {
  if (!condition) throw new AppError(code);
}
export function record(value: unknown): Record<string, any> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}
export function text(value: unknown, limit = 128): string {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= limit);
  return value;
}
