/**
 * Converts a drafted message, as rendered in a reply, into the text a destination
 * expects: Slack mrkdwn, WhatsApp's markers, Markdown, or plain text.
 *
 * It walks the rendered DOM rather than re-parsing the Markdown source: the DOM is
 * exactly what the user sees (file chips, highlighted code, escaped literal `*`), so
 * nothing is re-interpreted. Markdown reuses markdown-clipboard's serializer as is.
 */
import {
  isSkippedElement,
  sanitizedHtmlFrom,
  serializeRenderedMarkdownFragment,
  wrapInlineMarker,
} from "../markdown-clipboard";

/** How the draft copy button copies: `rich` is HTML plus plain text, the rest one format. */
export const DRAFT_COPY_FORMATS = ["rich", "slack", "whatsapp", "markdown", "plain"] as const;
export type DraftCopyFormat = (typeof DRAFT_COPY_FORMATS)[number];
export type MessageFormat = Exclude<DraftCopyFormat, "rich">;

interface Dialect {
  readonly bold: string;
  readonly italic: string;
  readonly strike: string;
  readonly bullet: string;
  readonly inlineCode: (code: string) => string;
  readonly codeBlock: (code: string) => string;
  readonly link: (label: string, href: string) => string;
  readonly heading: (text: string) => string;
  /** Breaks literal markers in text that the destination would read as formatting. */
  readonly escape: (text: string) => string;
}

/**
 * Slack and WhatsApp have no escape character. An opening marker must follow a
 * space or the start of a line, so a zero-width space in front of a literal one
 * keeps "*not bold*" literal; markers inside words (snake_case) never open.
 */
