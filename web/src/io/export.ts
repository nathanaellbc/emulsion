/**
 * Getting the finished print out of the browser.
 *
 * The export path is the mirror of `decode.ts`: where decoding is strict about
 * what a file claims to be, encoding is strict about what a browser can
 * actually produce. `canvas.toBlob` silently falls back to PNG for types the
 * running browser cannot encode — Safari has done this for WebP and AVIF for
 * years — so formats are offered by *probing*: encode a tiny canvas, then read
 * the MIME type off the returned blob. What the dialog offers is what the
 * browser encodes, no feature flags and no user-agent sniffing.
 *
 * The two save paths are kept honest too. A download is an anchor click, which
 * every desktop browser handles. "Save to Photos" is the Web Share sheet,
 * which on iOS and Android hands the file to the system — and that call must
 * originate inside the user gesture, so the dialog encodes ahead of the click
 * and the handler shares a blob that is already in hand.
 */

export type ExportFormatId = 'png' | 'jpeg' | 'webp' | 'avif';

export interface ExportFormat {
  readonly id: ExportFormatId;
  readonly mime: string;
  readonly label: string;
  /** The trade, stated where the user is choosing. */
  readonly note: string;
  readonly lossy: boolean;
  readonly ext: string;
}

/** In preference order: lossless first, then ascending compression effort. */
export const EXPORT_FORMATS: readonly ExportFormat[] = [
  {
    id: 'png',
    mime: 'image/png',
    label: 'PNG',
    note: 'Lossless · every pixel exactly as rendered',
    lossy: false,
    ext: 'png',
  },
  {
    id: 'jpeg',
    mime: 'image/jpeg',
    label: 'JPEG',
    note: 'Lossy · smallest widely-compatible file',
    lossy: true,
    ext: 'jpg',
  },
  {
    id: 'webp',
    mime: 'image/webp',
    label: 'WebP',
    note: 'Lossy · smaller than JPEG at like quality',
    lossy: true,
    ext: 'webp',
  },
  {
    id: 'avif',
    mime: 'image/avif',
    label: 'AVIF',
    note: 'Lossy · smallest file, slowest to encode',
    lossy: true,
    ext: 'avif',
  },
];

export function formatById(id: ExportFormatId): ExportFormat {
  const f = EXPORT_FORMATS.find((f) => f.id === id);
  if (!f) throw new Error(`unknown export format '${id}'`);
  return f;
}

/**
 * The formats this browser can actually encode, probed once and cached.
 *
 * A blob comes back with the MIME the encoder chose — not the one that was
 * asked for — so a silent PNG fallback from an unencodable type is detected by
 * the result's own type, which is the only evidence that cannot lie.
 */
let detectedFormats: Promise<readonly ExportFormat[]> | null = null;

function probe(mime: string): Promise<boolean> {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(false);
  ctx.fillStyle = '#804020';
  ctx.fillRect(0, 0, 4, 4);
  return new Promise<boolean>((res) => {
    canvas.toBlob(
      (blob) => res(!!blob && blob.type === mime),
      mime,
      0.5,
    );
  });
}

export function detectFormats(): Promise<readonly ExportFormat[]> {
  if (!detectedFormats) {
    detectedFormats = Promise.all(
      EXPORT_FORMATS.map(async (f) => ((await probe(f.mime)) ? f : null)),
    ).then((results) => {
      const ok = results.filter((f): f is ExportFormat => f !== null);
      // PNG is the encoder of last resort and is always in the list, so the
      // dialog is never left without an option even if probing misbehaves.
      if (!ok.some((f) => f.id === 'png')) ok.unshift(formatById('png'));
      return ok;
    });
  }
  return detectedFormats;
}

/** Encode a canvas. Quality (0-1) applies to lossy formats only. */
export function encodeImage(
  canvas: HTMLCanvasElement,
  format: ExportFormat,
  quality: number,
): Promise<Blob> {
  return new Promise<Blob>((res, rej) => {
    canvas.toBlob(
      (blob) => {
        if (blob && blob.type === format.mime) res(blob);
        else rej(new Error(`this browser would not encode ${format.label}`));
      },
      format.mime,
      format.lossy ? Math.min(Math.max(quality, 0.01), 1) : undefined,
    );
  });
}

/** The same file name the anchor path has always used, for any extension. */
export function exportFileName(
  sourceName: string,
  negativeName: string,
  printName: string,
  ext: string,
): string {
  const stem = sourceName.replace(/\.[^.]+$/, '') || 'print';
  return `${stem} — ${negativeName} on ${printName}.${ext}`;
}

/** Can this browser hand an image file to the system share sheet? */
export function canShareImages(): boolean {
  if (typeof navigator === 'undefined' || !navigator.canShare || !navigator.share) return false;
  try {
    // A minimal real file: canShare is defined on shapes, and a fabricated
    // empty file is the cheapest legal instance.
    const probeFile = new File([new Uint8Array(0)], 'probe.png', { type: 'image/png' });
    return navigator.canShare({ files: [probeFile] });
  } catch {
    return false;
  }
}

/**
 * The desktop path: an anchor click, as every download in the app has been.
 * The object URL is revoked in the same tick the click is dispatched, which is
 * what the previous inline export did and works because the click resolves the
 * blob reference synchronously.
 */
export function saveViaDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The mobile path: the system share sheet, which is how a browser hands an
 * image to the photo library on iOS and Android.
 *
 * `navigator.share` must run inside the user gesture on iOS, so callers pass a
 * blob that is already encoded. A dismissed sheet is the user changing their
 * mind, not a failure: AbortError reads as 'cancelled' and everything else
 * propagates.
 */
export async function saveViaShare(blob: Blob, filename: string): Promise<'shared' | 'cancelled'> {
  const file = new File([blob], filename, { type: blob.type });
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    // Some browsers reject with a plain Error carrying 'abort' in the message
    // rather than a DOMException; the dismissal is still not a failure.
    if (err instanceof Error && /abort/i.test(err.message)) return 'cancelled';
    throw err;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
