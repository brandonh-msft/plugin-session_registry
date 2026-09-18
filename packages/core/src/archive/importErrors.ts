export const IMPORT_ERROR_CODES = [
  "IMPORT_INPUT_FAILURE",
  "IMPORT_NOT_A_BUNDLE",
  "IMPORT_UNSUPPORTED_ZIP",
  "IMPORT_LIMIT_EXCEEDED",
  "IMPORT_MANIFEST_MISSING",
  "IMPORT_MANIFEST_INVALID",
  "IMPORT_ENTRY_MISMATCH",
  "IMPORT_UNSAFE_NAME",
  "IMPORT_HASH_MISMATCH",
  "IMPORT_WORKSPACE_FAILURE",
  "IMPORT_CONSENT_REQUIRED",
  "IMPORT_ALREADY_ACTIVE",
  "IMPORT_HANDLE_UNKNOWN",
  "IMPORT_HANDLE_STALE",
  "IMPORT_NOT_READY",
  "IMPORT_CLOSED",
] as const;

export type ImportErrorCode = typeof IMPORT_ERROR_CODES[number];

export interface ImportErrorDefinition {
  readonly code: ImportErrorCode;
  readonly remediation: string;
}

const definitions: readonly ImportErrorDefinition[] = [
  { code: "IMPORT_INPUT_FAILURE", remediation: "Fix the input path and retry the import." },
  { code: "IMPORT_NOT_A_BUNDLE", remediation: "Re-download the session bundle and retry the import." },
  { code: "IMPORT_UNSUPPORTED_ZIP", remediation: "Ask the owner to republish a supported session bundle." },
  { code: "IMPORT_LIMIT_EXCEEDED", remediation: "Use a smaller session bundle." },
  { code: "IMPORT_MANIFEST_MISSING", remediation: "This V2 bundle predates verifiable manifests; re-download or ask the owner to republish it." },
  { code: "IMPORT_MANIFEST_INVALID", remediation: "Re-download the session bundle and retry the import." },
  { code: "IMPORT_ENTRY_MISMATCH", remediation: "Re-download the session bundle and retry the import." },
  { code: "IMPORT_UNSAFE_NAME", remediation: "Do not trust this file; obtain a fresh session bundle." },
  { code: "IMPORT_HASH_MISMATCH", remediation: "Re-download the session bundle and retry the import." },
  { code: "IMPORT_WORKSPACE_FAILURE", remediation: "Check the named workspace path and available disk space." },
  { code: "IMPORT_CONSENT_REQUIRED", remediation: "Re-run the import from an interactive client and confirm it." },
  { code: "IMPORT_ALREADY_ACTIVE", remediation: "Close the current import before starting another one." },
  { code: "IMPORT_HANDLE_UNKNOWN", remediation: "Use the handle returned by the active import." },
  { code: "IMPORT_HANDLE_STALE", remediation: "Use the handle returned by the current import." },
  { code: "IMPORT_NOT_READY", remediation: "Wait for the import to become ready before reading it." },
  { code: "IMPORT_CLOSED", remediation: "Start a new import; the previous workspace has been released." },
];

const definitionByCode = new Map(definitions.map((definition) => [definition.code, definition]));

export function importErrorDefinition(code: ImportErrorCode): ImportErrorDefinition {
  return definitionByCode.get(code)!;
}

export class ImportError extends Error {
  public readonly remediation: string;

  constructor(
    public readonly code: ImportErrorCode,
    detail?: string,
  ) {
    const definition = importErrorDefinition(code);
    super(`${code}: ${detail ?? definition.remediation}`);
    this.name = "ImportError";
    this.remediation = definition.remediation;
  }
}
