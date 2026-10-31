// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { findPosition, applyHighlight, markClass } from "./highlight";

describe("findPosition", () => {
  it("finds text that appears once", () => {
    const text = "The quick brown fox";
    expect(findPosition(text, { exact: "brown", prefix: "", suffix: "" })).toBe(10);
  });

  it("returns -1 when the text isn't there", () => {
    expect(findPosition("Hello world", { exact: "goodbye", prefix: "", suffix: "" })).toBe(-1);
  });

  it("uses prefix and suffix to pick the right match when a phrase repeats", () => {
    const text = "I like the cloud. Later, the cloud got dark.";
    const anchor = { exact: "the cloud", prefix: "Later, ", suffix: " got dark" };
    // the SECOND "the cloud" starts at index 25
    expect(findPosition(text, anchor)).toBe(25);
  });
    it("picks the first match when there's no context to tell them apart", () => {
    const text = "the cloud and the cloud";
    expect(findPosition(text, { exact: "the cloud", prefix: "", suffix: "" })).toBe(0);
  });
});

describe("applyHighlight", () => {
  it("wraps the matching text in a <mark>", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>The quick brown fox</p>";

    applyHighlight(container, { exact: "brown", prefix: "", suffix: "" }, "a1");

    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("brown");
    expect(marks[0].dataset.id).toBe("a1");
  });

  it("handles a highlight that spans multiple elements", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>The quick <a href='#'>brown</a> fox</p>";

    applyHighlight(container, { exact: "quick brown", prefix: "", suffix: "" }, "a2");

    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2); // one before the link, one inside it
    expect(Array.from(marks).map((m) => m.textContent).join("")).toBe("quick brown");
  });

  it("doesn't change the article's text", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>The quick brown fox</p>";

    applyHighlight(container, { exact: "quick", prefix: "", suffix: "" }, "a3");

    expect(container.textContent).toBe("The quick brown fox");
  });
});
describe("notes are drawn as underlines", () => {
  it("markClass gives highlights with a note the has-note class", () => {
    expect(markClass({ note: "why this matters" })).toBe("has-note");
    expect(markClass({ note: "  " })).toBeUndefined();
    expect(markClass({ note: "" })).toBeUndefined();
    expect(markClass({})).toBeUndefined();
  });

  it("applyHighlight puts the class on every piece of the mark", () => {
    const el = document.createElement("div");
    el.innerHTML = "<p>The quick <b>brown</b> fox</p>";
    applyHighlight(el, { exact: "quick brown fox", prefix: "The ", suffix: "" }, "a1", "has-note");
    const marks = el.querySelectorAll('mark[data-id="a1"]');
    expect(marks.length).toBeGreaterThan(1);
    marks.forEach((m) => expect(m.className).toBe("has-note"));

    applyHighlight(el, { exact: "The", prefix: "", suffix: " quick" }, "a2");
    expect(el.querySelector('mark[data-id="a2"]')!.className).toBe("");
  });
});
