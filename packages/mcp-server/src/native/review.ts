import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import {
  applyResolutions,
  NATIVE_SESSION_ARCHIVE_FORMAT,
  NATIVE_SESSION_BUNDLE_WARNING,
  type PublicationContentDecision,
  hasNativeSessionBundle,
  inspectNativeJsonl,
  nativeFileContentBytes,
  nativeFileNeedsUnscannedReview,
  parseNativeSessionArchive,
  scan,
  type Finding,
  type FindingResolution,
  type NativeRedaction,
  type NativeArchiveFile,
  type NativeSessionArchive,
  type ResolutionAction,
} from "@session-registry/core";
import { NativeCaptureError } from "./files.js";

export interface CaptureResolution {
  readonly findingId: string;
  readonly action: ResolutionAction | { readonly kind: "acknowledge-unscanned" };
}

export interface OwnerRedaction {
  readonly exactText: string;
  readonly replacementText?: string;
  readonly caseSensitive?: boolean;
}

export interface CaptureFinding {
  readonly id: string;
  readonly category: string;
  readonly severity: Finding["severity"];
  readonly source: string;
  /** UTF-16 range in the named source or review segment, never a secret excerpt. */
  readonly offset: number;
  readonly length: number;
  readonly proposedReplacement: string;
  readonly manualReview?: boolean;
  /**
   * A bounded, partially-masked preview of the detected value (e.g.
   * `ghp_****************************abcd`) so an owner reviewing findings
   * individually can recognize what was matched. Never the full value, and
   * never present for `manualReview` findings (their underlying text can be
   * an entire binary blob or unparsed segment, not a bounded secret).
   */
  readonly maskedPreview?: string;
  /**
   * An opaque, one-way hash of the finding's exact detected value (verbatim,
   * case-sensitive, no whitespace collapsing). Findings that share a
   * `valueKey` are byte-identical occurrences of the same value and should
   * be reviewed/resolved together rather than repeating the same decision
   * once per occurrence. Never reverse-derivable to the original text, and
   * never present for `manualReview` findings (same guard as
   * `maskedPreview`).
   */
  readonly valueKey?: string;
}

interface ReviewTarget {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly jsonLines?: boolean;
  readonly fileIndex?: number;
}

interface LocatedFinding extends CaptureFinding {
  readonly target: string;
  readonly rawText: string;
  readonly decodedText: string;
  readonly leafPath: string;
  readonly leafOffset: number;
  readonly leafLength: number;
  readonly encodingDepth: number;
  readonly ownerAction?: ResolutionAction;
  readonly ownerRuleIndex?: number;
}

export class CaptureReviewRequiredError extends NativeCaptureError {
  constructor(readonly findings: readonly CaptureFinding[], message = "Resolve every security finding and explicitly acknowledge unscanned content before publication.") {
    super("SECURITY_REVIEW_REQUIRED", message);
  }
}

const CREDENTIAL_FIELD = /^(?:authorization|proxy[_-]?authorization|api[_-]?key|(?:access|refresh|auth|api|session)[_-]?token|token|password|passwd|client[_-]?secret|secret|[A-Za-z0-9_]+_(?:TOKEN|PASSWORD|SECRET|API_KEY))$/i;
const MEDIA_TYPES = new Set(["image", "input_image", "output_image", "image_url", "audio", "input_audio", "output_audio",
  "document", "video", "input_video", "session.binary_asset"]);
const UNSCANNED_WARNING = "The local scanner cannot inspect this content for secrets or unsafe instructions. " +
  "Explicitly acknowledge unscanned content to retain its exact bytes for download only in the separately warned native package; do not execute it. " +
  NATIVE_SESSION_BUNDLE_WARNING;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encodeFragment(value: string, depth: number): string {
  for (let index = 0; index < depth; index++) value = JSON.stringify(value).slice(1, -1);
  return value;
}

/**
 * Reveals a few characters at the start/end of a detected value and masks
 * the rest with `*`, so an owner can recognize a finding without ever seeing
 * enough of it to reconstruct the secret. Whitespace/control characters are
 * collapsed to a single space first so multi-line values (e.g. PEM keys)
 * can't leak their structure through the preview. Values of 4 characters or
 * fewer are fully masked (no reveal) since any partial reveal of something
 * that short would expose most or all of it.
 */
export function maskFindingPreview(value: string): string {
  const collapsed = value.replace(/\s+/g, " ");
  const total = collapsed.length;
  if (total <= 4) return "*".repeat(total);
  const reveal = total >= 24 ? 4 : total >= 12 ? 2 : 1;
  const start = collapsed.slice(0, reveal);
  const end = collapsed.slice(total - reveal);
  return `${start}${"*".repeat(total - reveal * 2)}${end}`;
}

