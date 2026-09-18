import { crc32 as zlibCrc32 } from "node:zlib";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const REGULAR_FILE_EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;

function crc(data: Uint8Array): number {
  return zlibCrc32(data) >>> 0;
}

export interface RawZipEntrySpec {
  readonly name: string;
  readonly data: Uint8Array;
  readonly localName?: string;
  readonly method?: number;
  readonly localMethod?: number;
  readonly gpFlag?: number;
  readonly localGpFlag?: number;
  readonly crc32?: number;
  readonly localCrc32?: number;
  readonly compressedSize?: number;
  readonly uncompressedSize?: number;
  readonly localCompressedSize?: number;
  readonly localUncompressedSize?: number;
  readonly centralExtraLength?: number;
  readonly localExtraLength?: number;
  readonly centralCommentLength?: number;
  readonly externalAttributes?: number;
  /** Raw override for the name bytes actually written (both central and local), bypassing UTF-8 string encoding entirely. */
  readonly nameBytesOverride?: Uint8Array;
}

export interface RawZipSpec {
  readonly entries: readonly RawZipEntrySpec[];
  readonly totalEntriesOverride?: number;
  readonly entriesThisDiskOverride?: number;
}

function buildLocalRecord(entry: RawZipEntrySpec): Buffer {
  const localName = entry.nameBytesOverride ? Buffer.from(entry.nameBytesOverride) : Buffer.from(entry.localName ?? entry.name, "utf8");
  const data = Buffer.from(entry.data);
  const localExtra = Buffer.alloc(entry.localExtraLength ?? 0);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(entry.localGpFlag ?? entry.gpFlag ?? 0x0800, 6);
  header.writeUInt16LE(entry.localMethod ?? entry.method ?? 0, 8);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE((entry.localCrc32 ?? entry.crc32 ?? crc(data)) >>> 0, 14);
  header.writeUInt32LE(entry.localCompressedSize ?? entry.compressedSize ?? data.length, 18);
  header.writeUInt32LE(entry.localUncompressedSize ?? entry.uncompressedSize ?? data.length, 22);
  header.writeUInt16LE(localName.length, 26);
  header.writeUInt16LE(localExtra.length, 28);
  return Buffer.concat([header, localName, localExtra, data]);
}

/**
 * A low-level, fully overridable raw ZIP builder for adversarial fixtures.
 * Every field defaults to a value that satisfies both yauzl's own parsing
 * and `nativeSessionBundleReader`'s app-owned restrictions, so a test only
 * needs to override the one field it means to corrupt.
 */
export function buildRawZip(spec: RawZipSpec): Buffer {
  const localChunks: Buffer[] = [];
  const localOffsets: number[] = [];
  let cursor = 0;

  for (const entry of spec.entries) {
    const record = buildLocalRecord(entry);
    localOffsets.push(cursor);
    localChunks.push(record);
    cursor += record.length;
  }

  const localSection = Buffer.concat(localChunks);
  const cdOffset = localSection.length;

  const centralChunks: Buffer[] = [];
  spec.entries.forEach((entry, index) => {
    const name = entry.nameBytesOverride ? Buffer.from(entry.nameBytesOverride) : Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const centralExtra = Buffer.alloc(entry.centralExtraLength ?? 0);
    const centralComment = Buffer.alloc(entry.centralCommentLength ?? 0);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.gpFlag ?? 0x0800, 8);
    header.writeUInt16LE(entry.method ?? 0, 10);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE((entry.crc32 ?? crc(data)) >>> 0, 16);
    header.writeUInt32LE(entry.compressedSize ?? data.length, 20);
    header.writeUInt32LE(entry.uncompressedSize ?? data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(centralExtra.length, 30);
    header.writeUInt16LE(centralComment.length, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt32LE(entry.externalAttributes ?? REGULAR_FILE_EXTERNAL_ATTRIBUTES, 38);
    header.writeUInt32LE(localOffsets[index]!, 42);
    centralChunks.push(Buffer.concat([header, name, centralExtra, centralComment]));
  });

  const centralSection = Buffer.concat(centralChunks);
  const cdSize = centralSection.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(spec.entriesThisDiskOverride ?? spec.entries.length, 8);
  eocd.writeUInt16LE(spec.totalEntriesOverride ?? spec.entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([localSection, centralSection, eocd]);
}

/** A single valid stored entry with sane defaults, ready to override piecemeal. */
export function rawEntry(name: string, content: string, overrides: Partial<RawZipEntrySpec> = {}): RawZipEntrySpec {
  return { name, data: Buffer.from(content, "utf8"), ...overrides };
}

/** A minimal, fully valid single-entry archive — the baseline every hostile fixture perturbs. */
export function validRawZip(overrides: Partial<RawZipEntrySpec> = {}): Buffer {
  return buildRawZip({ entries: [rawEntry("a.txt", "hello world", overrides)] });
}