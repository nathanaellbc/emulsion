/**
 * Getting a genuinely scene-referred image out of a file.
 *
 * §V is unambiguous about this: the correctness of every subsequent stage rests
 * on the decode, and every convenience default a decoder applies — auto
 * brightness, tone curve, noise reduction, sharpening — is destructive to the
 * purpose. So the RAW path asks LibRaw for linear ACES with every rendering
 * intent switched off, and the ordinary-image path does the one honest thing
 * available: undo the transfer function and say plainly that a tone curve was
 * already baked in before we ever saw it.
 */

import type { SourceSpace } from '../core/resolve';
import type { SourceImage } from '../gl/renderer';

export const RAW_EXTENSIONS = [
  'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf',
  'orf', 'rw2', 'pef', 'ptx', 'dcr', 'kdc', 'mrw', 'raw', 'rwl', '3fr',
  'fff', 'iiq', 'mos', 'erf', 'mef', 'x3f', 'srw', 'gpr',
] as const;

export const STANDARD_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'bmp', 'gif', 'heic', 'heif',
] as const;

/**
 * The full filter: everything decodable plus every RAW extension. Desktop file
 * dialogs handle it well; a phone picker does not — iOS drops its own
 * "Take Photo" option the moment extensions join `image/*`, so touch devices
 * get the basic filter instead (see Dropzone and the topbar Open input).
 */
export const ACCEPT_ATTRIBUTE = [
  'image/*',
  ...RAW_EXTENSIONS.map((e) => `.${e}`),
].join(',');

/**
 * Images only, no extension filters. This is the filter that keeps the phone's
 * native camera capture in its own picker; RAW files go through the second
 * input, whose list is extensions only.
 */
export const ACCEPT_IMAGE_BASIC = 'image/*';

/** RAW-only filter for the dedicated RAW chooser. */
export const ACCEPT_RAW = RAW_EXTENSIONS.map((e) => `.${e}`).join(',');

/**
 * The filter for the *primary* picker, wherever it appears. A fine pointer
 * gets the full list, so a RAW file is one click. A coarse pointer gets the
 * full list too — an image/*-only picker is what greys a .dng out of the
 * Android chooser, the product's headline input refused at its own front
 * door — except on Apple, whose picker drops its native "Take Photo" entry
 * the moment extensions join image/*. Apple keeps the basic filter and
 * reaches RAW through the dedicated chooser.
 */
export function primaryAcceptAttribute(): string {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches === true;
  if (!coarse) return ACCEPT_ATTRIBUTE;
  const ua = navigator.userAgent;
  const apple =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return apple ? ACCEPT_IMAGE_BASIC : ACCEPT_ATTRIBUTE;
}

export interface DecodedSource {
  image: SourceImage;
  space: SourceSpace;
  /** What the file was and how it was read, for the provenance line in the UI. */
  kind: 'raw' | 'standard';
  fileName: string;
  camera?: string;
  iso?: number;
  shutter?: number;
  aperture?: number;
  focalLength?: number;
  /** Set when the decode had to fall back or lost something. */
  caveat?: string;
}

export class DecodeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DecodeError';
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isRawFile(file: File): boolean {
  return (RAW_EXTENSIONS as readonly string[]).includes(extensionOf(file.name));
}

/**
 * LibRaw settings that defeat every rendering intent.
 *
 * The one thing deliberately kept is the camera's own white balance: it is
 * calibration rather than interpretation, and the pipeline needs to know what
 * the camera decided even when the user overrides it.
 */
const SCENE_REFERRED_SETTINGS = {
  outputBps: 16,
  // 6 = ACES (AP0). Wide enough that nothing is clipped before the working space.
  outputColor: 6,
  // Linear: power 1, toe slope 1. No tone curve of any kind.
  gamm: [1, 1] as [number, number],
  noAutoBright: true,
  useCameraWb: true,
  useCameraMatrix: 1,
  // 0 = clip highlights rather than reconstructing them; reconstruction invents
  // data, and the print's shoulder is what should be handling highlights here.
  highlight: 0,
  // AHD demosaic. Spatial processing we intend to model ourselves stays off.
  userQual: 3,
  medPasses: 0,
  threshold: 0,
  fbddNoiserd: 0,
  userFlip: -1,
  outputTiff: false,
} as const;