function publicFinding(finding: LocatedFinding): CaptureFinding {
  const { id, category, severity, source, offset, length, proposedReplacement, manualReview, decodedText } = finding;
  return {
    id, category, severity, source: safeReviewText(source), offset, length, proposedReplacement,
    ...(manualReview ? { manualReview } : {}),
    ...(manualReview ? {} : { maskedPreview: maskFindingPreview(decodedText), valueKey: hash(decodedText) }),
  };
}

export function safeReviewText(text: string): string {
  const findings = textFindings(text, false);
  return applyResolutions(text, findings, findings.map((_, findingIndex) => ({
    findingIndex, action: { kind: "accept-redaction" },
  })));
}

function pathKey(path: string): string {
  return path.replaceAll("\\", "/");
}

function fileTargets(file: NativeArchiveFile, index: number): ReviewTarget[] {
  if (file.contentEncoding === "base64") return [];
  return [{ id: `file/${index}/content`, source: file.path, text: file.content, jsonLines: file.kind === "events", fileIndex: index }];
}

function targets(archive: NativeSessionArchive, metadata?: { readonly title: string; readonly summary: string }): ReviewTarget[] {
  const paths = new Set(archive.files.map((file) => pathKey(file.path)));
  return [
    { id: "harnessSessionId", source: "harnessSessionId", text: archive.harnessSessionId },
    { id: "harnessVersion", source: "harness.version", text: archive.harness.version },
    { id: "sourceFormat", source: "sourceFormat", text: archive.sourceFormat },
    ...archive.files.flatMap((file, index) => [
      { id: `file/${index}/path`, source: `files[${index}].path`, text: file.path },
      ...fileTargets(file, index),
    ]),
    ...(archive.capture?.sources.flatMap((source, index) => source.originalPath === undefined ? [] : [{
      id: `source/${index}/originalPath`, source: `capture.sources[${index}].originalPath`, text: source.originalPath,
    }]) ?? []),
    ...(archive.capture?.history.flatMap((segment, index) => [
      ...(segment.sessionId === archive.harnessSessionId ? [] : [{
        id: `history/${index}/sessionId`, source: `capture.history[${index}].sessionId`, text: segment.sessionId,
      }]),
      ...(segment.rolloutId === undefined || segment.rolloutId === archive.harnessSessionId ? [] : [{
        id: `history/${index}/rolloutId`, source: `capture.history[${index}].rolloutId`, text: segment.rolloutId,
      }]),
    ]) ?? []),
    ...(archive.capture?.diagnostics.flatMap((diagnostic, index) => paths.has(pathKey(diagnostic.source)) ? [] : [{
      id: `diagnostic/${index}/source`, source: `capture.diagnostics[${index}].source`, text: diagnostic.source,
    }]) ?? []),
    ...(archive.restoration === undefined ? [] : [{
      id: "restoration/reason", source: "restoration.reason", text: archive.restoration.reason,
    }]),
    ...archive.redactions.flatMap((redaction, index) => paths.has(pathKey(redaction.source)) ? [] : [{
      id: `redaction/${index}/source`, source: `redactions[${index}].source`, text: redaction.source,
    }]),
    ...(metadata === undefined ? [] : [
      { id: "title", source: "title", text: metadata.title },
      { id: "summary", source: "summary", text: metadata.summary },
    ]),
  ];
}

function isStructured(text: string): boolean {
  if (!/^\s*[\[{"\uFEFF]/.test(text)) return false;
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return parsed !== null && (typeof parsed === "object" || typeof parsed === "string");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return false;
  }
}

/** Maps decoded string offsets back to original JSON without normalizing the source file. */
function stringToken(text: string, start: number, end: number) {
  const decoded: string = JSON.parse(text.slice(start, end));
  const escapes: { after: number; extra: number }[] = [];
  let extra = 0;
  for (let index = start + 1; index < end - 1; index++) {
    if (text[index] !== "\\") continue;
    const width = text[index + 1] === "u" ? 6 : 2;
    const after = index - start - extra;
    extra += width - 1;
    escapes.push({ after, extra });
    index += width - 1;
  }
  return {
    decoded,
    offset(position: number): number {
      let low = 0;
      let high = escapes.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (escapes[middle]!.after <= position) low = middle + 1;
        else high = middle;
      }
      return start + 1 + position + (low === 0 ? 0 : escapes[low - 1]!.extra);
    },
  };
}

interface JsonContext {
  readonly parent?: JsonContext;
  binary: boolean;
  media: boolean;
}

function structuredTokens(text: string) {
  const contexts: JsonContext[] = [];
  const tokens: {
    token: ReturnType<typeof stringToken>;
    field: string;
    isKey: boolean;
    context: JsonContext | undefined;
  }[] = [];
  let previousEnd = -1;
  let previousKey = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "{" || char === "[") {
      const parent = contexts.at(-1);
      contexts.push({ ...(parent === undefined ? {} : { parent }), binary: false, media: false });
    } else if (char === "}" || char === "]") contexts.pop();
    else if (char === '"') {
      const start = index++;
      while (text[index] !== '"') {
        if (text[index] === "\\") index++;
        index++;
      }
      const token = stringToken(text, start, index + 1);
      const isKey = /^\s*:/.test(text.slice(index + 1));
      const field = !isKey && previousEnd >= 0 && /^\s*:\s*$/.test(text.slice(previousEnd, start)) ? previousKey : "";
      const context = contexts.at(-1);
      if (context !== undefined && (field === "type" || field === "encoding")) {
        if (token.decoded === "base64") context.binary = true;
        if (MEDIA_TYPES.has(token.decoded)) context.media = true;
      }
      tokens.push({ token, field, isKey, context });
      previousEnd = index + 1;
      previousKey = isKey ? token.decoded : "";
    }
  }
  return tokens;
}

