/**
 * Carrying a photograph's metadata through an export.
 *
 * The export re-encodes pixels through a canvas, which strips every metadata
 * segment the source carried — camera, lens, exposure settings, capture time,
 * and with them any gallery's ability to sort or attribute the file. This
 * module reattaches what the source had: it extracts the EXIF block from the
 * formats a camera actually produces, rewrites the one tag the export has
 * already applied physically (orientation — the pixels leave already rotated,
 * so keeping the original tag would double-rotate them), and splices the
 * block into the encoded output.
 *
 * Extraction dispatches on the file's own magic bytes, never its extension:
 * a JPEG's APP1 segment, an ISOBMFF container's Exif item (HEIC, HEIF, AVIF,
 * CR3), a PNG's eXIf chunk, and the TIFF family most camera RAW sits in.
 * TIFF-family RAW files can run to tens of megabytes with the EXIF a few
 * hundred bytes of it, so their block is rebuilt: the tags worth keeping are
 * read out and re-serialised into a minimal, canonical block — which is also
 * what gets synthesised from the decoder's own metadata when a RAW yields
 * nothing parseable.
 *
 * WebP and AVIF output cannot carry EXIF through `canvas.toBlob`'s encoders,
 * so for those the splice is a no-op and the interface says so.
 */

import type { ExportFormat } from './export';

// --- byte-level helpers -----------------------------------------------------

/** APP1 length field minus its segment header minus the six "Exif\0\0" bytes. */
const MAX_EXIF_BYTES = 65533 - 6;

function bytesToAscii(bytes: Uint8Array, start: number, len: number): string {
  let s = '';
  const end = Math.min(start + len, bytes.length);
  for (let i = start; i < end; i++) {
    const b = bytes[i]!;
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s.trim();
}

const ASCII_ENCODER = new TextEncoder();

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    crcTable = t;
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Bounds-checked reads over one buffer, in either byte order. */
class Reader {
  constructor(readonly bytes: Uint8Array) {}

  get length() {
    return this.bytes.length;
  }

  u8(p: number) {
    return p >= 0 && p < this.bytes.length ? this.bytes[p] : undefined;
  }

  u16(p: number, le: boolean) {
    if (p < 0 || p + 2 > this.bytes.length) return undefined;
    return le ? this.bytes[p]! | (this.bytes[p + 1]! << 8) : (this.bytes[p]! << 8) | this.bytes[p + 1]!;
  }

  u32(p: number, le: boolean) {
    const hi = this.u16(p, le);
    const lo = this.u16(p + 2, le);
    return hi === undefined || lo === undefined ? undefined : ((hi << 16) | lo) >>> 0;
  }

  /** An n-byte big-endian field (n ≤ 4 keeps us inside a JS number). */
  sized(p: number, n: number): number | undefined {
    if (n === 0) return 0;
    if (n > 4) return undefined;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const b = this.u8(p + i);
      if (b === undefined) return undefined;
      v = v * 256 + b;
    }
    return v;
  }
}

/** An EXIF value this module carries: strings, numbers, or ratios. */


interface TagEntry {
  tag: number;
  type: number;
  count: number;
  /** Where the value lives, relative to the TIFF header (inline or pointed). */
  at: number | undefined;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readEntry(r: Reader, ifd: number, i: number, le: boolean): TagEntry | null {
  const e = ifd + 2 + i * 12;
  const tag = r.u16(e, le);
  const type = r.u16(e + 2, le);
  const count = r.u32(e + 4, le);
  if (tag === undefined || type === undefined || count === undefined) return null;
  const size = (TYPE_SIZE[type] ?? 0) * count;
  if (size === 0) return { tag, type, count, at: undefined };
  // Four bytes or fewer ride inline in the entry; anything longer is an offset.
  const at = size <= 4 ? e + 8 : r.u32(e + 8, le);
  return { tag, type, count, at };
}

function readAscii(r: Reader, e: TagEntry): string {
  return e.at === undefined ? '' : bytesToAscii(r.bytes, e.at, e.count);
}

function readRational(r: Reader, e: TagEntry): [number, number] | undefined {
  if (e.type !== 5 || e.count < 1 || e.at === undefined) return undefined;
  const n = r.u32(e.at, true);
  const d = r.u32(e.at + 4, true);
  return n !== undefined && d !== undefined && d !== 0 ? [n, d] : undefined;
}

function ifdEntries(r: Reader, ifd: number, le: boolean): TagEntry[] {
  const count = r.u16(ifd, le);
  if (count === undefined) return [];
  const out: TagEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = readEntry(r, ifd, i, le);
    if (e) out.push(e);
  }
  return out;
}

