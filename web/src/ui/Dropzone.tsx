/**
 * The empty state, which is the first thing anyone sees and therefore the
 * argument for the whole application. It says what this is, what it wants, and
 * what it will not do with the file — nothing leaves the machine, because
 * nothing needs to.
 */

import { useRef } from 'react';
import { ACCEPT_RAW, RAW_EXTENSIONS, primaryAcceptAttribute } from '../io/decode';

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
  const coarse =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(pointer: coarse)').matches === true;

  return (
    <div className={`dropzone${dragging ? ' is-dragging' : ''}`}>
      <div className="dropzone__inner">
        <h1 className="dropzone__title">Open a photograph</h1>
        <p className="dropzone__lede">
          A scene-referred capture carried through the stages of analog processing: latent image,
          characteristic curve, chemical development, optical print exposure, print stock, grain, and
          the light that scatters off the back of the base and comes home red.
        </p>

        <div className="dropzone__actions">
          <button type="button" className="btn btn--primary btn--lg" onClick={() => input.current?.click()}>
            Choose an image
          </button>
          <p className="dropzone__drop">
            or drop one anywhere ·{' '}
            <button type="button" className="link" onClick={() => rawInput.current?.click()}>
              choose a RAW file
            </button>
            {coarse ? ' — some phone pickers hide RAW files; this chooser doesn’t' : null}
          </p>
        </div>
        {/* The primary picker uses the shared policy: a desktop and every
            non-Apple coarse pointer get the full extension list, so a RAW
            file is never greyed out of the front door; Apple's picker keeps
            image/*-only, and the RAW chooser below is its RAW route. */}
        <input
          ref={input}
          type="file"
          accept={primaryAcceptAttribute()}
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