function opaqueToken(field: string, context: JsonContext | undefined): boolean {
  if (/^(?:base64|bytes[_-]?base64|data[_-]?base64|[a-z_]*b64)$/i.test(field)) return true;
  if (!/^(?:data|bytes|image|audio|blob)$/i.test(field)) return false;
  for (let current = context; current !== undefined; current = current.parent) {
    if (current.binary || current.media) return true;
  }
  return false;
}

function textFindings(text: string, credentialField: boolean): Finding[] {
  const scanned = scan(text);
  if (scanned.status !== "ok") throw new NativeCaptureError("SCAN_FAILED", "Security scanning did not complete.");
  const findings = [...scanned.findings];
  if (credentialField && text.length > 0 && text !== "[REDACTED]") {
    findings.push({ category: "credential-field", severity: "high", offset: 0, length: text.length, matchedText: text });
  }
  for (const [category, pattern] of [
    ["authorization", /\bBearer[ \t]+[A-Za-z0-9._~+/-]+=*/gi],
    ["credential-assignment", /\b[A-Za-z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|CLIENT_SECRET|SECRET_KEY)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ category, severity: "high", offset: match.index, length: match[0].length, matchedText: match[0] });
    }
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    let url: URL;
    try { url = new URL(match[0]); } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      continue;
    }
    if (url.username || url.password ||
        [...url.searchParams.keys()].some((key) => /^(sig|signature|token|access_token|api_key|key|x-amz-signature)$/i.test(key))) {
      findings.push({ category: "credential-url", severity: "high", offset: match.index, length: match[0].length, matchedText: match[0] });
    }
  }
  const merged: Finding[] = [];
  for (const finding of findings.sort((a, b) => a.offset - b.offset || b.length - a.length)) {
    const previous = merged.at(-1);
    if (previous !== undefined && finding.offset < previous.offset + previous.length) {
      const end = Math.max(previous.offset + previous.length, finding.offset + finding.length);
      merged[merged.length - 1] = {
        category: [...new Set([...previous.category.split("+"), finding.category])].sort().join("+"),
        severity: previous.severity === "high" || finding.severity === "high" ? "high" : previous.severity,
        offset: previous.offset, length: end - previous.offset, matchedText: text.slice(previous.offset, end),
      };
    } else merged.push(finding);
  }
  return merged;
}

function ownerMatches(text: string, redactions: readonly OwnerRedaction[]): Array<{
  readonly ruleIndex: number;
  readonly offset: number;
  readonly length: number;
  readonly matchedText: string;
  readonly replacementText: string;
}> {
  const matches = [];
  for (const [ruleIndex, redaction] of redactions.entries()) {
    const exactText = redaction.exactText;
    const replacementText = redaction.replacementText ?? "[REDACTED]";
    const nfc = exactText.normalize("NFC");
    const nfd = exactText.normalize("NFD");
    const forms = nfc === nfd ? [nfc] : [nfd, nfc];
    const escaped = forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const pattern = new RegExp(escaped, redaction.caseSensitive === true ? "gu" : "giu");
    for (const match of text.matchAll(pattern)) {
      matches.push({
        ruleIndex,
        offset: match.index,
        length: match[0].length,
        matchedText: match[0],
        replacementText,
      });
    }
  }
  return matches.sort((a, b) => a.offset - b.offset || b.length - a.length);
}