/** Walks an IFD chain (main, then any thumbnail IFD), bounded against corruption. */
function ifdChain(r: Reader, le: boolean): number[] {
  const out: number[] = [];
  let ifd = r.u32(4, le);
  let hops = 0;
  while (ifd !== undefined && ifd !== 0 && hops < 8) {
    out.push(ifd);
    const count = r.u16(ifd, le);
    if (count === undefined) break;
    ifd = r.u32(ifd + 2 + count * 12, le);
    hops++;
  }
  return out;
}

/** True when the bytes open as a TIFF header this module can read. */
function tiffEndian(bytes: Uint8Array): boolean | null {
  const magic = bytesToAscii(bytes, 0, 2);
  if (magic === 'II') return true;
  if (magic === 'MM') return false;
  return null;
}

// --- EXIF values ------------------------------------------------------------

/** What this module keeps from a source file — enough to rebuild its EXIF. */
interface ExifValues {
  make?: string;
  model?: string;
  dateTimeOriginal?: string;
  exposureTime?: [number, number];
  fNumber?: [number, number];
  iso?: number;
  focalLength?: [number, number];
  lensModel?: string;
}

/** Collects the kept tags from a TIFF block's IFD0 and its Exif sub-IFD. */
function parseExifValues(bytes: Uint8Array): ExifValues {
  const endian = tiffEndian(bytes);
  if (endian === null) return {};
  const le = endian;
  const r = new Reader(bytes);
  if (r.u16(2, le) !== 42) return {};

  const v: ExifValues = {};
  let exifIfd: number | undefined;
  for (const ifd of ifdChain(r, le)) {
    for (const e of ifdEntries(r, ifd, le)) {
      switch (e.tag) {
        case 0x010f:
          v.make = readAscii(r, e) || undefined;
          break;
        case 0x0110:
          v.model = readAscii(r, e) || undefined;
          break;
        case 0x8769:
          if (e.type === 4 && e.at !== undefined) exifIfd = r.u32(e.at, le);
          break;
      }
    }
  }
  if (exifIfd === undefined || exifIfd >= bytes.length) return v;
  for (const e of ifdEntries(r, exifIfd, le)) {
    switch (e.tag) {
      case 0x829a:
        v.exposureTime = readRational(r, e);
        break;
      case 0x829d:
        v.fNumber = readRational(r, e);
        break;
      case 0x8827: {
        const iso = e.type === 3 && e.at !== undefined ? r.u16(e.at, le) : undefined;
        v.iso = iso;
        break;
      }
      case 0x9003:
        v.dateTimeOriginal = readAscii(r, e) || undefined;
        break;
      case 0x920a:
        v.focalLength = readRational(r, e);
        break;
      case 0xa434:
        v.lensModel = readAscii(r, e) || undefined;
        break;
    }
  }
  return v;
}

/**
 * Orientation → 1 across every IFD the block carries. The pixels are exported
 * already rotated, so the tag must say "upright" or a reader will turn the
 * file again on display.
 */
