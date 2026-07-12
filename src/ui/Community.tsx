import React, { useEffect, useState } from "react";
import type { Mesh } from "../core/types";
import { COMMUNITY_CREATIONS, renderThumbnail } from "../core/community";

interface Props {
  onOpen: (mesh: Mesh) => void;
  onBack: () => void;
}

export function Community({ onOpen, onBack }: Props) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Render thumbnails after mount (one shared WebGL context, one frame each).
  useEffect(() => {
    const out: Record<string, string> = {};
    for (const c of COMMUNITY_CREATIONS) {
      try {
        out[c.id] = renderThumbnail(c.id, c.build());
      } catch {
        // leave the placeholder tile for this one
      }
    }
    setThumbs(out);
  }, []);

  const open = (id: string) => {
    const creation = COMMUNITY_CREATIONS.find((c) => c.id === id);
    if (!creation) return;
    try {
      onOpen(creation.build());
    } catch (e) {
      setError(`Couldn't open that model: ${(e as Error).message}`);
    }
  };

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

      <div className="community-page">
        <h2 className="photo-title">Community creations</h2>
        <p className="muted" style={{ marginBottom: 14 }}>
          Models folded by other builders. Open one to watch it unfold — then print and build it
          yourself.
        </p>

        <div className="photo-banner" style={{ marginBottom: 22 }}>
          <span>🛠︎</span>
          <span>
            <strong>Preview:</strong> community sharing isn't live yet — these starter creations
            are here to show how the gallery will work. Accounts and uploads are coming.
          </span>
        </div>

        {error && (
          <p className="note error" style={{ marginBottom: 14 }}>
            {error}
          </p>
        )}

        <div className="community-grid">
          {COMMUNITY_CREATIONS.map((c) => (
            <button key={c.id} className="card creation-card" onClick={() => open(c.id)}>
              <div className="creation-thumb">
                {thumbs[c.id] ? <img src={thumbs[c.id]} alt={c.title} /> : <div className="thumb-placeholder">◇</div>}
              </div>
              <div className="creation-body">
                <h3>{c.title}</h3>
                <div className="creation-author">
                  <span className="avatar">{c.author[0]}</span>
                  <span>
                    {c.author} <span className="muted">@{c.handle}</span>
                  </span>
                </div>
                <p className="creation-blurb">“{c.blurb}”</p>
                <div className="creation-stats mono">
                  <span title="likes">♥ {c.likes}</span>
                  <span title="times built">⚒ {c.builds} built</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <footer>
        Runs entirely in your browser — models and photos never leave your machine.
      </footer>
    </div>
  );
}
