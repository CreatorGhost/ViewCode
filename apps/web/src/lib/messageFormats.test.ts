import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { draftClipboardPayload, formatRenderedMessage, type MessageFormat } from "./messageFormats";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const ZWSP = "​";

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];
  parent: FakeElement | null = null;

  constructor(readonly textContent: string) {}

  get outerHTML(): string {
    return this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  }

  cloneNode(): FakeText {
    return new FakeText(this.textContent);
  }
}

/** The slice of the DOM the formatter and the HTML sanitizer use, with simple selectors. */
class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  parent: FakeElement | null = null;
  checked = false;
  readonly classList = {
    contains: (name: string) => (this.attributes["class"] ?? "").split(" ").includes(name),
  };

  constructor(
    readonly tagName: string,
    readonly attributes: Record<string, string> = {},
  ) {}

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  get children(): ReadonlyArray<FakeElement> {
    return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
  }

  get innerHTML(): string {
    return this.childNodes.map((child) => child.outerHTML).join("");
  }

  get outerHTML(): string {
    const attributes = Object.entries(this.attributes)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join("");
    return `<${this.localName}${attributes}>${this.innerHTML}</${this.localName}>`;
  }

  append(...nodes: Array<FakeElement | FakeText | string>): this {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeText(node) : node;
      child.parent = this;
      this.childNodes.push(child);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name);
  }

  matches(selector: string): boolean {
    return selector.split(", ").some((part) => {
      if (part.startsWith(".")) return this.classList.contains(part.slice(1));
      const attribute = /^\[([\w-]+)="(.*)"\]$/.exec(part);
      if (attribute) return this.getAttribute(attribute[1] ?? "") === attribute[2];
      return this.localName === part;
    });
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }

  /** Child selectors (task checkboxes, details parts) find nothing in these fixtures. */
  querySelector(): FakeElement | null {
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1);
    this.parent = null;
  }

  cloneNode(): FakeElement {
    const clone = new FakeElement(this.tagName, { ...this.attributes });
    clone.checked = this.checked;
    return clone.append(...this.childNodes.map((child) => child.cloneNode()));
  }
}

type Child = FakeElement | string;
const h =
  (tagName: string) =>
  (...children: Child[]) =>
    new FakeElement(tagName).append(...children);
const p = h("P");
const strong = h("STRONG");
const em = h("EM");
const del = h("DEL");
const code = h("CODE");
const li = h("LI");
const ul = h("UL");
const quote = h("BLOCKQUOTE");
const a = (href: string, ...children: Child[]) =>
  new FakeElement("A", { href }).append(...children);
const ol = (start: number, ...children: Child[]) =>
  new FakeElement("OL", { start: String(start) }).append(...children);
const heading = (...children: Child[]) => new FakeElement("H2").append(...children);

/** A code block as ChatMarkdown renders it: select-none header chrome plus a pre. */
function codeBlock(text: string): FakeElement {
  return new FakeElement("DIV", { class: "chat-markdown-codeblock" }).append(
    new FakeElement("DIV", { class: "select-none" }).append("ts"),
    new FakeElement("BUTTON").append("Copy"),
    h("PRE")(code(`${text}\n`)),
  );
}

function format(root: FakeElement, target: MessageFormat): string {
  return formatRenderedMessage(root as unknown as Node, target);
}

/** One draft with every construct a message tends to use. */
function draft(): FakeElement {
  return quote(
    heading("Release ", strong("notes")),
    p("Hi ", strong("team"), ", the ", em("new"), " build is ", del("late"), " ready."),
    ul(li("Read ", a("https://example.com/doc", "the doc")), li(strong("Run ", code("vp i")))),
    ol(3, li("Third"), li("Fourth")),
    codeBlock("const a = 1;\n\n\nconst b = 2;"),
    p("See ", a("https://example.com", "https://example.com"), "."),
  );
}

