import { describe, expect, it } from "vitest";
import {
  assertImportJsonNumericPrecision,
  parseImportJson,
  parseImportJsonl,
} from "../../src/archive/jsonPrecision.js";
import { ImportError } from "../../src/archive/importErrors.js";

describe("import JSON precision", () => {
  it("accepts safe integers and exactly representable decimal round trips", () => {
    expect(parseImportJson('{"count":9007199254740991,"ratio":0.1}')).toEqual({
      count: 9007199254740991,
      ratio: 0.1,
    });
  });

  it("rejects an unsafe integer before JSON.parse can round it", () => {
    expect(() => assertImportJsonNumericPrecision('{"count":9007199254740992}'))
      .toThrowError(expect.objectContaining({ code: "IMPORT_MANIFEST_INVALID" }));
  });

  it("rejects a fraction whose significant digits do not round trip", () => {
    expect(() => parseImportJson('{"ratio":0.100000000000000005}'))
      .toThrowError(expect.objectContaining({ code: "IMPORT_MANIFEST_INVALID" }));
  });

  it("does not inspect number-looking text inside strings", () => {
    expect(parseImportJson('{"text":"900719925474099312345"}')).toEqual({
      text: "900719925474099312345",
    });
  });

  it("guards every JSONL record", () => {
    try {
      parseImportJsonl('{"bad":9007199254740993}\n');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).code).toBe("IMPORT_MANIFEST_INVALID");
    }
  });
});
