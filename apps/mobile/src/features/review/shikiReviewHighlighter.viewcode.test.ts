import { describe, expect, it } from "vite-plus/test";

import { highlightCodeSnippet } from "./shikiReviewHighlighter";

const FENCES = {
  tsx: [
    'import { useState } from "react";',
    "",
    "export function Counter({ label }: { label: string }) {",
    "  const [count, setCount] = useState(0);",
    '  return <button className="btn" onClick={() => setCount(count + 1)}>{label} — {count}</button>;',
    "}",
  ].join("\n"),
  // Agents often answer with a JSX fragment rather than a whole file.
  "tsx fragment": "editable={!pending && !unavailable && preferred !== null}",
  ts: "export const clamp = (value: number, min: number): number => Math.max(value, min);",
  jsx: 'const Hello = () => <p className="hi">Hello</p>;',
  python: 'def dedupe(items):\n    return list(dict.fromkeys(items))\n\nprint("ok")',
  json: '{ "name": "viewcode", "private": true, "version": 1 }',
} as const;

describe("chat code fences", () => {
  it.each(Object.entries(FENCES))("colours a %s fence", async (name, code) => {
    const language = name.split(" ")[0]!;
    for (const theme of ["light", "dark"] as const) {
      const lines = await highlightCodeSnippet({ code, language, theme, session: {} });
      expect(lines.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(
        code,
      );
      const colors = new Set(lines.flat().map((token) => token.color));
      expect(colors.size).toBeGreaterThanOrEqual(2);
      expect(colors.has(null)).toBe(false);
    }
  });
});