function patchOrientation(bytes: Uint8Array): Uint8Array {
  const endian = tiffEndian(bytes);
  if (endian === null || bytes.length < 8) return bytes;
  const le = endian;
  const out = new Uint8Array(bytes);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const r = new Reader(out);
  for (const ifd of ifdChain(r, le)) {
    for (const e of ifdEntries(r, ifd, le)) {
      if (e.tag === 0x0112 && e.type === 3 && e.at !== undefined && e.at + 2 <= out.length) {
        dv.setUint16(e.at, 1, le);
      }
    }
  }
  return out;
}

// --- canonical block building ------------------------------------------------

const EXIF_VERSION = [0x30, 0x32, 0x33, 0x32]; // "0232"

/** One value destined for the canonical block: tag, type, and its payload. */
interface BuiltTag {
  tag: number;
  type: number;
  count: number;
  /** Serialized value; absent for the numeric constants carried inline. */
  data?: Uint8Array;
  /** The inline constant for SHORT/LONG tags with no payload. */
  inline?: number;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function nowExifDate(): string {
  const d = new Date();
  return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function rationalBytes([n, d]: [number, number]): Uint8Array {
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, Math.max(0, Math.round(n)), true);
  dv.setUint32(4, Math.max(1, Math.round(d)), true);
  return out;
}

/**
 * Builds a minimal, canonical EXIF block — IFD0 for the camera and the Exif
 * sub-IFD for the exposure — little-endian, no thumbnail IFD, no GPS. Only
 * tags that carry a value are emitted, in tag order as the format requires.
 */
function buildExifBlock(v: ExifValues): Uint8Array | null {
  const ifd0: BuiltTag[] = [];
  const sub: BuiltTag[] = [];
  const put = (arr: BuiltTag[], tag: number, type: number, count: number, data?: Uint8Array) =>
    arr.push({ tag, type, count, data });

  if (v.make) put(ifd0, 0x010f, 2, v.make.length + 1, ASCII_ENCODER.encode(v.make + '\0'));
  if (v.model) put(ifd0, 0x0110, 2, v.model.length + 1, ASCII_ENCODER.encode(v.model + '\0'));
  // Orientation is 1 by construction: the export's pixels are already upright,
  // and that is the whole point of the rewrite.
  ifd0.push({ tag: 0x0112, type: 3, count: 1, inline: 1 });
  put(ifd0, 0x0131, 2, 9, ASCII_ENCODER.encode('EMULSION\0'));
  put(ifd0, 0x0132, 2, 20, ASCII_ENCODER.encode(nowExifDate() + '\0'));
  if (v.exposureTime) put(sub, 0x829a, 5, 1, rationalBytes(v.exposureTime));
  if (v.fNumber) put(sub, 0x829d, 5, 1, rationalBytes(v.fNumber));
  if (v.iso !== undefined && v.iso > 0) sub.push({ tag: 0x8827, type: 3, count: 1, inline: v.iso });
  put(sub, 0x9000, 7, 4, new Uint8Array(EXIF_VERSION));
  if (v.dateTimeOriginal)
    put(
      sub,
      0x9003,
      2,
      20,
      ASCII_ENCODER.encode(v.dateTimeOriginal.padEnd(19, ' ').slice(0, 19) + '\0'),
    );
  if (v.focalLength) put(sub, 0x920a, 5, 1, rationalBytes(v.focalLength));
  if (v.lensModel) put(sub, 0xa434, 2, v.lensModel.length + 1, ASCII_ENCODER.encode(v.lensModel + '\0'));

  if (ifd0.length === 0 && sub.length === 0) return null;
  if (sub.length > 0) ifd0.push({ tag: 0x8769, type: 4, count: 1 });

  ifd0.sort((a, b) => a.tag - b.tag);
  sub.sort((a, b) => a.tag - b.tag);

  const subOffset = 8 + 2 + ifd0.length * 12 + 4;
  const subSize = sub.length > 0 ? 2 + sub.length * 12 + 4 : 0;

  // Lay the >4-byte values out after the IFDs, word-aligned, recording offsets.
  const data: Uint8Array[] = [];
  const offsets = new Map<BuiltTag, number>();
  let dataAt = subOffset + subSize;
  for (const t of [...ifd0, ...sub]) {
    if (t.data && t.data.length > 4) {
      offsets.set(t, dataAt);
      data.push(t.data);
      dataAt += t.data.length + (t.data.length % 2);
    }
  }

  const out = new Uint8Array(dataAt);
  const dv = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);

