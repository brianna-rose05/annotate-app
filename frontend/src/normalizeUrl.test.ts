import { describe, it, expect } from "vitest";
// The backend's own module, so the tests check exactly what the Lambda runs
import { normalizeUrl } from "../../backend/documents/normalizeUrl.mjs";

describe("normalizeUrl", () => {
  it("removes utm_ and other tracking params, keeping real ones", () => {
    expect(
      normalizeUrl(
        "https://example.com/post?utm_source=x&utm_medium=email&id=7&fbclid=abc&ref=hn",
      ),
    ).toBe("https://example.com/post?id=7");
  });

  it("removes the query string entirely when only tracking params were there", () => {
    expect(normalizeUrl("https://example.com/post?utm_campaign=y&gclid=z")).toBe(
      "https://example.com/post",
    );
  });

  it("removes ?s= only on substack.com", () => {
    expect(normalizeUrl("https://foo.substack.com/p/bar?s=r")).toBe(
      "https://foo.substack.com/p/bar",
    );
    expect(normalizeUrl("https://example.com/search?s=r")).toBe(
      "https://example.com/search?s=r",
    );
  });

  it("removes a trailing slash, but keeps the root", () => {
    expect(normalizeUrl("https://example.com/a/b/")).toBe("https://example.com/a/b");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("lowercases the host, strips www., and forces https", () => {
    expect(normalizeUrl("http://WWW.Example.COM/Path")).toBe("https://example.com/Path");
  });

  it("removes the #fragment", () => {
    expect(normalizeUrl("https://example.com/post#section-2")).toBe(
      "https://example.com/post",
    );
  });

  it("maps arXiv abs pages to the PDF", () => {
    expect(normalizeUrl("https://arxiv.org/abs/2301.01234")).toBe(
      "https://arxiv.org/pdf/2301.01234",
    );
    expect(normalizeUrl("http://www.arxiv.org/pdf/2301.01234.pdf")).toBe(
      "https://arxiv.org/pdf/2301.01234",
    );
  });

  it("strips arXiv version suffixes", () => {
    for (const url of [
      "https://arxiv.org/abs/2301.01234v2",
      "https://arxiv.org/pdf/2301.01234v1",
      "https://arxiv.org/pdf/2301.01234v3.pdf",
      "https://arxiv.org/abs/2301.01234v2/",
    ]) {
      expect(normalizeUrl(url)).toBe("https://arxiv.org/pdf/2301.01234");
    }
    expect(normalizeUrl("https://arxiv.org/abs/hep-th/9901001v1")).toBe(
      "https://arxiv.org/pdf/hep-th/9901001",
    );
  });

  it("returns an unparseable string unchanged", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});