function breakOpeningMarkers(text: string): string {
  return text.replace(/(^|[\s([{"'])([*_~`])(?=\S)/g, "$1​$2");
}

const PLAIN: Dialect = {
  bold: "",
  italic: "",
  strike: "",
  bullet: "• ",
  inlineCode: (code) => code,
  codeBlock: (code) => code,
  link: (label, href) => (label === href ? href : `${label} (${href})`),
  heading: (text) => text,
  escape: (text) => text,
};

const SLACK: Dialect = {
  bold: "*",
  italic: "_",
  strike: "~",
  bullet: "• ",
  inlineCode: (code) => `\`${code}\``,
  codeBlock: (code) => `\`\`\`\n${code}\n\`\`\``,
  // `<url|text>` only renders in bot and API messages; pasted into the message box it
  // shows literally, so a pasted draft names the link and gives the URL after it.
  link: (label, href) => (label === href ? href : `${label} (${href})`),
  heading: (text) => `*${text}*`,
  escape: breakOpeningMarkers,
};

const WHATSAPP: Dialect = {
  bold: "*",
  italic: "_",
  strike: "~",
  bullet: "- ",
  inlineCode: (code) => `\`${code}\``,
  codeBlock: (code) => `\`\`\`${code}\`\`\``,
  link: (label, href) => (label === href ? href : `${label}: ${href}`),
  heading: (text) => `*${text}*`,
  escape: breakOpeningMarkers,
};

/** Code is kept out of whitespace tidying and list indentation, then put back. */
interface Walk {
  readonly dialect: Dialect;
  readonly code: string[];
}

function protect(walk: Walk, code: string): string {
  walk.code.push(code);
  return `\uE000${walk.code.length - 1}\uE000`;
}

/** Slack and WhatsApp markers stop at a line break, so each line is wrapped on its own. */
function wrap(content: string, marker: string): string {
  if (!marker) return content;
  return content
    .split("\n")
    .map((line) => wrapInlineMarker(line, marker))
    .join("\n");
}

function children(node: Node, walk: Walk): string {
  let out = "";
  for (const child of node.childNodes) out += serialize(child, walk);
  return out;
}

/** Inside a marker, the same marker is dropped: `*a *b* c*` would close early. */
function withoutMarker(walk: Walk, key: "bold" | "italic" | "strike"): Walk {
  return { ...walk, dialect: { ...walk.dialect, [key]: "" } };
}

function serializeLink(anchor: Element, walk: Walk): string {
  const label = children(anchor, walk).trim();
  const href = anchor.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return label;
  return walk.dialect.link(label || href, href);
}

function taskMarker(item: Element): string {
  for (const child of item.childNodes) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const input =
      element.tagName === "INPUT"
        ? element
        : element.tagName === "P"
          ? [...element.children].find((inner) => inner.tagName === "INPUT")
          : undefined;
    if (input?.getAttribute("type") === "checkbox") {
      return (input as HTMLInputElement).checked ? "☑ " : "☐ ";
    }
  }
  return "";
}

function serializeList(list: Element, ordered: boolean, walk: Walk): string {
  const start = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
  const items = [...list.children].filter((child) => child.tagName === "LI");
  const lines = items.map((item, index) => {
    const marker = `${ordered ? `${start + index}. ` : walk.dialect.bullet}${taskMarker(item)}`;
    let content = children(item, walk)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const loose = [...item.children].some((child) => child.tagName === "P");
    if (!loose) content = content.replace(/\n{2,}/g, "\n");
    const indent = " ".repeat(marker.length);
    const [first = "", ...rest] = content.split("\n");
    return [`${marker}${first}`, ...rest.map((line) => (line ? `${indent}${line}` : line))].join(
      "\n",
    );
  });
  // The leading break starts a nested list on its own line under its item's text.
  return lines.length > 0 ? `\n${lines.join("\n")}\n\n` : "";
}

function serializeTable(table: Element, walk: Walk): string {
  const rows: Element[] = [];
  for (const child of table.children) {
    if (child.tagName === "TR") rows.push(child);
    else if (child.tagName === "THEAD" || child.tagName === "TBODY") {
      rows.push(...[...child.children].filter((row) => row.tagName === "TR"));
    }
  }
  const lines = rows
    .map((row) =>
      [...row.children]
        .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
        .map((cell) => children(cell, walk).replace(/\s+/g, " ").trim())
        .join(" | "),
    )
    .filter(Boolean);
  return lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
}

function serialize(node: Node, walk: Walk): string {
  const { dialect } = walk;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (text.includes("\n") && text.trim().length === 0) return "\n";
    return dialect.escape(text);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;

  if (element.hasAttribute("data-markdown-details")) {
    const summary = element.querySelector(":scope > [data-markdown-details-summary]");
    const content = element.querySelector(":scope > * [data-markdown-details-content]");
    const title = summary ? children(summary, walk).trim() : "";
    const body = content ? children(content, walk).trim() : "";
    return `${wrap(title, dialect.bold)}\n\n${body}\n\n`;
  }
  // Chips (files, context, PRs) carry Markdown for selection copy; other formats
  // take the label the reader sees, or a link for a web URL.
  if (element.hasAttribute("data-markdown-copy")) {
    return element.tagName === "A" ? serializeLink(element, walk) : children(element, walk);
  }
  if (isSkippedElement(element)) return "";

  if (/^H[1-6]$/.test(element.tagName)) {
    const text = children(element, withoutMarker(walk, "bold")).trim();
    return text ? `${dialect.heading(text)}\n\n` : "";
  }

  switch (element.tagName) {
    case "BR":
      return "\n";
    case "HR":
      return "---\n\n";
    case "P":
      return `${children(element, walk).trim()}\n\n`;
    case "PRE":
      return `${protect(walk, dialect.codeBlock((element.textContent ?? "").replace(/\n$/, "")))}\n\n`;
    case "CODE": {
      const code = element.textContent ?? "";
      return protect(walk, code.includes("\n") ? code : dialect.inlineCode(code));
    }
    case "STRONG":
    case "B":
      return wrap(children(element, withoutMarker(walk, "bold")), dialect.bold);
    case "EM":
    case "I":
      return wrap(children(element, withoutMarker(walk, "italic")), dialect.italic);
    case "DEL":
    case "S":
      return wrap(children(element, withoutMarker(walk, "strike")), dialect.strike);
    case "A":
      return serializeLink(element, walk);
    case "IMG": {
      const alt = element.getAttribute("alt") ?? "";
      const src = element.getAttribute("src") ?? "";
      return /^https?:\/\//i.test(src) ? dialect.link(alt || src, src) : alt;
    }
    case "UL":
      return serializeList(element, false, walk);
    case "OL":
      return serializeList(element, true, walk);
    case "BLOCKQUOTE": {
      const content = children(element, walk)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!content) return "";
      return `${content
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n")}\n\n`;
    }
    case "TABLE":
      return serializeTable(element, walk);
    case "DIV":
    case "SECTION":
    case "ARTICLE": {
      const content = children(element, walk);
      return content && !content.endsWith("\n") ? `${content}\n` : content;
    }
    default:
      return children(element, walk);
  }
}

const DIALECTS: Record<Exclude<MessageFormat, "markdown">, Dialect> = {
  plain: PLAIN,
  slack: SLACK,
  whatsapp: WHATSAPP,
};

/** The message inside `root` (not `root` itself) in `format`. */
export function formatRenderedMessage(root: Node, format: MessageFormat): string {
  if (format === "markdown") return serializeRenderedMarkdownFragment(root);
  const walk: Walk = { dialect: DIALECTS[format], code: [] };
  return children(root, walk)
    .replace(/[ \t]+(?=\n)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\uE000(\d+)\uE000/g, (_, index: string) => walk.code[Number(index)] ?? "");
}

export const DRAFT_COPY_FORMAT_LABELS: Record<DraftCopyFormat, string> = {
  rich: "Copy",
  slack: "Copy for Slack",
  whatsapp: "Copy for WhatsApp",
  markdown: "Copy as Markdown",
  plain: "Copy as plain text",
};

export interface DraftClipboardPayload {
  readonly text: string;
  readonly flavors?: Readonly<Record<string, string>>;
}

/**
 * What the draft copy button writes. Rich copies keep bold and lists in apps that
 * read HTML (Slack desktop, Gmail, Outlook, Notion, Docs, Teams), and give apps that
 * read only text (WhatsApp, SMS, terminals) plain text with no markers.
 */
export function draftClipboardPayload(
  root: Element,
  format: DraftCopyFormat,
): DraftClipboardPayload {
  if (format !== "rich") return { text: formatRenderedMessage(root, format) };
  const text = formatRenderedMessage(root, "plain");
  const html = sanitizedHtmlFrom(root.cloneNode(true) as Element);
  return { text, flavors: { "text/html": html } };
}
