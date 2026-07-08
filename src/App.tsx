import React, { useState } from "react";
import type { Mesh } from "./core/types";
import { parseSTL } from "./core/stl";
import { buildMesh } from "./core/mesh";
import { SAMPLES } from "./core/samples";
import { Landing } from "./ui/Landing";
import { PhotoFlow } from "./ui/PhotoFlow";
import { Workspace } from "./ui/Workspace";

type View = "landing" | "photo" | "workspace";

export function App() {
  const [view, setView] = useState<View>("landing");
  const [mesh, setMesh] = useState<Mesh | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openMesh = (m: Mesh) => {
    setMesh(m);
    setError(null);
    setView("workspace");
  };

  const handleSTLFile = async (file: File) => {
    setError(null);
    if (!/\.stl$/i.test(file.name)) {
      setError(`"${file.name}" isn't an .stl file. Unfold currently reads STL only — most 3D tools can export it.`);
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const soup = parseSTL(buffer);
      const m = buildMesh(soup, file.name.replace(/\.stl$/i, ""), "stl");
      openMesh(m);
    } catch (e) {
      setError(`Couldn't read that STL: ${(e as Error).message}`);
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

  if (view === "photo") {
    return <PhotoFlow onMeshReady={openMesh} onBack={() => setView("landing")} />;
  }

  return (
    <Landing
      onSTLFile={handleSTLFile}
      onPhotoMode={() => setView("photo")}
      onSample={handleSample}
      error={error}
    />
  );
}
