import { toCanvas } from "html-to-image";
import { apiFetch } from "./auth";


function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Images from other sites can't be copied, so fetch each one in the box through our API
// and swap it in temporarily. Returns a function that puts the originals back.
async function inlineImages(
  article: HTMLElement,
  box: Box,
): Promise<() => void> {
  const restores: (() => void)[] = [];
  const images = Array.from(article.querySelectorAll("img")).filter((img) =>
    overlap(box, img.getBoundingClientRect()),
  );

  await Promise.all(
    images.map(async (img) => {
      const src = img.currentSrc || img.src;
      if (
        !src ||
        src.startsWith("data:") ||
        new URL(src).origin === location.origin
      )
        return;
      try {
        const res = await apiFetch(
          `image-proxy?src=${encodeURIComponent(src)}`,
        );
        if (!res.ok) return; // leave that one as-is
        const dataUrl = await toDataUrl(await res.blob());

        // <picture> wraps images in <source> tags that win over the <img>'s src, so blank those too
        const sources = Array.from(
          img.closest("picture")?.querySelectorAll("source") ?? [],
        );
        const originalSourceSets = sources.map((s) => s.getAttribute("srcset"));
        sources.forEach((s) => s.removeAttribute("srcset"));

        const originalSrc = img.getAttribute("src");
        const originalSrcset = img.getAttribute("srcset");
        img.removeAttribute("srcset"); // srcset would take priority over src
        img.src = dataUrl;
        await img.decode().catch(() => {}); // wait until it's ready to draw

        restores.push(() => {
          sources.forEach((s, i) => {
            const set = originalSourceSets[i];
            if (set) s.setAttribute("srcset", set);
          });
          if (originalSrcset) img.setAttribute("srcset", originalSrcset);
          if (originalSrc !== null) img.setAttribute("src", originalSrc);
        });
      } catch {
        // one image failing shouldn't stop the snip
      }
    }),
  );

  return () => restores.forEach((restore) => restore());
}
// A box on the screen, in screen pixels
export type Box = { left: number; top: number; width: number; height: number };

const SCALE = 2; // capture at 2× so snips stay sharp

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Couldn't create the image"))),
      "image/png",
    ),
  );
}

// The overlap of two rectangles (or null if they don't overlap)
function overlap(a: Box, b: DOMRect): Box | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.right);
  const bottom = Math.min(a.top + a.height, b.bottom);
  return right > left && bottom > top
    ? { left, top, width: right - left, height: bottom - top }
    : null;
}

// PDFs: copy pixels straight from the page canvases under the box (works across pages)
export async function snipPdf(
  box: Box,
  viewer: HTMLElement,
): Promise<Blob | null> {
  const out = document.createElement("canvas");
  out.width = Math.round(box.width * SCALE);
  out.height = Math.round(box.height * SCALE);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#fff"; // pages are drawn on white
  ctx.fillRect(0, 0, out.width, out.height);

  const frame = viewer.getBoundingClientRect(); // only what's visible inside the PDF frame
  let drewSomething = false;

  for (const canvas of Array.from(
    viewer.querySelectorAll<HTMLCanvasElement>(".pdf-page canvas"),
  )) {
    if (!canvas.width) continue; // page not drawn yet
    const canvasRect = canvas.getBoundingClientRect();
    const pageRect = canvas.closest(".pdf-page")!.getBoundingClientRect(); // excludes trimmed margins

    // The part of the box that's on this page AND visible
    const visible = overlap(box, pageRect);
    const area = visible && overlap(visible, frame);
    const part = area && overlap(area, canvasRect);
    if (!part) continue;

    const ratio = canvas.width / canvasRect.width; // canvas pixels per screen pixel (higher on Retina)
    ctx.drawImage(
      canvas,
      (part.left - canvasRect.left) * ratio, // where to copy FROM, in the page's own pixels
      (part.top - canvasRect.top) * ratio,
      part.width * ratio,
      part.height * ratio,
      (part.left - box.left) * SCALE, // where to paste TO, in the snip
      (part.top - box.top) * SCALE,
      part.width * SCALE,
      part.height * SCALE,
    );
    drewSomething = true;
  }

  return drewSomething ? toBlob(out) : null;
}

// Web articles: draw just the boxed region of the article into an image
export async function snipHtml(
  box: Box,
  article: HTMLElement,
): Promise<Blob | null> {
  const rect = article.getBoundingClientRect();
  const part = overlap(box, rect);
  if (!part) return null;

  const restore = await inlineImages(article, part);
  try {
    const canvas = await toCanvas(article, {
      pixelRatio: SCALE,
      width: part.width,
      height: part.height,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      style: {
        transform: `translate(${-(part.left - rect.left)}px, ${-(part.top - rect.top)}px)`,
        transformOrigin: "top left",
        width: `${rect.width}px`,
        margin: "0",
      },
    });
    return toBlob(canvas);
  } finally {
    restore(); // always put the original images back, even if the capture fails
  }
}
