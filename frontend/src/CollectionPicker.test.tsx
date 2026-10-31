// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CollectionPicker from "./CollectionPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { collectionId: "ai", name: "AI" },
  { collectionId: "ed", name: "Education" },
];

// Mirrors the Reader: an article that closes the tooltip on mouseup, with the picker in a sibling
function Harness({ dark, onArticleMouseUp, onArticleClick }: {
  dark: boolean;
  onArticleMouseUp: () => void;
  onArticleClick: () => void;
}) {
  const [values, setValues] = useState<string[]>([]);
  return (
    <div>
      <div id="article" onMouseUp={onArticleMouseUp} onClick={onArticleClick}>text</div>
      <div id="tooltip">
        <CollectionPicker dark={dark} values={values} onChange={setValues} options={OPTIONS} />
        <output id="values">{values.join(",")}</output>
      </div>
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const fire = (el: Element, type: string, init: KeyboardEventInit = {}) =>
  act(() => {
    const event = type.startsWith("key")
      ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
      : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
    el.dispatchEvent(event);
  });

const $ = (sel: string) => container.querySelector(sel)!;
const options = () => [...container.querySelectorAll('[role="option"]')];

for (const dark of [false, true]) {
  describe(`CollectionPicker (${dark ? "dark tooltip" : "light editor / snip modal"})`, () => {
    it("selects an option even when the menu disappears under the pointer", async () => {
      const mouseUp = vi.fn();
      const click = vi.fn();
      act(() => root.render(<Harness dark={dark} onArticleMouseUp={mouseUp} onArticleClick={click} />));
      act(() => ($("input") as HTMLInputElement).focus());
      fire($("input"), "focusin");

      // Pick both options; picking the last one makes the menu vanish
      fire(options()[0], "mousedown");
      fire($("#article"), "mouseup");
      fire($("#article"), "click");
      fire(options()[0], "mousedown");
      expect(options()).toHaveLength(0);
      fire($("#article"), "mouseup"); // lands on the article now
      fire($("#article"), "click");

      expect($("#values").textContent).toBe("AI,Education");
      expect(mouseUp).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
      expect(document.activeElement).toBe($("input"));

      // Later, ordinary clicks on the article still get through
      await new Promise((r) => setTimeout(r, 0));
      fire($("#article"), "mouseup");
      fire($("#article"), "click");
      expect(mouseUp).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
    });

    it("still supports the keyboard: arrows + Enter, typed name + Enter, Backspace", () => {
      act(() => root.render(<Harness dark={dark} onArticleMouseUp={() => {}} onArticleClick={() => {}} />));
      const input = $("input") as HTMLInputElement;
      act(() => input.focus());
      fire(input, "keydown", { key: "ArrowDown" });
      fire(input, "keydown", { key: "Enter" });
      expect($("#values").textContent).toBe("AI");

      act(() => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setValue.call(input, "Reading");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      fire(input, "keydown", { key: "Enter" });
      expect($("#values").textContent).toBe("AI,Reading");

      fire(input, "keydown", { key: "Backspace" });
      expect($("#values").textContent).toBe("AI");
    });
  });
}
