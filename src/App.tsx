import React, { lazy, Suspense, useState } from "react";
import type { Mesh } from "./core/types";
import { parseSTL } from "./core/stl";
import { parseOBJ } from "./core/obj";
import { buildMesh } from "./core/mesh";
import { SAMPLES } from "./core/samples";
import { Landing } from "./ui/Landing";
import { Community } from "./ui/Community";
import { Workspace } from "./ui/Workspace";

// Pulls in @huggingface/transformers (large) — only fetched if the user opens photo mode.
const PhotoFlow = lazy(() => import("./ui/PhotoFlow").then((m) => ({ default: m.PhotoFlow })));

type View = "landing" | "photo" | "community" | "workspace";

export function App() {
  const [view, setView] = useState<View>("landing");
  const [mesh, setMesh] = useState<Mesh | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openMesh = (m: Mesh) => {
    setMesh(m);
    setError(null);
    setView("workspace");
  };

  const handleModelFile = async (file: File) => {
    setError(null);
    const isSTL = /\.stl$/i.test(file.name);
    const isOBJ = /\.obj$/i.test(file.name);
    if (!isSTL && !isOBJ) {
      setError(`"${file.name}" isn't a supported model file. Unfold reads .stl and .obj — most 3D tools can export one of them.`);
      return;
    }
    try {
      const soup = isSTL
        ? parseSTL(await file.arrayBuffer())
        : parseOBJ(await file.text());
      const m = buildMesh(soup, file.name.replace(/\.(stl|obj)$/i, ""), "stl");
      openMesh(m);
    } catch (e) {
      setError(`Couldn't read that model: ${(e as Error).message}`);
    }
  };

  const handleSample = (id: string) => {
    const sample = SAMPLES.find((s) => s.id === id);
    if (sample) openMesh(sample.build());
  };

  if (view === "workspace" && mesh) {
    return (
      <Workspace
        key={`${mesh.name}-${mesh.faces.length}`}
        original={mesh}
        onBack={() => {
          setMesh(null);
          setView("landing");
        }}
      />
    );
  }

  if (view === "community") {
    return <Community onOpen={openMesh} onBack={() => setView("landing")} />;
  }

  if (view === "photo") {
    return (
      <Suspense fallback={<div className="landing" />}>
        <PhotoFlow onMeshReady={openMesh} onBack={() => setView("landing")} />
      </Suspense>
    );
  }

  return (
    <Landing
      onSTLFile={handleModelFile}
      onPhotoMode={() => setView("photo")}
      onCommunity={() => setView("community")}
      onSample={handleSample}
      error={error}
    />
  );
}