async function decodeRaw(file: File): Promise<DecodedSource> {
  const { default: LibRaw } = await import('libraw-wasm');
  const decoder = new LibRaw();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await decoder.open(bytes, SCENE_REFERRED_SETTINGS);
    const meta = await decoder.metadata(false);
    const decoded = await decoder.imageData();
    if (!decoded) throw new DecodeError('LibRaw opened the file but produced no image data.');

    const { width, height, colors, bits, data } = decoded;
    if (colors < 3) {
      throw new DecodeError(
        `This file decoded to ${colors} channel${colors === 1 ? '' : 's'}; the film chain needs three.`,
      );
    }

    const scale = bits === 16 ? 1 / 65535 : 1 / 255;
    const rgba = new Float32Array(width * height * 4);
    for (let i = 0, o = 0, s = 0; i < width * height; i++, o += 4, s += colors) {
      rgba[o] = (data[s] ?? 0) * scale;
      rgba[o + 1] = (data[s + 1] ?? 0) * scale;
      rgba[o + 2] = (data[s + 2] ?? 0) * scale;
      rgba[o + 3] = 1;
    }

    return {
      image: { width, height, float: rgba, encoded: false },
      space: 'acesAP0',
      kind: 'raw',
      fileName: file.name,
      camera: meta ? `${meta.camera_make ?? ''} ${meta.camera_model ?? ''}`.trim() : undefined,
      iso: meta?.iso_speed,
      shutter: meta?.shutter,
      aperture: meta?.aperture,
      focalLength: meta?.focal_len,
    };
  } catch (err) {
    if (err instanceof DecodeError) throw err;
    throw new DecodeError(
      `LibRaw could not decode ${file.name}. The format may be unsupported, or the file may be truncated.`,
      err,
    );
  } finally {
    decoder.dispose();
  }
}

/**
 * Decode an ordinary image through every route the platform offers, because
 * the first one is not guaranteed: older WebKit rejects the *options* object
 * outright, some codecs are simply absent (a HEIC on Windows Chrome, say), and
 * what remains is the `<img>` element — the one decoder every browser that can
 * show a photograph has, EXIF rotation included.
 */
async function decodeBitmap(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Fall through to the plain call.
  }
  try {
    return await createImageBitmap(file);
  } catch {
    // Fall through to the <img> element.
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<ImageBitmap | null>((resolveDecode) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        // Bitmap keeps the GL path uniform; if even this is missing, null.
        createImageBitmap(img).then(resolveDecode, () => resolveDecode(null));
      };
      img.onerror = () => resolveDecode(null);
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeStandard(file: File): Promise<DecodedSource> {
  const bitmap = await decodeBitmap(file);
  if (!bitmap) {
    const heic = /hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name);
    throw new DecodeError(
      heic
        ? `The browser could not decode ${file.name}: it is HEIC and this browser has no codec for it. Export it as JPEG from the camera roll, then open it here.`
        : `The browser could not decode ${file.name} as an image. The file may be corrupt, or in a format this browser has no codec for.`,
    );
  }
  return {
    image: { width: bitmap.width, height: bitmap.height, bitmap, encoded: true },
    space: 'srgb',
    kind: 'standard',
    fileName: file.name,
    caveat:
      'This file is display-referred: a tone curve, white balance and gamut mapping were baked in before EMULSION saw it. The chain runs on what survived. A RAW file gives the negative something closer to what a negative actually receives.',
  };
}

export async function decodeFile(file: File): Promise<DecodedSource> {
  if (file.size === 0) throw new DecodeError(`${file.name} is empty.`);
  if (isRawFile(file)) return decodeRaw(file);
  const ext = extensionOf(file.name);
  if ((STANDARD_EXTENSIONS as readonly string[]).includes(ext) || file.type.startsWith('image/')) {
    return decodeStandard(file);
  }
  throw new DecodeError(
    `EMULSION does not recognise “${file.name}”. Bring a camera RAW file or an ordinary image.`,
  );
}

/**
 * Geometric-mean luminance of the decoded image, sampled on a coarse grid.
 *
 * §V calls the per-device constant relating a decoded middle grey to the
 * working-space unit `g_cal`, and getting it wrong is what makes every stock
 * "look flat" or "block up". There is no device to calibrate here, so the honest
 * substitute is to measure the picture and offer the shift to the user, rather
 * than to guess a constant and hide it.
 */