describe("formatRenderedMessage", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes plain text with no markers, links spelled out and code kept verbatim", () => {
    expect(format(draft(), "plain")).toBe(
      [
        "Release notes",
        "",
        "Hi team, the new build is late ready.",
        "",
        "• Read the doc (https://example.com/doc)",
        "• Run vp i",
        "",
        "3. Third",
        "4. Fourth",
        "",
        "const a = 1;\n\n\nconst b = 2;",
        "",
        "See https://example.com.",
      ].join("\n"),
    );
  });

  it("writes Slack mrkdwn", () => {
    expect(format(draft(), "slack")).toBe(
      [
        "*Release notes*",
        "",
        "Hi *team*, the _new_ build is ~late~ ready.",
        "",
        "• Read the doc (https://example.com/doc)",
        "• *Run `vp i`*",
        "",
        "3. Third",
        "4. Fourth",
        "",
        "```\nconst a = 1;\n\n\nconst b = 2;\n```",
        "",
        "See https://example.com.",
      ].join("\n"),
    );
  });

  it("writes WhatsApp markers, with dashed lists and links as text: url", () => {
    expect(format(draft(), "whatsapp")).toBe(
      [
        "*Release notes*",
        "",
        "Hi *team*, the _new_ build is ~late~ ready.",
        "",
        "- Read the doc: https://example.com/doc",
        "- *Run `vp i`*",
        "",
        "3. Third",
        "4. Fourth",
        "",
        "```const a = 1;\n\n\nconst b = 2;```",
        "",
        "See https://example.com.",
      ].join("\n"),
    );
  });

  it("writes standard Markdown through the selection-copy serializer", () => {
    expect(format(draft(), "markdown")).toBe(
      [
        "## Release **notes**",
        "",
        "Hi **team**, the *new* build is ~~late~~ ready.",
        "",
        "- Read [the doc](https://example.com/doc)",
        "- **Run `vp i`**",
        "",
        "3. Third",
        "4. Fourth",
        "",
        "```\nconst a = 1;\n\n\nconst b = 2;\n```",
        "",
        "See https://example.com.",
      ].join("\n"),
    );
  });

  it("nests lists under their item and keeps links inside bold", () => {
    const root = quote(ul(li("Parent", ul(li("Child ", strong(a("https://x.dev", "link")))))));
    expect(format(root, "plain")).toBe("• Parent\n  • Child link (https://x.dev)");
    expect(format(root, "slack")).toBe("• Parent\n  • Child *link (https://x.dev)*");
    expect(format(root, "whatsapp")).toBe("- Parent\n  - Child *link: https://x.dev*");
  });

  it("hoists whitespace outside markers and does not double a marker nested in itself", () => {
    const root = quote(p("A", strong(" bold "), "word and ", strong("x ", strong("y"), " z")));
    expect(format(root, "slack")).toBe("A *bold* word and *x y z*");
    expect(format(root, "plain")).toBe("A bold word and x y z");
  });

  it("wraps each line of a marker that spans a line break", () => {
    const root = quote(p(strong("one", h("BR")(), "two")));
    expect(format(root, "whatsapp")).toBe("*one*\n*two*");
  });

  it("keeps literal markers literal for Slack and WhatsApp, leaving snake_case alone", () => {
    const root = quote(p("*not bold* and _not italic_ in snake_case_name, 2 * 3"));
    const expected = `${ZWSP}*not bold* and ${ZWSP}_not italic_ in snake_case_name, 2 * 3`;
    expect(format(root, "slack")).toBe(expected);
    expect(format(root, "whatsapp")).toBe(expected);
    expect(format(root, "plain")).toBe("*not bold* and _not italic_ in snake_case_name, 2 * 3");
  });

  it("does not touch markers inside code", () => {
    const root = quote(p(code("*args")));
    expect(format(root, "slack")).toBe("`*args`");
  });

  it("copies a non-web link as its text and a chip as its label", () => {
    const chip = new FakeElement("BUTTON", { "data-markdown-copy": "[a.ts](/repo/a.ts)" }).append(
      new FakeElement("svg", { "aria-hidden": "true" }),
      "a.ts",
    );
    const root = quote(p("Open ", a("/repo/b.ts", "b.ts"), " and ", chip));
    expect(format(root, "plain")).toBe("Open b.ts and a.ts");
    expect(format(root, "markdown")).toBe("Open b.ts and [a.ts](/repo/a.ts)");
  });

  it("marks tasks and keeps nested quotes", () => {
    const done = new FakeElement("INPUT", { type: "checkbox" });
    done.checked = true;
    const root = h("DIV")(
      ul(li(done, " Ship"), li(new FakeElement("INPUT", { type: "checkbox" }), " Test")),
      quote(p("They said hi")),
    );
    expect(format(root, "plain")).toBe("• ☑ Ship\n• ☐ Test\n\n> They said hi");
  });
});

describe("draftClipboardPayload", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies rich HTML alongside marker-free plain text, leaving the page untouched", () => {
    const root = quote(p("Hi ", strong("team")), codeBlock("x"));
    const payload = draftClipboardPayload(root as unknown as Element, "rich");

    expect(payload.text).toBe("Hi team\n\nx");
    expect(payload.flavors?.["text/html"]).toBe(
      '<meta charset="utf-8"><p>Hi <strong>team</strong></p><div class="chat-markdown-codeblock"><pre><code>x\n</code></pre></div>',
    );
    // The sanitizer works on a copy: the rendered quote keeps its controls.
    expect(root.querySelectorAll("button")).toHaveLength(1);
  });

  it("copies a single text flavor for a destination format", () => {
    const root = quote(p("Hi ", strong("team")));
    expect(draftClipboardPayload(root as unknown as Element, "whatsapp")).toEqual({
      text: "Hi *team*",
    });
  });
});