  const writeIfd = (at: number, tags: BuiltTag[], next: number) => {
    dv.setUint16(at, tags.length, true);
    tags.forEach((t, i) => {
      const e = at + 2 + i * 12;
      dv.setUint16(e, t.tag, true);
      dv.setUint16(e + 2, t.type, true);
      dv.setUint32(e + 4, t.count, true);
      if (t.tag === 0x8769) {
        dv.setUint32(e + 8, subOffset, true);
      } else if (t.data && t.data.length > 4) {
        dv.setUint32(e + 8, offsets.get(t)!, true);
      } else if (t.data) {
        out.set(t.data, e + 8);
      } else {
        dv.setUint16(e + 8, t.inline ?? 0, true);
      }
    });
    dv.setUint32(at + 2 + tags.length * 12, next, true);
  };

  writeIfd(8, ifd0, 0);
  if (sub.length > 0) writeIfd(subOffset, sub, 0);

  let p = subOffset + subSize;
  for (const t of [...ifd0, ...sub]) {
    if (t.data && t.data.length > 4) {
      out.set(t.data, p);
      p += t.data.length + (t.data.length % 2);
    }
  }
  return out;
}

// --- extraction -------------------------------------------------------------

/** The EXIF/TIFF block a source file carries, orientation normalised, or null. */
export async function extractExifBlock(file: File): Promise<Uint8Array | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (head.length < 12) return null;
    if (head[0] === 0xff && head[1] === 0xd8) return fromJpeg(file);
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      return fromPng(file);
    }
    if (tiffEndian(head) !== null) return fromTiffFamily(file);
    if (bytesToAscii(head, 4, 4) === 'ftyp') return fromIsoBmff(file);
    return null;
  } catch {
    // A file that will not parse simply exports without metadata.
    return null;
  }
}

/** A minimal EXIF block synthesised from the decoder's own metadata. */
export function synthesizedExifBlock(meta: {
  camera?: string;
  iso?: number;
  shutter?: number;
  aperture?: number;
  focalLength?: number;
}): Uint8Array | null {
  const v: ExifValues = {};
  if (meta.camera?.trim()) v.model = meta.camera.trim();
  if (meta.iso && meta.iso > 0) v.iso = Math.round(meta.iso);
  if (meta.shutter && meta.shutter > 0) v.exposureTime = ratioFor(meta.shutter);
  if (meta.aperture && meta.aperture > 0) v.fNumber = ratioFor(meta.aperture);
  if (meta.focalLength && meta.focalLength > 0) v.focalLength = ratioFor(meta.focalLength);
  return buildExifBlock(v);
}

/** Any positive scalar as an EXIF rational: two decimals of precision. */
function ratioFor(x: number): [number, number] {
  return [Math.round(x * 100), 100];
}

// --- per-container extraction ------------------------------------------------

const MAX_SCAN_BYTES = 4 * 1024 * 1024;

async function fromJpeg(file: File): Promise<Uint8Array | null> {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_SCAN_BYTES)).arrayBuffer());
  const r = new Reader(head);
  let pos = 2;
  for (let hops = 0; hops < 128; hops++) {
    if (r.u8(pos) !== 0xff) return null;
    const marker = r.u8(pos + 1);
    if (marker === undefined) return null;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // image data begins
    const len = r.u16(pos + 2, false);
    if (len === undefined || len < 2) return null;
    if (marker === 0xe1 && bytesToAscii(head, pos + 4, 4) === 'Exif') {
      return patchOrientation(head.slice(pos + 10, pos + 2 + len));
    }
    pos += 2 + len;
  }
  return null;
}