function locateFindings(
  archive: NativeSessionArchive,
  seed: string,
  metadata?: { readonly title: string; readonly summary: string },
  ownerRedactions: readonly OwnerRedaction[] = [],
): LocatedFinding[] {
  const findings: LocatedFinding[] = [];
  // V2 retains its original finding set so confirmed unknown-outcome retries
  // keep their existing resolution IDs and idempotency keys.
  if (archive.format === NATIVE_SESSION_ARCHIVE_FORMAT && hasNativeSessionBundle(archive)) {
    findings.push({
      id: hash(JSON.stringify([seed, "unscannable-native-bundle"])),
      category: "unscannable-native-bundle", severity: "high", source: "native-session.zip",
      offset: 0, length: 0, proposedReplacement: NATIVE_SESSION_BUNDLE_WARNING, manualReview: true,
      target: "native-bundle", rawText: "", decodedText: "", leafPath: "", leafOffset: 0, leafLength: 0, encodingDepth: 0,
    });
  }
  for (const [index, file] of archive.files.entries()) {
    if (file.contentEncoding !== "base64") continue;
    findings.push({
      id: hash(JSON.stringify([seed, index, file.sha256, "unscannable-binary"])),
      category: "unscannable-binary", severity: "high", source: file.path,
      offset: 0, length: 0, proposedReplacement: UNSCANNED_WARNING, manualReview: true,
      target: `file/${index}/opaque-bytes`, rawText: file.content, decodedText: file.sha256,
      leafPath: "", leafOffset: 0, leafLength: 0, encodingDepth: 0,
    });
  }
  for (const target of targets(archive, metadata)) {
    function manual(text: string, toRaw: (offset: number) => number, depth: number, leafPath: string): void {
      const offset = toRaw(0);
      const end = toRaw(text.length);
      const rawText = target.text.slice(offset, end);
      findings.push({
        id: hash(JSON.stringify([seed, target.id, offset, end, "unscannable-media", rawText])),
        category: "unscannable-media", severity: "high", source: target.source,
        offset, length: end - offset, proposedReplacement: UNSCANNED_WARNING, manualReview: true,
        target: target.id, rawText, decodedText: text, leafPath, leafOffset: 0,
        leafLength: text.length, encodingDepth: depth,
      });
    }
    function visit(text: string, toRaw: (offset: number) => number, depth: number, leafPath: string, field = "", opaque = false): void {
      if (findings.length > 10_000) throw new NativeCaptureError("REVIEW_LIMIT", "Too many findings for one review; no content was excluded or uploaded.");
      if (depth > 32) throw new NativeCaptureError("SCAN_FAILED", "Encoded source nesting exceeds the supported security review depth.");
      if (archive.format === NATIVE_SESSION_ARCHIVE_FORMAT && target.fileIndex !== undefined) {
        if (opaque) {
          manual(text, toRaw, depth, `${leafPath}/opaque`);
          return;
        }
        if ((field === "type" && (MEDIA_TYPES.has(text) || text === "base64")) ||
            (field === "encoding" && text === "base64")) {
          manual(text, toRaw, depth, `${leafPath}/media`);
        }
      }
      if (!CREDENTIAL_FIELD.test(field) && isStructured(text)) {
        let ordinal = 0;
        for (const { token, field: contextKey, isKey, context } of structuredTokens(text)) {
          visit(token.decoded, (offset) => toRaw(token.offset(offset)), depth + 1,
            `${leafPath}/${ordinal++}`, contextKey, !isKey && opaqueToken(contextKey, context));
        }
        return;
      }
      if (archive.format === NATIVE_SESSION_ARCHIVE_FORMAT && target.fileIndex !== undefined && !CREDENTIAL_FIELD.test(field)) {
        const media = [...text.matchAll(/\bdata:[^\s,"']*;base64,[A-Za-z0-9+/=]+/gi)];
        if (media.length > 0) {
          let start = 0;
          for (const [index, match] of media.entries()) {
            const prefix = start;
            visit(text.slice(start, match.index), (offset) => toRaw(prefix + offset), depth, `${leafPath}/text/${index}`);
            manual(match[0], (offset) => toRaw(match.index + offset), depth, `${leafPath}/data/${index}`);
            start = match.index + match[0].length;
          }
          visit(text.slice(start), (offset) => toRaw(start + offset), depth, `${leafPath}/text/${media.length}`);
          return;
        }
        if (nativeFileNeedsUnscannedReview({
          path: target.source, kind: "events", content: text, recordCount: 0, sha256: "",
        })) {
          manual(text, toRaw, depth, `${leafPath}/unparsed-media`);
          return;
        }
      }
      const securityFindings = textFindings(text, CREDENTIAL_FIELD.test(field));
      const requested = ownerMatches(text, ownerRedactions);
      for (let index = 1; index < requested.length; index++) {
        const previous = requested[index - 1]!;
        const current = requested[index]!;
        if (current.offset < previous.offset + previous.length) {
          throw new NativeCaptureError("INVALID_OWNER_REDACTION", "Owner-requested exact-text redactions must not overlap.");
        }
      }
      for (const security of securityFindings) {
        for (const requestedMatch of requested) {
          const securityEnd = security.offset + security.length;
          const requestedEnd = requestedMatch.offset + requestedMatch.length;
          if (requestedMatch.offset >= securityEnd || security.offset >= requestedEnd) continue;
          if (requestedMatch.offset <= security.offset && requestedEnd >= securityEnd) continue;
          throw new NativeCaptureError(
            "INVALID_OWNER_REDACTION",
            "An owner-requested redaction partially overlaps a detected security finding. Redact the complete detected value or resolve that finding separately.",
          );
        }
      }
      const uncoveredSecurityFindings = securityFindings.filter((security) => !requested.some((requestedMatch) =>
        requestedMatch.offset <= security.offset &&
        requestedMatch.offset + requestedMatch.length >= security.offset + security.length));
      for (const finding of uncoveredSecurityFindings) {
        const offset = toRaw(finding.offset);
        const end = toRaw(finding.offset + finding.length);
        const rawText = target.text.slice(offset, end);
        findings.push({
          id: hash(JSON.stringify([seed, target.id, offset, end, finding.category, rawText])),
          category: finding.category, severity: finding.severity,
          source: target.source, offset, length: end - offset,
          proposedReplacement: "[REDACTED]", target: target.id, rawText,
          decodedText: finding.matchedText, leafPath, leafOffset: finding.offset,
          leafLength: finding.length, encodingDepth: depth,
        });
        if (findings.length > 10_000) throw new NativeCaptureError("REVIEW_LIMIT", "Too many findings for one review; no content was excluded or uploaded.");
      }
      for (const match of requested) {
        const offset = toRaw(match.offset);
        const end = toRaw(match.offset + match.length);
        const rawText = target.text.slice(offset, end);
        findings.push({
          id: hash(JSON.stringify([seed, "owner-requested", match.ruleIndex, target.id, offset, end, rawText])),
          category: "owner-requested", severity: "low", source: target.source,
          offset, length: end - offset, proposedReplacement: match.replacementText,
          target: target.id, rawText, decodedText: match.matchedText, leafPath,
          leafOffset: match.offset, leafLength: match.length, encodingDepth: depth,
          ownerAction: { kind: "custom-replacement", replacementText: match.replacementText },
          ownerRuleIndex: match.ruleIndex,
        });
        if (findings.length > 10_000) throw new NativeCaptureError("REVIEW_LIMIT", "Too many findings for one review; no content was excluded or uploaded.");
      }
    }
    if (target.jsonLines) {
      let offset = 0;
      for (const [index, line] of target.text.split("\n").entries()) {
        const start = offset;
        visit(line, (position) => start + position, 0, `line/${index}`);
        offset += line.length + 1;
      }
    } else visit(target.text, (offset) => offset, 0, "");
  }
  if (findings.length > 10_000) throw new NativeCaptureError("REVIEW_LIMIT", "Too many findings for one review; no content was excluded or uploaded.");
  return findings;
}

export function scanNativeCapture(
  archive: NativeSessionArchive,
  seed: string,
  ownerRedactions: readonly OwnerRedaction[] = [],
): readonly CaptureFinding[] {
  return locateFindings(archive, seed, undefined, ownerRedactions)
    .filter((finding) => finding.ownerAction === undefined)
    .map(publicFinding);
}

/**
 * The exact set of finding IDs `resolveNativeCapture` would recognize as
 * "known" for this archive/metadata/owner-redaction combination. Callers use
 * this to drop resolutions that no longer correspond to any current finding
 * (for example, a metadata edit that removed the secret a resolution used to
 * target) *before* calling `resolveNativeCapture`, which otherwise rejects
 * any resolution referencing an unrecognized finding ID as invalid rather
 * than treating it as moot.
 */
export function knownFindingIds(
  archive: NativeSessionArchive,
  seed: string,
  metadata?: { readonly title: string; readonly summary: string },
  ownerRedactions: readonly OwnerRedaction[] = [],
): ReadonlySet<string> {
  return new Set(locateFindings(archive, seed, metadata, ownerRedactions).map((finding) => finding.id));
}

export interface ReviewedCapture {
  readonly archive: NativeSessionArchive;
  readonly content: string;
  readonly title: string;
  readonly summary: string;
  readonly falsePositiveSpellings: readonly string[];
  /** Surviving owner-approved metadata findings, rebased to the resulting text. */
  readonly metadataResolutions: readonly CaptureResolution[];
}

export function derivePublicationContentDecisions(
  archive: NativeSessionArchive,
  seed: string,
  metadata: { readonly title: string; readonly summary: string },
  ownerRedactions: readonly OwnerRedaction[] = [],
  resolutions: readonly CaptureResolution[] = [],
): readonly PublicationContentDecision[] {
  const findings = locateFindings(archive, seed, metadata, ownerRedactions);
  const actions = new Map<string, ResolutionAction>(
    findings.flatMap((finding) =>
      finding.ownerAction === undefined || finding.manualReview
        ? []
        : [[finding.id, finding.ownerAction] as const],
    ),
  );
  const known = new Map(findings.map((finding) => [finding.id, finding]));
  for (const resolution of resolutions) {
    const finding = known.get(resolution.findingId);
    if (
      finding === undefined ||
      finding.manualReview ||
      resolution.action.kind === "acknowledge-unscanned" ||
      actions.has(resolution.findingId)
    ) {
      continue;
    }
    actions.set(resolution.findingId, resolution.action);
  }
  return findings.flatMap((finding): PublicationContentDecision[] => {
    const action = actions.get(finding.id);
    if (action === undefined) {
      return [];
    }
    return [{
      findingId: finding.id,
      finding: {
        category: finding.category,
        matchedText: finding.decodedText,
      },
      action,
    }];
  });
}

function findingKey(finding: LocatedFinding, offset = finding.leafOffset): string {
  return JSON.stringify([finding.target, finding.leafPath, offset, finding.category, finding.decodedText]);
}

export function resolveNativeCapture(
  archive: NativeSessionArchive,
  seed: string,
  resolutions: readonly CaptureResolution[],
  metadata: { readonly title: string; readonly summary: string },
  ownerRedactions: readonly OwnerRedaction[] = [],
): ReviewedCapture {
  for (const redaction of ownerRedactions) {
    const exactText = redaction.exactText;
    const replacementText = redaction.replacementText ?? "[REDACTED]";
    if (!exactText || exactText.length > 10_000 || replacementText.length > 1_000_000) {
      throw new NativeCaptureError("INVALID_OWNER_REDACTION", "Owner redactions require exactText of 1-10,000 characters and replacementText of at most 1,000,000 characters.");
    }
    const exactNfc = redaction.caseSensitive === true ? exactText.normalize("NFC") : exactText.normalize("NFC").toLocaleLowerCase();
    const exactNfd = redaction.caseSensitive === true ? exactText.normalize("NFD") : exactText.normalize("NFD").toLocaleLowerCase();
    const replNfc = redaction.caseSensitive === true ? replacementText.normalize("NFC") : replacementText.normalize("NFC").toLocaleLowerCase();
    const replNfd = redaction.caseSensitive === true ? replacementText.normalize("NFD") : replacementText.normalize("NFD").toLocaleLowerCase();
    if (replNfc.includes(exactNfc) || replNfd.includes(exactNfd)) {
      throw new NativeCaptureError("INVALID_OWNER_REDACTION", "A replacement must not contain the exact text it replaces.");
    }
  }
  const findings = locateFindings(archive, seed, metadata, ownerRedactions);
  const reviewTargets = targets(archive, metadata);
  const actions = new Map<string, CaptureResolution["action"]>(
    findings.flatMap((finding) => finding.ownerAction === undefined ? [] : [[finding.id, finding.ownerAction] as const]),
  );
  const matchedOwnerRules = new Set(findings.flatMap((finding) =>
    finding.ownerRuleIndex === undefined ? [] : [finding.ownerRuleIndex]));
  const unmatchedOwnerRules = ownerRedactions.flatMap((_, index) => matchedOwnerRules.has(index) ? [] : [index]);
  if (unmatchedOwnerRules.length > 0) {
    throw new NativeCaptureError(
      "OWNER_REDACTION_NOT_FOUND",
      `Owner-requested exact text was not found for rule index(es): ${unmatchedOwnerRules.join(", ")}. Nothing was uploaded.`,
    );
  }
  const known = new Map(findings.map((finding) => [finding.id, finding]));
  for (const resolution of resolutions) {
    if (!known.has(resolution.findingId) || actions.has(resolution.findingId)) {
      throw new NativeCaptureError("INVALID_RESOLUTION", "Every resolution must reference a distinct finding in this exact capture and metadata.");
    }
    if (known.get(resolution.findingId)!.manualReview) {
      if (resolution.action.kind !== "acknowledge-unscanned") {
        throw new NativeCaptureError("INVALID_RESOLUTION",
          "Unscannable content requires explicit acknowledge-unscanned approval. It cannot be redacted as text or dismissed as a false positive.");
      }
    } else if (resolution.action.kind === "acknowledge-unscanned") {
      throw new NativeCaptureError("INVALID_RESOLUTION", "Text security findings require an explicit redaction, replacement, or false-positive resolution.");
    }
    actions.set(resolution.findingId, resolution.action);
  }
  const missing = findings.filter(({ id }) => !actions.has(id));
  if (missing.length > 0) throw new CaptureReviewRequiredError(missing.map(publicFinding));

  const values = new Map<string, string>();
  const expectedFalsePositives = new Set<string>();
  for (const finding of findings) {
    const action = actions.get(finding.id)!;
    if (action.kind === "acknowledge-unscanned") {
      expectedFalsePositives.add(findingKey(finding));
      continue;
    }
    if (action.kind !== "false-positive" && action.kind !== "owner-override-unredacted") {
      if (action.kind === "custom-replacement" && finding.category.split("+").includes("credential-field")) {
        expectedFalsePositives.add(JSON.stringify([
          finding.target, finding.leafPath, finding.leafOffset, "credential-field", action.replacementText,
        ]));
      }
      continue;
    }
    let offset = finding.leafOffset;
    for (const earlier of findings) {
      const earlierAction = actions.get(earlier.id)!;
      if (earlier.target !== finding.target || earlier.leafPath !== finding.leafPath ||
          earlier.leafOffset >= finding.leafOffset || earlierAction.kind === "false-positive" ||
          earlierAction.kind === "owner-override-unredacted" ||
          earlierAction.kind === "acknowledge-unscanned") continue;
      offset += (earlierAction.kind === "accept-redaction" ? "[REDACTED]" : earlierAction.replacementText).length - earlier.leafLength;
    }
    expectedFalsePositives.add(findingKey(finding, offset));
  }
  for (const target of reviewTargets) {
    const selected = findings.filter((finding) => finding.target === target.id && !finding.manualReview);
    values.set(target.id, applyResolutions(target.text, selected.map((finding) => ({
      category: finding.category, severity: finding.severity, offset: finding.offset,
      length: finding.length, matchedText: finding.rawText,
    })), selected.map((finding, findingIndex): FindingResolution => {
      const action = actions.get(finding.id)!;
      if (action.kind === "acknowledge-unscanned") {
        throw new NativeCaptureError("INVALID_RESOLUTION", "An unscanned acknowledgment cannot edit text.");
      }
      return {
        findingIndex,
        action: (action.kind === "false-positive" || action.kind === "owner-override-unredacted") ? action : {
          kind: "custom-replacement",
          replacementText: encodeFragment(action.kind === "accept-redaction" ? "[REDACTED]" : action.replacementText, finding.encodingDepth),
        },
      };
    })));
  }
  const paths = new Map(archive.files.flatMap((file, index) => {
    const approvedPath = values.get(`file/${index}/path`)!;
    return approvedPath === file.path ? [] : [[pathKey(file.path), approvedPath] as const];
  }));
  const remapSource = (source: string): string => {
    const key = pathKey(source);
    const direct = paths.get(key);
    if (direct !== undefined) return direct;
    for (const [oldPath, newPath] of paths) {
      if (key.startsWith(`${oldPath}:`) || key.startsWith(`${oldPath} (UTF-8 bytes `)) {
        return newPath + key.slice(oldPath.length);
      }
    }
    return source;
  };
  const redactions: NativeRedaction[] = archive.redactions.map((redaction, index) => ({
    ...redaction,
    source: remapSource(values.get(`redaction/${index}/source`) ?? redaction.source),
  }));
  for (const finding of findings) {
    const action = actions.get(finding.id)!;
    if (action.kind === "false-positive" || action.kind === "owner-override-unredacted" ||
        action.kind === "acknowledge-unscanned") continue;
    redactions.push({ id: finding.id, category: finding.category, source: safeReviewText(remapSource(finding.source)) });
  }
  const files = archive.files.map((file, index): NativeArchiveFile => {
      const originalBytes = nativeFileContentBytes(file);
      let contentBytes = originalBytes;
      if (file.contentEncoding !== "base64") {
        contentBytes = Buffer.from(values.get(`file/${index}/content`)!, "utf8");
      }
      const changed = !contentBytes.equals(originalBytes);
      const content = changed ? contentBytes.toString(file.contentEncoding === "base64" ? "base64" : "utf8") : file.content;
      let native = {};
      if (changed && file.nativeEncoding === "zstd") {
        if (!("zstdCompressSync" in zlib) || typeof zlib.zstdCompressSync !== "function") {
          throw new NativeCaptureError("UNSUPPORTED_COMPRESSION", "Updating a compressed native source requires built-in Zstandard support.");
        }
        const bytes: unknown = zlib.zstdCompressSync(contentBytes);
        if (!Buffer.isBuffer(bytes)) throw new NativeCaptureError("INVALID_COMPRESSED_SOURCE", "Expected native compressed bytes.");
        native = { nativeBytesBase64: bytes.toString("base64"), nativeSha256: createHash("sha256").update(bytes).digest("hex") };
      }
      return {
        ...file, path: values.get(`file/${index}/path`)!, content,
        sha256: changed ? createHash("sha256").update(contentBytes).digest("hex") : file.sha256,
        recordCount: changed && archive.format === NATIVE_SESSION_ARCHIVE_FORMAT && file.kind === "events"
          ? inspectNativeJsonl(contentBytes).records.length : file.recordCount,
        ...native,
      };
  });
  const sourceEdited = reviewTargets.some((target) => target.id !== "title" && target.id !== "summary" && values.get(target.id) !== target.text);
  const reviewed: NativeSessionArchive = {
    ...archive,
    harnessSessionId: values.get("harnessSessionId")!,
    harness: { ...archive.harness, version: values.get("harnessVersion")! },
    sourceFormat: values.get("sourceFormat")!,
    files,
    ...(archive.capture === undefined ? {} : {
      capture: {
        ...archive.capture,
        entrypoint: remapSource(archive.capture.entrypoint),
        sources: archive.capture.sources.map((source, index) => ({
          ...source, path: remapSource(source.path),
          ...(source.originalPath === undefined ? {} : {
            originalPath: remapSource(values.get(`source/${index}/originalPath`)!),
          }),
        })),
        history: archive.capture.history.map((segment, index) => ({
          ...segment, path: remapSource(segment.path),
          sessionId: segment.sessionId === archive.harnessSessionId ? values.get("harnessSessionId")! : values.get(`history/${index}/sessionId`)!,
          ...(segment.rolloutId === undefined ? {} : {
            rolloutId: segment.rolloutId === archive.harnessSessionId ? values.get("harnessSessionId")! : values.get(`history/${index}/rolloutId`)!,
          }),
        })),
        diagnostics: archive.capture.diagnostics.map((diagnostic, index) => ({
          ...diagnostic, source: remapSource(values.get(`diagnostic/${index}/source`) ?? diagnostic.source),
        })),
      },
    }),
    ...(sourceEdited && archive.format === NATIVE_SESSION_ARCHIVE_FORMAT ? {
      restoration: {
        status: "invalidated-by-security-edits",
        reason: "Owner-approved security edits changed source bytes, paths or metadata. Original source hashes and history bounds remain provenance; inherited byte offsets were not rebased and native restoration is not verified.",
      },
    } : archive.restoration === undefined ? {} : {
      restoration: { ...archive.restoration, reason: values.get("restoration/reason")! },
    }),
    redactions,
  };
  const title = values.get("title")!;
  const summary = values.get("summary")!;
  const remaining = locateFindings(reviewed, seed, { title, summary });
  const unexpected = remaining.filter((finding) => !expectedFalsePositives.has(findingKey(finding)));
  if (unexpected.length > 0) {
    throw new CaptureReviewRequiredError(unexpected.map(publicFinding), "A replacement introduced a new or changed security finding. Choose a safe replacement; nothing was uploaded.");
  }
  const content = JSON.stringify(reviewed);
  if (parseNativeSessionArchive(content) === null) throw new NativeCaptureError("INVALID_CAPTURE", "The approved variant is not a native archive.");
  const falsePositiveSpellings = [
    ...remaining.flatMap((finding) => [finding.decodedText, finding.rawText, encodeFragment(finding.rawText, 1)]),
    ...archiveFalsePositiveSpellings(reviewed),
  ];
  const metadataResolutions = remaining.filter((finding) => finding.target === "title" || finding.target === "summary")
    .map((finding): CaptureResolution => ({ findingId: finding.id, action: { kind: "false-positive" } }));
  return { archive: reviewed, content, title, summary, falsePositiveSpellings, metadataResolutions };
}

/**
 * Spellings implied by the reviewed archive itself rather than by a specific
 * review pass. The decoded content was reviewed, so accidental detector matches
 * in its compression encoding are not additional plaintext findings.
 *
 * These are recomputed rather than stored when an approved variant is reloaded
 * from disk, because they restate bytes the archive already carries.
 */
export function archiveFalsePositiveSpellings(archive: NativeSessionArchive): readonly string[] {
  return archive.files.flatMap((file) => file.nativeBytesBase64 === undefined ? [] : [file.nativeBytesBase64]);
}

/** Re-scans still run; only findings covered by the exact reviewed variant can be dismissed. */
export function resolveReviewedFindings(
  capture: ReviewedCapture,
  findings: readonly Finding[],
): readonly FindingResolution[] | null {
  if (findings.some((finding) => !capture.falsePositiveSpellings.some((text) =>
    text.includes(finding.matchedText)))) return null;
  return findings.map((_, findingIndex) => ({ findingIndex, action: { kind: "false-positive" } }));
}
