/**
 * The empty state, which is the first thing anyone sees and therefore the
 * argument for the whole application. It says what this is, what it wants, and
 * what it will not do with the file — nothing leaves the machine, because
 * nothing needs to.
 */

import { useRef } from 'react';
import { ACCEPT_IMAGE_BASIC, ACCEPT_RAW, RAW_EXTENSIONS } from '../io/decode';

export function Dropzone({
  onFile,
  dragging,
  error,
}: {
  onFile: (file: File) => void;
  dragging: boolean;
  error: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const rawInput = useRef<HTMLInputElement>(null);

  return (
    <div className={`dropzone${dragging ? ' is-dragging' : ''}`}>
      <div className="dropzone__inner">
        <Mark />
        <h1 className="dropzone__title">
          EMULSION<span>Digital film laboratory</span>
        </h1>
        <p className="dropzone__lede">
          A scene-referred capture carried through the stages of analog processing: latent image,
          characteristic curve, chemical development, optical print exposure, print stock, grain, and
          the light that scatters off the back of the base and comes home red.
        </p>

        <button type="button" className="btn btn--primary btn--lg" onClick={() => input.current?.click()}>
          Choose an image
        </button>
        {/* The main picker filters to image/* only, because a phone's picker
            drops its own "Take Photo" option the moment file extensions join
            the filter. RAW gets its own chooser with the extension list. */}
        <input
          ref={input}
          type="file"
          accept={ACCEPT_IMAGE_BASIC}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        <input
          ref={rawInput}
          type="file"
          accept={ACCEPT_RAW}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        <p className="dropzone__drop">
          or drop one anywhere on this page ·{' '}
          <button type="button" className="link" onClick={() => rawInput.current?.click()}>
            choose a RAW file
          </button>
        </p>

        {error ? (
          <p className="dropzone__error" role="alert">
            {error}
          </p>
        ) : null}

        <dl className="dropzone__facts">
          <div>
            <dt>RAW</dt>
            <dd>
              <span className="num">
                {RAW_EXTENSIONS.slice(0, 10).map((e) => e.toUpperCase()).join(' · ')}
              </span>{' '}
              and more, decoded linear with every rendering intent switched off
            </dd>
          </div>
          <div>
            <dt>Also</dt>
            <dd>JPEG, PNG, TIFF, WebP — with a tone curve already baked in, and the app will say so</dd>
          </div>
          <div>
            <dt>Privacy</dt>
            <dd>Decoding and rendering happen on this device. No upload, no server, no account</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

/**
 * A characteristic curve, drawn as the mark. Toe, straight line, shoulder —
 * the shape the whole application is arranged around.
 */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 120 72" aria-hidden="true">
      <path
        d="M4 66 C 22 66, 30 62, 38 50 L 74 20 C 82 9, 92 6, 116 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="56" cy="35" r="3" fill="currentColor" />
    </svg>
  );
}