async function fromPng(file: File): Promise<Uint8Array | null> {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_SCAN_BYTES)).arrayBuffer());
  const r = new Reader(head);
  let pos = 8;
  for (let hops = 0; hops < 256; hops++) {
    const len = r.u32(pos, false);
    if (len === undefined || pos + 12 + len > head.length) return null;
    const type = bytesToAscii(head, pos + 4, 4);
    if (type === 'eXIf') return patchOrientation(head.slice(pos + 8, pos + 8 + len));
    if (type === 'IDAT') return null; // image data begins
    pos += 12 + len;
  }
  return null;
}

/**
 * TIFF-family sources — TIFF itself and most camera RAW. The IFDs here are
 * the tip of a potentially enormous file, so the block is rebuilt from the
 * tags worth keeping rather than sliced out whole.
 */
async function fromTiffFamily(file: File): Promise<Uint8Array | null> {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_SCAN_BYTES)).arrayBuffer());
  return buildExifBlock(parseExifValues(head));
}

/**
 * ISOBMFF containers — HEIC, HEIF, AVIF, and CR3 — carry EXIF as a file item,
 * located through the meta box's item table (iinf/infe) and extent list (iloc).
 */
async function fromIsoBmff(file: File): Promise<Uint8Array | null> {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_SCAN_BYTES)).arrayBuffer());
  const r = new Reader(head);
  const item = findExifItem(r);
  if (!item) return null;
  const payload =
    item.offset + item.length <= head.length
      ? head.subarray(item.offset, item.offset + item.length)
      : new Uint8Array(await file.slice(item.offset, item.offset + item.length).arrayBuffer());
  // The item opens with a 4-byte header offset (usually zero) followed by the
  // TIFF header itself; find the magic rather than trust the prefix.
  for (let p = 0; p < Math.min(payload.length - 4, 64); p++) {
    if (tiffEndian(payload.subarray(p)) !== null) {
      return patchOrientation(payload.slice(p));
    }
  }
  return null;
}

function boxAt(r: Reader, p: number, end: number): { type: string; size: number; header: number } | null {
  const size = r.u32(p, false);
  if (size === undefined) return null;
  let actual = size;
  let header = 8;
  if (size === 1) {
    const hi = r.u32(p + 8, false);
    const lo = r.u32(p + 12, false);
    if (hi === undefined || lo === undefined || hi > 0) return null;
    actual = lo;
    header = 16;
  } else if (size === 0) {
    actual = end - p; // to the end of the enclosing box
  }
  if (actual < header || p + actual > end) return null;
  return { type: bytesToAscii(r.bytes, p + 4, 4), size: actual, header };
}

/** Locates the Exif item's (offset, length) in the file, or null. */
function findExifItem(r: Reader): { offset: number; length: number } | null {
  // The box tree to a useful depth: top level, then one container down —
  // CR3 nests its meta inside moov; HEIC's meta sits at the top level.
  const stack: { p: number; end: number; depth: number }[] = [{ p: 0, end: r.length, depth: 0 }];
  while (stack.length > 0) {
    const { p, end, depth } = stack.pop()!;
    let q = p;
    while (q + 8 <= end) {
      const b = boxAt(r, q, end);
      if (!b) break;
      if (b.type === 'meta') {
        const found = exifFromMeta(r, q + b.header, q + b.size);
        if (found) return found;
      } else if (b.type === 'moov' && depth < 1) {
        stack.push({ p: q + b.header, end: q + b.size, depth: depth + 1 });
      }
      q += b.size;
    }
  }
  return null;
}

