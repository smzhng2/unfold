import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Mesh, MeshStats, NetResult } from "../core/types";
import { computeStats } from "../core/mesh";
import { simplifyMesh } from "../core/simplify";
import { unfoldMesh, MAX_UNFOLD_FACES, UnfoldError } from "../core/unfold";
import { animationLayout } from "../core/layout";
import { exportPDF, estimatePages, maxSizeCm, type PaperFormat } from "../core/pdf";
import { UnfoldViewer } from "../three/viewer";

interface Props {
  /** The mesh as loaded (before any simplification). */
  original: Mesh;
  onBack: () => void;
}

export function Workspace({ original, onBack }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<UnfoldViewer | null>(null);

  const [mesh, setMesh] = useState<Mesh>(original);
  const [net, setNet] = useState<NetResult | null>(null);
  const [stats, setStats] = useState<MeshStats>(() => computeStats(original));

  const [simplifyTarget, setSimplifyTarget] = useState(() =>
    Math.min(600, Math.max(50, Math.round(original.faces.length / 3)))
  );
  const [simplifying, setSimplifying] = useState(false);
  const [simplifyProgress, setSimplifyProgress] = useState(0);
  const [unfolding, setUnfolding] = useState(false);
  const [unfoldErr, setUnfoldErr] = useState<string | null>(null);

  const [playing, setPlaying] = useState(false);
  const scrubRef = useRef<HTMLInputElement>(null);

  const [format, setFormat] = useState<PaperFormat>("a4");
  const [sizeCm, setSizeCm] = useState(12);

  // Viewer lifecycle.
  useEffect(() => {
    const viewer = new UnfoldViewer(viewportRef.current!);
    viewerRef.current = viewer;
    viewer.onPlayStateChange = setPlaying;
    viewer.onTick = (t) => {
      if (scrubRef.current) scrubRef.current.value = String(t);
    };
    return () => viewer.dispose();
  }, []);

  // Show the mesh whenever it changes (and there's no net yet).
  useEffect(() => {
    if (!net) viewerRef.current?.setMesh(mesh);
  }, [mesh, net]);

  const faceCount = mesh.faces.length / 3;
  const originalFaces = original.faces.length / 3;
  const canUnfold = faceCount <= MAX_UNFOLD_FACES;

  const doSimplify = async () => {
    setSimplifying(true);
    setSimplifyProgress(0);
    setNet(null);
    setUnfoldErr(null);
    try {
      const result = await simplifyMesh(original, simplifyTarget, setSimplifyProgress);
      setMesh(result);
      setStats(computeStats(result));
    } finally {
      setSimplifying(false);
    }
  };

  const doUnfold = () => {
    setUnfolding(true);
    setUnfoldErr(null);
    // Let the button render its busy state before the synchronous work.
    setTimeout(() => {
      try {
        const result = unfoldMesh(mesh);
        const layout = animationLayout(result);
        setNet(result);
        viewerRef.current?.setNet(result, layout);
        viewerRef.current?.play();
      } catch (e) {
        setUnfoldErr(e instanceof UnfoldError ? e.message : `Unfolding failed: ${(e as Error).message}`);
      } finally {
        setUnfolding(false);
      }
    }, 30);
  };

  const backToSolid = () => {
    setNet(null);
    viewerRef.current?.setMesh(mesh);
  };

  const maxCm = useMemo(() => (net ? Math.max(4, maxSizeCm(net, format)) : 30), [net, format]);
  const clampedSize = Math.min(sizeCm, maxCm);
  const pages = useMemo(
    () => (net ? estimatePages(net, { format, targetSizeCm: clampedSize }) : 0),
    [net, format, clampedSize]
  );

  return (
    <div className="workspace">
      <div className="ws-top">
        <button className="back-link" onClick={onBack}>
          ← New model
        </button>
        <span className="wordmark">
          <span className="mark">▲</span> Unfold
        </span>
        <span className="model-name">{mesh.name}</span>
        <span className="spacer" />
        {net && (
          <span className="small muted">
            {net.islands.length} piece{net.islands.length === 1 ? "" : "s"} · {net.folds.length} folds ·{" "}
            {net.pairCount} glued edges
          </span>
        )}
      </div>

      <div className="ws-body">
        <div className="viewport" ref={viewportRef}>
          <span className="viewport-hint">
            {net ? "drag to orbit · scrub the timeline to fold and unfold" : "drag to orbit · scroll to zoom"}
          </span>
        </div>

        <div className="panel">
          {/* Model stats */}
          <div className="card panel-card">
            <h4>Model</h4>
            <div className="stat-row">
              <span className="muted">Faces</span>
              <span className="value">{faceCount.toLocaleString()}</span>
            </div>
            <div className="stat-row">
              <span className="muted">Vertices</span>
              <span className="value">{stats.vertices.toLocaleString()}</span>
            </div>
            <div className="stat-row">
              <span className="muted">Surface</span>
              {stats.watertight ? (
                <span className="pill ok">watertight</span>
              ) : (
                <span className="pill warn">open edges</span>
              )}
            </div>
            {!stats.watertight && (
              <p className="note">
                {stats.boundaryEdges > 0 && `${stats.boundaryEdges.toLocaleString()} open edge${stats.boundaryEdges === 1 ? "" : "s"}. `}
                {stats.nonManifoldEdges > 0 && `${stats.nonManifoldEdges.toLocaleString()} non-manifold edge${stats.nonManifoldEdges === 1 ? "" : "s"}. `}
                It will still unfold — open borders just become plain cut edges.
              </p>
            )}
            {stats.components > 1 && (
              <p className="note">
                {stats.components} separate shells — each unfolds into its own pieces.
              </p>
            )}
          </div>

          {/* Simplify */}
          {originalFaces > 50 && (
            <div className="card panel-card">
              <h4>Simplify</h4>
              <div className="slider-row">
                <div className="labels">
                  <span>Target faces</span>
                  <span className="val">{simplifyTarget.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={Math.min(MAX_UNFOLD_FACES, originalFaces)}
                  step={10}
                  value={Math.min(simplifyTarget, Math.min(MAX_UNFOLD_FACES, originalFaces))}
                  disabled={simplifying}
                  onChange={(e) => setSimplifyTarget(Number(e.target.value))}
                />
              </div>
              {simplifying ? (
                <div className="progress">
                  <div style={{ width: `${Math.round(simplifyProgress * 100)}%` }} />
                </div>
              ) : (
                <button className="btn" onClick={doSimplify}>
                  Simplify from {originalFaces.toLocaleString()} faces
                </button>
              )}
              <p className="note">
                Fewer faces = fewer folds and an easier build. 100–400 is a pleasant afternoon;
                1,000+ is a weekend project.
              </p>
            </div>
          )}

          {/* Unfold */}
          <div className="card panel-card">
            <h4>Unfold</h4>
            {!canUnfold && (
              <p className="note warn">
                {faceCount.toLocaleString()} faces is too many to fold from paper — simplify to{" "}
                {MAX_UNFOLD_FACES.toLocaleString()} or fewer first.
              </p>
            )}
            {unfoldErr && <p className="note error">{unfoldErr}</p>}
            {!net ? (
              <button className="btn accent" disabled={!canUnfold || unfolding || simplifying} onClick={doUnfold}>
                {unfolding ? "Unfolding…" : "Unfold into paper templates"}
              </button>
            ) : (
              <button className="btn" onClick={backToSolid}>
                ← Back to solid model
              </button>
            )}
          </div>

          {/* Animation */}
          {net && (
            <div className="card panel-card">
              <h4>Fold animation</h4>
              <div className="transport">
                <button
                  className="play-btn"
                  onClick={() => (playing ? viewerRef.current?.pause() : viewerRef.current?.play())}
                  title={playing ? "Pause" : "Play"}
                >
                  {playing ? "❚❚" : "▶"}
                </button>
                <div style={{ flex: 1 }}>
                  <input
                    ref={scrubRef}
                    type="range"
                    min={0}
                    max={2}
                    step={0.001}
                    defaultValue={0}
                    onInput={(e) => viewerRef.current?.seek(Number((e.target as HTMLInputElement).value))}
                  />
                  <div className="phase-labels">
                    <span>solid</span>
                    <span>unfolded</span>
                    <span>on sheets</span>
                  </div>
                </div>
              </div>
              <div className="legend">
                <div className="row">
                  <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="#8a8375" strokeWidth="2" /></svg>
                  cut edge
                </div>
                <div className="row">
                  <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="#2563eb" strokeWidth="2" strokeDasharray="5 3" /></svg>
                  valley fold (toward you)
                </div>
                <div className="row">
                  <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="#c2410c" strokeWidth="2" strokeDasharray="7 2.5 1.5 2.5" /></svg>
                  mountain fold (away)
                </div>
              </div>
            </div>
          )}

          {/* Export */}
          {net && (
            <div className="card panel-card">
              <h4>Print</h4>
              <div className="stat-row">
                <span className="muted">Paper</span>
                <select value={format} onChange={(e) => setFormat(e.target.value as PaperFormat)}>
                  <option value="a4">A4</option>
                  <option value="letter">US Letter</option>
                </select>
              </div>
              <div className="slider-row">
                <div className="labels">
                  <span>Finished size (longest side)</span>
                  <span className="val">{clampedSize.toFixed(1)} cm</span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={maxCm}
                  step={0.5}
                  value={clampedSize}
                  onChange={(e) => setSizeCm(Number(e.target.value))}
                />
              </div>
              <div className="stat-row">
                <span className="muted">Pages</span>
                <span className="value">
                  {pages} × {format === "a4" ? "A4" : "Letter"}
                </span>
              </div>
              <button className="btn primary" onClick={() => exportPDF(net, { format, targetSizeCm: clampedSize })}>
                Download PDF templates
              </button>
              <p className="note">
                Print at 100% scale on card stock (160–200 g/m²). Cut solid lines, crease dashed
                ones, glue matching numbers together.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
