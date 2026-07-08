import React, { useEffect, useRef, useState } from "react";
import type { Mesh } from "../core/types";
import {
  estimateDepth,
  meshFromDepth,
  sampleGrid,
  depthBackend,
  DEFAULT_RELIEF,
  type DepthMap,
  type ReliefOptions,
} from "../core/depth";
import { simplifyMesh } from "../core/simplify";

interface Props {
  onMeshReady: (mesh: Mesh) => void;
  onBack: () => void;
}

type Stage = "pick" | "estimating" | "tune" | "building";

export function PhotoFlow({ onMeshReady, onBack }: Props) {
  const [stage, setStage] = useState<Stage>("pick");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [depth, setDepth] = useState<DepthMap | null>(null);
  const [progress, setProgress] = useState({ label: "", fraction: 0 });
  const [error, setError] = useState<string | null>(null);
  const [opts, setOpts] = useState<ReliefOptions>(DEFAULT_RELIEF);
  const [dragOver, setDragOver] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const pickFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("That doesn't look like an image file.");
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      setImageUrl(reader.result as string);
      setDepth(null);
      setStage("pick");
    };
    reader.readAsDataURL(file);
  };

  const runDepth = async () => {
    if (!imageUrl) return;
    setStage("estimating");
    setError(null);
    try {
      const map = await estimateDepth(imageUrl, setProgress);
      setDepth(map);
      setStage("tune");
    } catch (e) {
      setError(
        `Depth estimation failed: ${(e as Error).message}. ` +
          "The model (~50 MB) downloads on first use — check your connection and try again."
      );
      setStage("pick");
    }
  };

  const build = async () => {
    if (!depth) return;
    setStage("building");
    setError(null);
    try {
      const relief = meshFromDepth(depth, opts, "Photo relief");
      const nf = relief.faces.length / 3;
      const mesh = nf > 500 ? await simplifyMesh(relief, 350) : relief;
      onMeshReady(mesh);
    } catch (e) {
      setError((e as Error).message);
      setStage("tune");
    }
  };

  // Depth + mask preview.
  useEffect(() => {
    if (!depth || !canvasRef.current || stage !== "tune") return;
    const canvas = canvasRef.current;
    const { width, height } = depth;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(width, height);
    for (let i = 0; i < depth.data.length; i++) {
      const v = Math.round(depth.data[i] * 255);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Overlay surviving cells in accent color.
    const g = sampleGrid(depth, opts.gridSize, opts.cutoff);
    const cw = width / g.gw;
    const ch = height / g.gh;
    ctx.fillStyle = "rgba(194, 65, 12, 0.38)";
    for (let gy = 0; gy < g.gh; gy++) {
      for (let gx = 0; gx < g.gw; gx++) {
        if (g.mask[gy * g.gw + gx]) ctx.fillRect(gx * cw, gy * ch, cw + 0.5, ch + 0.5);
      }
    }
  }, [depth, opts, stage]);

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    fmt: (v: number) => string,
    set: (v: number) => void
  ) => (
    <div className="slider-row">
      <div className="labels">
        <span>{label}</span>
        <span className="val">{fmt(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
      />
    </div>
  );

  return (
    <div className="landing">
      <div className="topbar">
        <button className="back-link" onClick={onBack}>
          ← Back
        </button>
        <span className="wordmark">
          <span className="mark">▲</span> Unfold
        </span>
      </div>

      <div className="photo-page">
        <h2 className="photo-title">Photo → paper relief</h2>
        <p className="muted" style={{ marginBottom: 18 }}>
          A neural depth model estimates how far each pixel is from the camera, entirely on your
          machine.
        </p>

        <div className="photo-banner">
          <span>⚠︎</span>
          <span>
            <strong>Honest limitations:</strong> one photo only shows one side, so the result is a{" "}
            <em>relief</em> — the subject's silhouette raised out of a flat back, like a chocolate
            mold or a coin. It will not be a walk-around 3D model. Subjects that pop out from their
            background (a mug on a table, a face, a toy) work best.
          </span>
        </div>

        {error && (
          <p className="note error" style={{ marginBottom: 14 }}>
            {error}
          </p>
        )}

        {!imageUrl && (
          <div
            className={`drop-zone${dragOver ? " drag-over" : ""}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) pickFile(f);
            }}
          >
            <p style={{ fontSize: 15 }}>Drop a photo here, or click to browse</p>
            <p className="small" style={{ marginTop: 6 }}>
              JPG / PNG · processed locally, never uploaded
            </p>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pickFile(f);
            e.target.value = "";
          }}
        />

        {imageUrl && (
          <div className="photo-grid">
            <div className="preview-wrap">
              {stage === "tune" || stage === "building" ? (
                <canvas ref={canvasRef} />
              ) : (
                <img src={imageUrl} alt="your photo" />
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {stage === "pick" && (
                <div className="card panel-card">
                  <h4>Step 1 — Depth</h4>
                  <button className="btn accent" onClick={runDepth}>
                    Estimate depth
                  </button>
                  <p className="note">
                    First run downloads the model (~50 MB), then it's cached by your browser.
                  </p>
                  <button className="btn" onClick={() => setImageUrl(null)}>
                    Choose another photo
                  </button>
                </div>
              )}

              {stage === "estimating" && (
                <div className="card panel-card">
                  <h4>Working…</h4>
                  <div className="progress">
                    <div style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
                  </div>
                  <p className="note">{progress.label || "Preparing depth model…"}</p>
                </div>
              )}

              {(stage === "tune" || stage === "building") && depth && (
                <>
                  <div className="card panel-card">
                    <h4>Step 2 — Shape the relief</h4>
                    <p className="note">
                      Bright = close. Orange cells are what becomes your model — tune the cutoff
                      until it hugs the subject.
                    </p>
                    {slider("Background cutoff", opts.cutoff, 0.05, 0.9, 0.01,
                      (v) => v.toFixed(2), (v) => setOpts({ ...opts, cutoff: v }))}
                    {slider("Relief depth", opts.reliefDepth, 0.1, 0.7, 0.01,
                      (v) => `${Math.round(v * 100)}%`, (v) => setOpts({ ...opts, reliefDepth: v }))}
                    {slider("Detail", opts.gridSize, 20, 56, 2,
                      (v) => `${v} cells`, (v) => setOpts({ ...opts, gridSize: v }))}
                    {depthBackend === "wasm" && (
                      <p className="note">Running on CPU (WebGPU unavailable) — a bit slower, same result.</p>
                    )}
                  </div>
                  <div className="card panel-card">
                    <h4>Step 3 — Build</h4>
                    <button className="btn accent" disabled={stage === "building"} onClick={build}>
                      {stage === "building" ? "Building mesh…" : "Build 3D relief"}
                    </button>
                    <p className="note">
                      The relief is auto-simplified to a foldable face count. You can re-simplify
                      later.
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
