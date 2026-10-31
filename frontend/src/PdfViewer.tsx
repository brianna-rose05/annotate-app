import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css"; // PDF.js's own styles for the text layer
import { applyHighlight, getSelectionAnchor, markClass, type Anchor } from "./highlight";

// PDF.js does its heavy work in a background "worker" so the page doesn't freeze
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const PENDING = "pending";

// How much of each edge to trim off (PDF pages have wide built-in margins)
const CROP_X = 0.11; // 11% off the left and right
const CROP_Y = 0.06; // 6% off the top and bottom

// Zoom levels (1 = page fits the column width), remembered between visits
const ZOOM_STEPS = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
const ZOOM_KEY = "pdf-zoom";

function loadZoom(): number {
  try {
    const saved = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOM_STEPS.includes(saved) ? saved : 1;
  } catch {
    return 1; // storage can be blocked (private windows, etc.)
  }
}

function saveZoom(zoom: number) {
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    // ignore: zoom just won't be remembered
  }
}

type PageSize = { number: number; width: number; height: number }; // at scale 1
type PdfAnnotation = Anchor & { annotationId: string; page?: number; note?: string };

// Draw one page: the picture (canvas) + the invisible, selectable text layer on top
async function renderPage(pdf: pdfjsLib.PDFDocumentProxy, number: number, el: HTMLDivElement, scale: number) {
  const page = await pdf.getPage(number);
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1; // draw sharper on high-resolution (Retina) screens

  // 1. The picture of the page
  const canvas = el.querySelector("canvas")!;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  await page.render({
    canvasContext: canvas.getContext("2d")!,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  }).promise;

  // 2. The invisible text layer (cleared first, in case the page is being redrawn at a new zoom)
  const textLayerDiv = el.querySelector<HTMLDivElement>(".textLayer")!;
  textLayerDiv.innerHTML = "";
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: await page.getTextContent(),
    container: textLayerDiv,
    viewport,
  });
  await textLayer.render();
}

// Which page (if any) a node in the document belongs to
function pageOf(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement;
  return el?.closest<HTMLElement>(".pdf-page") ?? null;
}

