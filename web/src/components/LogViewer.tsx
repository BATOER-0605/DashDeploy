import { useEffect, useRef } from "react";
import type { LogLine } from "../api.js";

export function LogViewer({ lines }: { lines: LogLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  if (lines.length === 0) return null;

  return (
    <div className="logs">
      {lines.map((l) => (
        <div key={l.id} className={`log-line log-${l.stream}`}>
          <span className="log-ts">{l.ts.slice(11, 19)}</span> {l.line}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
