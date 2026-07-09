import React, { useEffect, useRef, useState } from "react";
import { SAMPLES } from "../core/samples";
import { HeroScene } from "../three/heroScene";

interface Props {
  onSTLFile: (file: File) => void;
  onPhotoMode: () => void;
  onSample: (id: string) => void;
  error: string | null;
}

export function Landing({ onSTLFile, onPhotoMode, onSample, error }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Floating fold/unfold models behind the hero — desktop only, and skipped
  // entirely when the user prefers reduced motion.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 900px)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!wide || reduced || !bgRef.current) return;
    const scene = new HeroScene(bgRef.current);
    return () => scene.dispose();
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onSTLFile(file);
  };

  return (
    <div className="landing">
      <div ref={bgRef} className="hero-bg" aria-hidden="true" />
      <div className="topbar">
        <span className="wordmark">
          <span className="mark">▲</span> Unfold
        </span>
        <span className="tagline">3D models → printable papercraft</span>
      </div>

      <section className="hero">
        <h1>
          Print. Fold. <em>Glue.</em>
        </h1>
        <p>
          Unfold flattens a 3D model into paper templates — with cut lines, mountain and valley
          folds, and numbered glue tabs — and shows you exactly how the shape peels open, face by
          face. Everything runs in your browser; nothing is uploaded.
        </p>
        {error && (
          <p className="note error" style={{ marginTop: 14 }}>
            {error}
          </p>
        )}
      </section>

      <div className="entry-grid">
        <div
          className={`card entry clickable${dragOver ? " drag-over" : ""}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <span className="glyph">⬡</span>
          <h3>From a 3D file</h3>
          <p>
            Drop an <strong>.stl</strong> file here (or click to browse). Big meshes get simplified
            down to a foldable face count first.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".stl"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onSTLFile(f);
              e.target.value = "";
            }}
          />
        </div>

        <div className="card entry clickable" onClick={onPhotoMode}>
          <span className="badge">experimental</span>
          <span className="glyph">◐</span>
          <h3>From a photo</h3>
          <p>
            A neural depth model (running locally) turns one photo into a <em>relief</em> — a
            raised 3D silhouette, like a chocolate mold. Fun, but not a full 360° model.
          </p>
        </div>

        <div className="card entry">
          <span className="glyph">◇</span>
          <h3>Try a sample</h3>
          <p>Start folding in one click.</p>
          <div className="sample-chips">
            {SAMPLES.map((s) => (
              <button key={s.id} className="chip" title={s.hint} onClick={() => onSample(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="explainer">
        <div className="card">
          <h4>Want a real 360° model from photos?</h4>
          <p>
            True photogrammetry needs 30–100 overlapping photos from all sides and heavy
            processing — more than honest browser JavaScript can deliver today. Free tools that do
            it well: <strong>Meshroom</strong> or <strong>COLMAP</strong> on desktop, or phone apps
            like <strong>Polycam</strong>, <strong>Luma</strong>, and <strong>RealityScan</strong>.
          </p>
          <p>
            All of them export <strong>.stl</strong> — bring that file back here and Unfold will
            take it from there: simplify, unfold, print, fold, glue.
          </p>
        </div>
      </div>

      <footer>
        Runs entirely in your browser — models and photos never leave your machine.
      </footer>
    </div>
  );
}
