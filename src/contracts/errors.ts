export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  safeMessage: string;
}
export class ContractValidationError extends Error {
  readonly code = "ValidationError";
  constructor(public readonly issues: readonly ValidationIssue[]) {
    super("Contract validation failed");
    this.name = "ContractValidationError";
  }
}
export class ConflictError extends Error {
  readonly code = "Conflict";
  constructor(message = "Revision conflict") {
    super(message);
    this.name = "ConflictError";
  }
}
export class CompatibilityError extends Error {
  readonly code = "UnsupportedSchemaVersion";
  constructor(public readonly version: unknown) {
    super("Unsupported schema version");
    this.name = "CompatibilityError";
  }
}