export async function measureMiddleGrey(source: DecodedSource): Promise<number> {
  const { image } = source;
  const target = 220;
  const step = Math.max(1, Math.floor(Math.max(image.width, image.height) / target));

  let logSum = 0;
  let count = 0;
  const accumulate = (r: number, g: number, b: number) => {
    const y = 0.2722 * r + 0.6741 * g + 0.0537 * b;
    if (y > 1e-5) {
      logSum += Math.log(y);
      count++;
    }
  };

  if (image.float) {
    for (let y = 0; y < image.height; y += step) {
      for (let x = 0; x < image.width; x += step) {
        const i = (y * image.width + x) * 4;
        accumulate(image.float[i]!, image.float[i + 1]!, image.float[i + 2]!);
      }
    }
  } else if (image.bitmap) {
    const w = Math.max(1, Math.round(image.width / step));
    const h = Math.max(1, Math.round(image.height / step));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0.18;
    ctx.drawImage(image.bitmap as CanvasImageSource, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const eotf = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    for (let i = 0; i < data.length; i += 4) {
      accumulate(eotf(data[i]! / 255), eotf(data[i + 1]! / 255), eotf(data[i + 2]! / 255));
    }
  }

  return count === 0 ? 0.18 : Math.exp(logSum / count);
}

export const HISTOGRAM_BINS = 160;
export const HISTOGRAM_MIN = -5;
export const HISTOGRAM_MAX = 3;

/**
 * A subsample of the scene's linear luminance — the raw material for the
 * histogram, kept separate from the binning so the camera develop can be
 * applied to the samples as it moves. The develop is *not* baked in: these
 * are the decoded scene, and the instrument beneath the characteristic curve
 * shows where the film sees the light after the develop, which changes with
 * the sliders.
 *
 * Returns the samples in `Float32Array` because it is a sample *set*: the
 * develop must map each one, not shift them.
 */
export function sceneSamples(source: DecodedSource, target = 320): Float32Array | null {
  const { image } = source;
  const step = Math.max(1, Math.floor(Math.max(image.width, image.height) / target));

  if (image.float) {
    const out: number[] = [];
    for (let y = 0; y < image.height; y += step) {
      for (let x = 0; x < image.width; x += step) {
        const i = (y * image.width + x) * 4;
        out.push(
          0.2722 * image.float[i]! +
            0.6741 * image.float[i + 1]! +
            0.0537 * image.float[i + 2]!,
        );
      }
    }
    return Float32Array.from(out);
  }

  if (image.bitmap) {
    const w = Math.max(1, Math.round(image.width / step));
    const h = Math.max(1, Math.round(image.height / step));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image.bitmap as CanvasImageSource, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const eotf = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const out = new Float32Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      out[j] =
        0.2722 * eotf(data[i]! / 255) +
        0.6741 * eotf(data[i + 1]! / 255) +
        0.0537 * eotf(data[i + 2]! / 255);
    }
    return out;
  }

  return null;
}

/**
 * Distribution of the scene's luminance in log10 exposure.
 *
 * Drawn under the characteristic curve, this is the single most useful thing
 * the interface can show: it says where *this photograph* sits on *this stock*,
 * so raising exposure visibly slides the picture up the curve toward the
 * shoulder instead of just making a number change.
 *
 * The samples arrive pre-developed (`developLuma` applied in the caller): the
 * histogram is where the film sees the light, and the camera develop is part
 * of the light.
 */
export function sceneLogHistogram(samples: Float32Array | null): Float32Array {
  const bins = new Float32Array(HISTOGRAM_BINS);
  const span = HISTOGRAM_MAX - HISTOGRAM_MIN;
  if (!samples) return bins;

  const add = (y: number) => {
    if (y <= 1e-7) return;
    const t = (Math.log10(y) - HISTOGRAM_MIN) / span;
    if (t < 0 || t >= 1) return;
    bins[Math.floor(t * HISTOGRAM_BINS)]! += 1;
  };
  for (const y of samples) add(y);

  let peak = 0;
  for (const v of bins) peak = Math.max(peak, v);
  if (peak > 0) for (let i = 0; i < bins.length; i++) bins[i]! /= peak;
  return bins;
}

/** Stops of compensation that would place the measured grey at 0.18. */
export function suggestedExposureCompensation(measuredGrey: number): number {
  if (measuredGrey <= 1e-6) return 0;
  return Math.log2(0.18 / measuredGrey);
}
