import { useEffect, useState, type MouseEvent } from "react";
import type { Box } from "./snip";

export default function SnipOverlay({
  onCapture,
  onCancel,
}: {
  onCapture: (box: Box) => void;
  onCancel: () => void;
}) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null);

  // Escape cancels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // The box between where you pressed and where the mouse is now (works dragging in any direction)
  const box: Box | null =
    start && current
      ? {
          left: Math.min(start.x, current.x),
          top: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x),
          height: Math.abs(current.y - start.y),
        }
      : null;

  return (
    <div
      className="snip-overlay"
      onMouseDown={(e: MouseEvent) => {
        e.preventDefault(); // don't start selecting text underneath
        setStart({ x: e.clientX, y: e.clientY });
        setCurrent({ x: e.clientX, y: e.clientY });
      }}
      onMouseMove={(e: MouseEvent) => {
        if (start) setCurrent({ x: e.clientX, y: e.clientY });
      }}
      onMouseUp={() => {
        if (box && box.width > 8 && box.height > 8) onCapture(box);
        else onCancel(); // a click without a real drag cancels
      }}
    >
      {box && (
        <div
          className="snip-box"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
      <div className="snip-hint">Drag to snip · Esc to cancel</div>
    </div>
  );
}