function exifFromMeta(r: Reader, start: number, end: number): { offset: number; length: number } | null {
  // meta is a full box: version and flags precede its children.
  let p = start + 4;
  let exifId: number | null = null;
  let ilocAt: { p: number; end: number } | null = null;
  while (p + 8 <= end) {
    const b = boxAt(r, p, end);
    if (!b) break;
    if (b.type === 'iinf') {
      exifId = readIinf(r, p + b.header, p + b.size);
    } else if (b.type === 'iloc') {
      ilocAt = { p: p + b.header, end: p + b.size };
    }
    p += b.size;
  }
  if (exifId === null || !ilocAt) return null;
  return readIloc(r, ilocAt.p, ilocAt.end, exifId);
}

/** Reads the item table, returning the id of the item whose type is 'Exif'. */
function readIinf(r: Reader, start: number, end: number): number | null {
  const version = r.u8(start) ?? 0;
  // v0 counts with a u16, v1+ with a u32.
  const count = version === 0 ? r.u16(start + 4, false) : r.u32(start + 4, false);
  if (count === undefined) return null;
  let p = version === 0 ? start + 6 : start + 8;
  for (let i = 0; i < count && p + 8 <= end; i++) {
    const b = boxAt(r, p, end);
    if (!b) break;
    if (b.type === 'infe') {
      const { id, itemType } = readInfe(r, p + b.header);
      if (itemType === 'Exif' && id !== null) return id;
    }
    p += b.size;
  }
  return null;
}

function readInfe(r: Reader, start: number): { id: number | null; itemType: string | null } {
  const version = r.u8(start) ?? 99;
  if (version >= 2) {
    const id = version === 2 ? r.u16(start + 4, false) : r.u32(start + 4, false);
    const typeAt = version === 2 ? start + 8 : start + 10;
    return { id: id ?? null, itemType: bytesToAscii(r.bytes, typeAt, 4) };
  }
  // v0/v1 carry a 16-bit id and a UTF-8 name; item_type does not exist yet.
  return { id: null, itemType: null };
}

/** Reads the extent list for one item, honouring its construction method. */
function readIloc(r: Reader, start: number, end: number, wanted: number): { offset: number; length: number } | null {
  const version = r.u8(start) ?? 99;
  const sizes = r.u8(start + 4) ?? 0;
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 0xf;
  const baseSize = (r.u8(start + 5) ?? 0) >> 4;
  if (offsetSize === 0 || offsetSize > 6 || lengthSize === 0 || lengthSize > 6) return null;
  const countAt = version < 2 ? start + 6 : start + 8;
  const count = version < 2 ? r.u16(countAt, false) : r.u32(countAt, false);
  if (count === undefined) return null;
  let p = version < 2 ? countAt + 2 : countAt + 4;
  for (let i = 0; i < count && p < end; i++) {
    const id = version < 2 ? r.u16(p, false) : r.u32(p, false);
    if (id === undefined) return null;
    p += version < 2 ? 2 : 4;
    let construction = 0;
    if (version >= 1) {
      const c = r.u16(p, false);
      if (c === undefined) return null;
      construction = c & 0xf;
      p += 2;
    }
    p += 2; // data reference index
    const base = r.sized(p, baseSize) ?? 0;
    p += baseSize;
    const extentCount = r.u16(p, false);
    p += 2;
    if (extentCount === undefined) return null;
    if (id !== wanted) {
      p += extentCount * (offsetSize + lengthSize);
      continue;
    }
    for (let k = 0; k < extentCount; k++) {
      const off = r.sized(p, offsetSize);
      const len = r.sized(p + offsetSize, lengthSize);
      p += offsetSize + lengthSize;
      if (off === undefined || len === undefined || len === 0) continue;
      if (construction !== 0) return null; // idat-relative: not a plain file offset
      return { offset: off + base, length: len };
    }
    return null;
  }
  return null;
}

// --- splicing ----------------------------------------------------------------

/** Does this output format carry the block? The WebP/AVIF encoders cannot. */
export function formatCarriesExif(format: ExportFormat): boolean {
  return format.mime === 'image/jpeg' || format.mime === 'image/png';
}

/**
 * Splices the block into an encoded image. A JPEG receives it as an APP1
 * segment ahead of everything else; a PNG as an eXIf chunk immediately after
 * its header. Anything else returns the blob untouched.
 */
