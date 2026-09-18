import { ImportError } from "./importErrors.js";

const NUMBER_START = /[-0-9]/;
const NUMBER_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function fail(detail: string): never {
  throw new ImportError("IMPORT_MANIFEST_INVALID", `unsafe JSON number: ${detail}`);
}

function decimalParts(value: string): { sign: bigint; digits: bigint; scale: number } {
  const normalized = value.toLowerCase();
  const parts = normalized.split("e");
  const coefficient = parts[0]!;
  const exponentText = parts[1];
  const exponent = exponentText === undefined ? 0 : Number.parseInt(exponentText, 10);
  const sign = coefficient.startsWith("-") ? -1n : 1n;
  const unsigned = coefficient.replace(/^-/, "");
  const coefficientParts = unsigned.split(".");
  const whole = coefficientParts[0]!;
  const fraction = coefficientParts[1] ?? "";
  const digitsText = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  return { sign, digits: BigInt(digitsText || "0"), scale: fraction.length - exponent };
}

function equivalentDecimal(left: string, right: string): boolean {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (a.digits === 0n && b.digits === 0n) return true;
  if (a.sign !== b.sign) return false;
  if (a.scale === b.scale) return a.digits === b.digits;
  if (a.scale > b.scale) return a.digits === b.digits * 10n ** BigInt(a.scale - b.scale);
  return a.digits * 10n ** BigInt(b.scale - a.scale) === b.digits;
}

function validateNumberLiteral(literal: string): void {
  const parsed = Number(literal);
  if (!Number.isFinite(parsed)) fail(literal);
  if (!literal.includes(".") && !/[eE]/.test(literal)) {
    if (!Number.isSafeInteger(parsed) || BigInt(literal) !== BigInt(parsed)) fail(literal);
    return;
  }
  const roundTrip = JSON.stringify(parsed);
  if (roundTrip === undefined || !equivalentDecimal(literal, roundTrip)) fail(literal);
}

/**
 * Checks JSON number tokens while they are still text. JSON.parse() must only
 * run after this check because it silently rounds large integers and fractions.
 */
export function assertImportJsonNumericPrecision(text: string): void {
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < text.length) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      index++;
      continue;
    }
    if (character === '"') {
      inString = true;
      index++;
      continue;
    }
    if (NUMBER_START.test(character) && (character === "-" || /\d/.test(character))) {
      const match = text.slice(index).match(NUMBER_TOKEN);
      if (match === null) fail(text.slice(index, index + 32));
      validateNumberLiteral(match[0]);
      index += match[0].length;
      continue;
    }
    index++;
  }
}

export function parseImportJson(text: string): unknown {
  assertImportJsonNumericPrecision(text);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ImportError("IMPORT_MANIFEST_INVALID", "malformed JSON.");
    throw error;
  }
}

export function parseImportJsonl(text: string): readonly unknown[] {
  const records: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    assertImportJsonNumericPrecision(line);
    try {
      records.push(JSON.parse(line) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ImportError("IMPORT_MANIFEST_INVALID", `malformed JSONL at line ${index + 1}.`);
      }
      throw error;
    }
  }
  return records;
}
