// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
// The backend's own module, which the reader also uses
import {
  parseSrcset,
  resolveSrcset,
  resolveUrl,
  fixArticleUrls,
} from "../../backend/documents/articleUrls.mjs";

const BASE = "https://www.anthropic.com/news/claude";

describe("parseSrcset", () => {
  it("splits url + descriptor pairs", () => {
    expect(parseSrcset("a.jpg 1x, /b.jpg 2x")).toEqual([
      { url: "a.jpg", descriptor: "1x" },
      { url: "/b.jpg", descriptor: "2x" },
    ]);
  });

  it("handles width descriptors, extra whitespace, and newlines", () => {
    expect(parseSrcset("  small.jpg 480w,\n   large.jpg   1080w  ")).toEqual([
      { url: "small.jpg", descriptor: "480w" },
      { url: "large.jpg", descriptor: "1080w" },
    ]);
  });

  it("keeps commas that are part of a URL", () => {
    expect(
      parseSrcset("https://cdn.example.com/w_300,h_200/a.jpg 1x, https://cdn.example.com/w_600,h_400/a.jpg 2x"),
    ).toEqual([
      { url: "https://cdn.example.com/w_300,h_200/a.jpg", descriptor: "1x" },
      { url: "https://cdn.example.com/w_600,h_400/a.jpg", descriptor: "2x" },
    ]);
  });

  it("handles candidates without descriptors", () => {
    expect(parseSrcset("a.jpg, b.jpg 2x")).toEqual([
      { url: "a.jpg", descriptor: "" },
      { url: "b.jpg", descriptor: "2x" },
    ]);
    expect(parseSrcset("only.jpg")).toEqual([{ url: "only.jpg", descriptor: "" }]);
    expect(parseSrcset("")).toEqual([]);
  });
});

describe("resolveUrl", () => {
  it("resolves relative URLs against the article", () => {
    expect(resolveUrl("/img/a.png", BASE)).toBe("https://www.anthropic.com/img/a.png");
    expect(resolveUrl("b.png", BASE)).toBe("https://www.anthropic.com/news/b.png");
  });

  it("unwraps Next.js /_next/image URLs, relative or absolute", () => {
    expect(resolveUrl("/_next/image?url=%2Fimg%2Fa.png&w=3840&q=75", BASE)).toBe(
      "https://www.anthropic.com/img/a.png",
    );
    expect(
      resolveUrl(
        "https://www.anthropic.com/_next/image?url=https%3A%2F%2Fcdn.sanity.io%2Fimages%2Fx.png&w=1920&q=75",
        BASE,
      ),
    ).toBe("https://cdn.sanity.io/images/x.png");
  });

  it("leaves /_next/image without a url param, and unparseable values, alone", () => {
    expect(resolveUrl("/_next/image?w=10", BASE)).toBe("https://www.anthropic.com/_next/image?w=10");
    expect(resolveUrl("http://[bad", BASE)).toBe("http://[bad");
  });
});

describe("resolveSrcset", () => {
  it("resolves and unwraps every candidate, keeping descriptors", () => {
    expect(resolveSrcset("/_next/image?url=%2Fimg%2Fa.png&w=3840&q=75 1x, /b.jpg 2x", BASE)).toBe(
      "https://www.anthropic.com/img/a.png 1x, https://www.anthropic.com/b.jpg 2x",
    );
  });
});

describe("fixArticleUrls", () => {
  it("fixes img src/srcset, <source> srcset, and links (but not #anchors)", () => {
    const doc = new DOMParser().parseFromString(
      `<picture>
         <source srcset="/_next/image?url=%2Fimg%2Fa.png&amp;w=3840&amp;q=75 1x">
         <img src="https://www.anthropic.com/_next/image?url=%2Fimg%2Fa.png&amp;w=1920&amp;q=75"
              srcset="/_next/image?url=%2Fimg%2Fa.png&amp;w=3840&amp;q=75 1x">
       </picture>
       <a href="/research">r</a><a href="#notes">n</a>`,
      "text/html",
    );
    fixArticleUrls(doc.body, BASE);

    expect(doc.querySelector("source")!.getAttribute("srcset")).toBe("https://www.anthropic.com/img/a.png 1x");
    const img = doc.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://www.anthropic.com/img/a.png");
    expect(img.getAttribute("srcset")).toBe("https://www.anthropic.com/img/a.png 1x");
    const [research, notes] = doc.querySelectorAll("a");
    expect(research.getAttribute("href")).toBe("https://www.anthropic.com/research");
    expect(notes.getAttribute("href")).toBe("#notes");
  });

  it("leaves data: images alone, so snips and inline images still work", () => {
    const doc = new DOMParser().parseFromString(`<img src="data:image/png;base64,AAAA">`, "text/html");
    fixArticleUrls(doc.body, BASE);
    expect(doc.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });
});