export default function PdfViewer({
  url,
  annotations,
  pendingAnchor,
  pendingPage,
  focusAnnotationId = null,
  onSelect,
  onOpen,
  onHover,
  onClickEmpty,
}: {
  url: string;
  annotations: PdfAnnotation[];
  pendingAnchor: Anchor | null;
  pendingPage?: number;
  focusAnnotationId?: string | null;
  onSelect: (anchor: Anchor, page: number, rect: DOMRect) => void;
  onOpen: (annotationId: string, rect: DOMRect, notice?: string) => void;
  onHover: (annotationId: string | null, rect?: DOMRect) => void;
  onClickEmpty: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendered = useRef(new Set<number>());           // pages drawn at the current zoom
  const snapshots = useRef(new Map<number, string>());  // each page's text layer, before any highlights
  const scrolledToFocus = useRef(false);
  const scrolledToFocusPage = useRef(false);
  const [renderCount, setRenderCount] = useState(0);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [fitScale, setFitScale] = useState(1); // the scale where a trimmed page fills the column
  const [zoom, setZoom] = useState(loadZoom);
  const [error, setError] = useState("");

  const scale = fitScale * zoom;

  // 1. Download the PDF and measure every page (cheap), without drawing them yet
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Couldn't download the PDF (${res.status})`);
        const data = new Uint8Array(await res.arrayBuffer());
        const doc = await pdfjsLib.getDocument({ data }).promise;

        const list: PageSize[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
          list.push({ number: n, width: vp.width, height: vp.height });
        }

        // At zoom 1, the trimmed first page exactly fills the column
        const columnWidth = containerRef.current?.parentElement?.clientWidth ?? 720;        
        const fit = columnWidth / (list[0].width * (1 - 2 * CROP_X));

        if (cancelled) return;
        setFitScale(fit);
        setSizes(list);
        setPdf(doc);
      } catch (err) {
        if (!cancelled) setError((err as Error).message || "Couldn't open this PDF.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  // 2. Draw pages as they scroll near the screen. When the zoom changes, start over at the new size.
  useEffect(() => {
    if (!pdf || !containerRef.current) return;
    rendered.current.clear();
    snapshots.current.clear();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLDivElement;
          const number = Number(el.dataset.page);
          if (rendered.current.has(number)) continue;
          rendered.current.add(number);
          renderPage(pdf, number, el, scale)
            .then(() => {
              snapshots.current.set(number, el.querySelector(".textLayer")!.innerHTML);
              setRenderCount((c) => c + 1);
            })
            .catch(() => rendered.current.delete(number));
        }
      },
      { rootMargin: "800px 0px" }
    );
    containerRef.current.querySelectorAll<HTMLDivElement>(".pdf-page").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pdf, sizes, scale]);

  // 3. Draw highlights on every page that's been drawn
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const placed = new Set<string>();

    for (const [number, cleanHtml] of snapshots.current) {
      const layer = root.querySelector<HTMLDivElement>(`.pdf-page[data-page="${number}"] .textLayer`);
      if (!layer) continue;
      layer.innerHTML = cleanHtml;

      for (const a of annotations) {
        if (placed.has(a.annotationId)) continue;
        if (a.page !== undefined && a.page !== number) continue;
        if (applyHighlight(layer, a, a.annotationId, markClass(a))) placed.add(a.annotationId);
      }
      if (pendingAnchor && pendingPage === number) applyHighlight(layer, pendingAnchor, PENDING);
    }

    if (focusAnnotationId && !scrolledToFocus.current) {
      const mark = root.querySelector<HTMLElement>(`mark[data-id="${focusAnnotationId}"]`);
      if (mark) {
        scrolledToFocus.current = true;
        mark.scrollIntoView({ behavior: "smooth", block: "center" });
        root.querySelectorAll(`mark[data-id="${focusAnnotationId}"]`).forEach((m) => m.classList.add("flash"));
      } else if (!scrolledToFocusPage.current) {
        const page = annotations.find((a) => a.annotationId === focusAnnotationId)?.page;
        const pageEl = page ? root.querySelector(`.pdf-page[data-page="${page}"]`) : null;
        if (pageEl) {
          scrolledToFocusPage.current = true;
          pageEl.scrollIntoView({ block: "start" });
        }
      }
    }
  }, [annotations, pendingAnchor, pendingPage, renderCount, focusAnnotationId]);

  function changeZoom(direction: 1 | -1) {
    const index = ZOOM_STEPS.indexOf(zoom);
    const next = ZOOM_STEPS[Math.min(Math.max(index + direction, 0), ZOOM_STEPS.length - 1)];
    setZoom(next);
    saveZoom(next);
    onClickEmpty(); // close any open tooltip, since highlight positions change with the zoom
  }

  // ---------- Selecting and clicking ----------
  function handleMouseUp(e: MouseEvent<HTMLDivElement>) {
    onHover(null);
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    if (!range || range.collapsed) {
      const mark = (e.target as HTMLElement).closest<HTMLElement>("mark[data-id]");
      if (mark && mark.dataset.id !== PENDING) onOpen(mark.dataset.id!, mark.getBoundingClientRect());
      else onClickEmpty();
      return;
    }

    const startPage = pageOf(range.startContainer);
    const endPage = pageOf(range.endContainer);
    if (!startPage || startPage !== endPage) return;
    const layer = startPage.querySelector<HTMLDivElement>(".textLayer")!;

    const overlapping = Array.from(layer.querySelectorAll<HTMLElement>("mark[data-id]")).find(
      (m) => m.dataset.id !== PENDING && range.intersectsNode(m)
    );
    if (overlapping) {
      selection!.removeAllRanges();
      onOpen(overlapping.dataset.id!, overlapping.getBoundingClientRect(), "Already highlighted");
      return;
    }

    const anchor = getSelectionAnchor(layer);
    if (!anchor) return;
    const rect = range.getBoundingClientRect();
    selection!.removeAllRanges();
    onSelect(anchor, Number(startPage.dataset.page), rect);
  }

  function handleMouseOver(e: MouseEvent<HTMLDivElement>) {
    const mark = (e.target as HTMLElement).closest<HTMLElement>("mark[data-id]");
    if (mark && mark.dataset.id !== PENDING) onHover(mark.dataset.id!, mark.getBoundingClientRect());
  }

  function handleMouseOut(e: MouseEvent<HTMLDivElement>) {
    const from = (e.target as HTMLElement).closest("mark[data-id]");
    const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest("mark[data-id]") : null;
    if (from && from !== to) onHover(null);
  }

  return (
    <div className="pdf-wrap">
      {/* Zoom controls, stuck to the top while you scroll */}
      {pdf && (
        <div className="pdf-toolbar">
          <button onClick={() => changeZoom(-1)} disabled={zoom === ZOOM_STEPS[0]} aria-label="Zoom out">
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => changeZoom(1)}
            disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        className="pdf-viewer"
        onMouseUp={handleMouseUp}
        onMouseOver={handleMouseOver}
        onMouseOut={handleMouseOut}
      >
        {error && <p className="message message-error">{error}</p>}
        {!pdf && !error && <div className="skeleton skeleton-text" />}

        <div className="pdf-pages">
          {pdf &&
            sizes.map((s) => {
              const width = s.width * scale;
              const height = s.height * scale;
              return (
                // Outer box = trimmed size; inner box = full page, shifted so its edges are hidden
                <div
                  key={s.number}
                  className="pdf-page"
                  data-page={s.number}
                  style={{ width: width * (1 - 2 * CROP_X), height: height * (1 - 2 * CROP_Y) }}
                >
                  <div
                    className="pdf-page-inner"
                    style={
                      {
                        width,
                        height,
                        marginLeft: -width * CROP_X,
                        marginTop: -height * CROP_Y,
                        "--scale-factor": scale,
                        "--user-unit": 1,
                        "--total-scale-factor": scale,
                      } as CSSProperties
                    }
                  >
                    <canvas />
                    <div className="textLayer" />
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}