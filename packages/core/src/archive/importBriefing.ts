import type { NativeHarness } from "./nativeHarness.js";

export type ImportedField = {
  readonly status: "imported" | "unavailable";
  readonly value?: string;
};

export interface ImportInventoryItem {
  readonly category: string;
  readonly count: number;
}

export interface ImportBriefingInput {
  readonly harness: { readonly name: NativeHarness; readonly version: string };
  readonly capturedAt: string;
  readonly files: readonly {
    readonly path: string;
    readonly kind: "events" | "attachment";
    readonly recordCount: number;
    readonly bytes: number;
  }[];
  readonly inventory: readonly ImportInventoryItem[];
  readonly objective?: string;
  readonly keyDecisions?: string;
  readonly filesTouched?: readonly string[];
  readonly outcome?: string;
  readonly verificationStatus?: string;
  readonly disclosures: readonly string[];
  readonly malformedRecords: number;
  readonly queryable: boolean;
  readonly importingHarness?: NativeHarness;
}

export interface ImportBriefing {
  readonly header: {
    readonly harness: NativeHarness;
    readonly version: string;
    readonly capturedAt: string;
  };
  readonly objective: ImportedField;
  readonly keyDecisions: ImportedField;
  readonly filesTouched: ImportedField;
  readonly outcome: ImportedField;
  readonly verificationStatus: ImportedField;
  readonly inventory: readonly ImportInventoryItem[];
  readonly disclosures: readonly string[];
  readonly unavailableFields: readonly string[];
  readonly reducedFidelityNotice?: string;
  readonly queryable: boolean;
  readonly thin: boolean;
  readonly text: string;
}

const FIELD_LABELS = {
  objective: "objective",
  keyDecisions: "key decisions",
  filesTouched: "files touched",
  outcome: "outcome",
  verificationStatus: "verification status",
} as const;

function field(name: keyof typeof FIELD_LABELS, value: string | undefined): ImportedField {
  return value === undefined || value.trim() === ""
    ? { status: "unavailable" }
    : { status: "imported", value: value.trim() };
}

function importedText(value: string): string {
  return `imported: ${value}`;
}

function renderField(label: string, value: ImportedField): string {
  return value.status === "imported"
    ? `- ${label}: ${importedText(value.value!)}`
    : `- ${label}: unavailable`;
}

/**
 * Builds the bounded orientation document. The native files remain the source
 * of truth; this function only renders a projection and never exposes source
 * paths as instructions.
 */
export function buildImportBriefing(input: ImportBriefingInput): ImportBriefing {
  const objective = field("objective", input.objective);
  const keyDecisions = field("keyDecisions", input.keyDecisions);
  const filesTouched = field(
    "filesTouched",
    input.filesTouched === undefined || input.filesTouched.length === 0
      ? undefined
      : input.filesTouched.join(", "),
  );
  const outcome = field("outcome", input.outcome);
  const verificationStatus = field("verificationStatus", input.verificationStatus);
  const unavailableFields = Object.entries({ objective, keyDecisions, filesTouched, outcome, verificationStatus })
    .filter(([, value]) => value.status === "unavailable")
    .map(([name]) => name);
  const disclosures = [
    ...input.disclosures,
    ...(input.malformedRecords > 0
      ? [`${input.malformedRecords} malformed imported record(s) were omitted from the projection.`]
      : []),
  ];
  const reducedFidelityNotice = input.importingHarness !== undefined && input.importingHarness !== input.harness.name
    ? `Reduced fidelity: this bundle was produced by ${input.harness.name} and is being imported into ${input.importingHarness}. Imported facts are orientation data only; harness-specific fields may be unavailable.`
    : undefined;
  const inventoryText = input.inventory.length === 0
    ? "- event categories: unavailable"
    : input.inventory.map((item) => `- ${item.category}: ${item.count} imported record(s)`).join("\n");
  const fileText = input.files.length === 0
    ? "- files: unavailable"
    : input.files.map((file) => `- ${file.kind}: ${file.recordCount} imported record(s), ${file.bytes} bytes`).join("\n");
  const text = [
    "Imported session orientation",
    `- harness: imported ${input.harness.name}`,
    `- version: imported ${input.harness.version}`,
    `- capture time: imported ${input.capturedAt}`,
    ...(reducedFidelityNotice === undefined ? [] : [`- notice: ${reducedFidelityNotice}`]),
    "",
    renderField(FIELD_LABELS.objective, objective),
    renderField(FIELD_LABELS.keyDecisions, keyDecisions),
    renderField(FIELD_LABELS.filesTouched, filesTouched),
    renderField(FIELD_LABELS.outcome, outcome),
    renderField(FIELD_LABELS.verificationStatus, verificationStatus),
    "",
    "Inventory",
    fileText,
    inventoryText,
    "",
    "Disclosures",
    ...(disclosures.length === 0 ? ["- none reported"] : disclosures.map((item) => `- source-reported: ${item}`)),
    ...(input.queryable ? [] : ["- queryable content: unavailable; the valid bundle contained no readable event records"]),
  ].join("\n");
  return {
    header: { harness: input.harness.name, version: input.harness.version, capturedAt: input.capturedAt },
    objective,
    keyDecisions,
    filesTouched,
    outcome,
    verificationStatus,
    inventory: input.inventory,
    disclosures,
    unavailableFields,
    ...(reducedFidelityNotice === undefined ? {} : { reducedFidelityNotice }),
    queryable: input.queryable,
    thin: unavailableFields.length >= 4 || !input.queryable,
    text,
  };
}