export async function applyMetadata(
  blob: Blob,
  format: ExportFormat,
  block: Uint8Array | null,
): Promise<Blob> {
  if (!block || block.length === 0 || block.length > MAX_EXIF_BYTES) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (format.mime === 'image/jpeg') {
    const out = spliceJpeg(bytes, block);
    return out ? new Blob([out], { type: blob.type }) : blob;
  }
  if (format.mime === 'image/png') {
    const out = splicePng(bytes, block);
    return out ? new Blob([out], { type: blob.type }) : blob;
  }
  return blob;
}

/** Inserts an APP1/Exif segment after the SOI, dropping any existing one. */
function spliceJpeg(src: Uint8Array, block: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (src[0] !== 0xff || src[1] !== 0xd8) return null;
  const app1 = new Uint8Array(6 + block.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = ((6 + block.length) >> 8) & 0xff;
  app1[3] = (6 + block.length) & 0xff;
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  app1.set(block, 6);
  const parts: Uint8Array[] = [src.subarray(0, 2), app1];

  let pos = 2;
  for (let hops = 0; hops < 256; hops++) {
    if (pos + 4 > src.length) return null;
    if (src[pos] !== 0xff) return null;
    const marker = src[pos + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2;
      continue;
    }
    const len = (src[pos + 2]! << 8) | src[pos + 3]!;
    if (len < 2 || pos + 2 + len > src.length) return null;
    const isExif = marker === 0xe1 && bytesToAscii(src, pos + 4, 4) === 'Exif';
    if (marker === 0xda) {
      // SOS: everything from here is entropy-coded data, copied verbatim.
      parts.push(src.subarray(pos));
      pos = src.length;
      break;
    }
    if (!isExif) parts.push(src.subarray(pos, pos + 2 + len));
    pos += 2 + len;
  }
  if (pos < src.length) parts.push(src.subarray(pos));
  return concat(parts);
}

/**
 * Inserts an eXIf chunk after IHDR, dropping any existing one. The stream
 * after the header is copied verbatim — canvas encoders emit thousands of
 * IDAT chunks and walking them buys nothing beyond the first two.
 */
function splicePng(src: Uint8Array, block: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (src[i] !== sig[i]) return null;
  // The first chunk must be IHDR: length 13, type, data, CRC.
  if (src[8] !== 0 || src[9] !== 0 || src[10] !== 0 || src[11] !== 13) return null;
  if (src[12] !== 0x49 || src[13] !== 0x48 || src[14] !== 0x44 || src[15] !== 0x52) return null;
  const ihdrEnd = 8 + 25; // signature + the complete IHDR chunk

  // A pre-existing eXIf immediately after the header is replaced wholesale.
  const chunkLen = (p: number) => ((src[p]! << 24) | (src[p + 1]! << 16) | (src[p + 2]! << 8) | src[p + 3]!) >>> 0;
  const isExifAt = (p: number) =>
    src[p + 4] === 0x65 && src[p + 5] === 0x58 && src[p + 6] === 0x49 && src[p + 7] === 0x66;
  let drop = 0;
  if (ihdrEnd + 12 <= src.length && isExifAt(ihdrEnd)) {
    drop = 12 + chunkLen(ihdrEnd);
  }

  const out = new Uint8Array(src.length - drop + 12 + block.length);
  out.set(src.subarray(0, ihdrEnd), 0);
  out.set(exifChunk(block), ihdrEnd);
  out.set(src.subarray(ihdrEnd + drop), ihdrEnd + 12 + block.length);
  return out;
}

function exifChunk(block: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + block.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, block.length, false);
  chunk.set([0x65, 0x58, 0x49, 0x66], 4); // "eXIf"
  chunk.set(block, 8);
  dv.setUint32(8 + block.length, crc32(chunk.subarray(4, 8 + block.length)), false);
  return chunk;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
