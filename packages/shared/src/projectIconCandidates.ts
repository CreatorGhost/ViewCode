/**
 * How a project's own logo is told apart from the other images in its tree: a name that says
 * favicon, icon or logo, a format that renders small (svg first), and a place where projects keep
 * their branding (the root, public/, static/, assets/, a monorepo app's public folder). The server
 * ranks a bounded walk of the tree with it when the well-known paths miss, and the icon pickers
 * list the best few. Explicit declarations (a web manifest, package.json "icon", Expo, Tauri, the
 * README's logo) are read by `iconPathsFrom*` and win over the ranking.
 */

const IMAGE_EXTENSION_SCORE: Readonly<Record<string, number>> = {
  svg: 6,
  png: 4,
  ico: 3,
  webp: 2,
  jpg: 0,
  jpeg: 0,
};

/** Directories never searched: dependencies, build and tool output, tests and samples. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "dist",
  "out",
  "target",
  "coverage",
  "vendor",
  "third_party",
  "third-party",
  "pods",
  "deriveddata",
  "venv",
  "__pycache__",
  "tmp",
  "temp",
  "test",
  "tests",
  "__tests__",
  "spec",
  "fixtures",
  "__fixtures__",
  "e2e",
  "example",
  "examples",
  "samples",
  "stories",
  "storybook-static",
]);

/** Whether a walk should skip a directory by its name. Dot folders are skipped except .github. */
export function isSkippedIconDirectory(name: string): boolean {
  if (name.startsWith(".")) return name !== ".github";
  return SKIPPED_DIRECTORIES.has(name.toLowerCase());
}

/** Tool and vendor marks that sit in many repos but are never the project's own logo. */
const THIRD_PARTY_MARKS: ReadonlySet<string> = new Set([
  "react",
  "vite",
  "vue",
  "svelte",
  "next",
  "nextjs",
  "nuxt",
  "astro",
  "remix",
  "vercel",
  "netlify",
  "tailwind",
  "tailwindcss",
  "typescript",
  "javascript",
  "js",
  "ts",
  "node",
  "nodejs",
  "deno",
  "bun",
  "electron",
  "tauri",
  "expo",
  "flutter",
  "angular",
  "github",
  "gitlab",
  "google",
  "apple",
  "microsoft",
  "twitter",
  "x",
  "discord",
  "slack",
  "npm",
  "pnpm",
  "yarn",
  "docker",
  "storybook",
  "figma",
]);

/** Folders where projects keep branding, at any level below the project or app root. */
const BRANDING_DIRECTORIES: ReadonlySet<string> = new Set([
  "public",
  "static",
  "assets",
  "images",
  "img",
  "media",
  "resources",
  "branding",
  "brand",
  "logo",
  "logos",
  "icons",
  "app",
  "src-tauri",
  "web",
  ".github",
]);

/** Monorepo roots whose children are apps or packages with their own public folders. */
const MONOREPO_DIRECTORIES: ReadonlySet<string> = new Set(["apps", "packages", "sites"]);
const FRONT_DOOR_APPS: ReadonlySet<string> = new Set([
  "web",
  "www",
  "site",
  "website",
  "landing",
  "marketing",
  "frontend",
  "app",
  "desktop",
  "docs",
]);

const SIZE_OR_VARIANT_SUFFIX =
  /(?:[-_.@]?(?:\d+x\d+|\d+x|\d{2,4})|[-_](?:light|dark|white|black|color|colour|mono|square|round|rounded|circle|transparent|full|small|large|lg|sm|md|xl|default|primary|alt|v\d+))$/;

function stripSizeAndVariant(base: string): string {
  let current = base;
  for (let guard = 0; guard < 6; guard += 1) {
    const next = current.replace(SIZE_OR_VARIANT_SUFFIX, "");
    if (next === current) break;
    current = next;
  }
  return current;
}

function smallestSizeIn(base: string): number | null {
  const sizes = [...base.matchAll(/(\d{2,4})(?:x\d{2,4})?/g)].map((match) => Number(match[1]));
  return sizes.length === 0 ? null : Math.min(...sizes);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** How much a cleaned file name says "this is the project's mark", or null when it does not. */
function nameScore(
  cleaned: string,
  parentDirectory: string | undefined,
  projectSlug: string | null,
): number | null {
  if (cleaned === "favicon" || cleaned.startsWith("favicon-")) return 100;
  if (/^(?:app[-_]?)?icon$|^application[-_]icon$|^icon[-_]only$/.test(cleaned)) return 90;
  if (
    /^(?:logo|logomark|logo[-_]mark|logo[-_]icon|logo[-_]only|brandmark|brand|mark|symbol)$/.test(
      cleaned,
    )
  ) {
    return 85;
  }
  if (projectSlug !== null && projectSlug.length > 1 && slug(cleaned) === projectSlug) return 80;
  if (/^apple[-_]touch[-_]icon(?:[-_]precomposed)?$/.test(cleaned)) return 75;
  if (/^(?:android[-_]chrome|mstile|maskable[-_]icon|pwa[-_]icon|pwa)$/.test(cleaned)) return 65;
  // Tauri and Electron keep size-named icons ("32x32.png") in an icons folder.
  if (cleaned === "" && parentDirectory === "icons") return 70;
  const tokens = cleaned.split(/[-_.\s]+/).filter(Boolean);
  if (tokens.some((token) => THIRD_PARTY_MARKS.has(token))) return null;
  if (tokens.includes("logo") || tokens.includes("favicon")) return 60;
  if (projectSlug !== null && projectSlug.length > 2 && slug(cleaned).includes(projectSlug)) {
    return tokens.includes("icon") ? 55 : null;
  }
  return null;
}

/**
 * A score for one image path relative to the project root ("/" or "\\" separated), higher being
 * more likely the project's own logo; null when the path is not a candidate at all.
 */
export function scoreProjectIconPath(
  relativePath: string,
  options?: { readonly projectName?: string | undefined },
): number | null {
  const segments = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean);
  const fileName = segments.at(-1);
  if (!fileName) return null;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  const extensionScore = IMAGE_EXTENSION_SCORE[extension];
  if (extensionScore === undefined) return null;

  let directories = segments.slice(0, -1);
  if (directories.some(isSkippedIconDirectory)) return null;

  const base = fileName.slice(0, dot).toLowerCase();
  const projectSlug = options?.projectName ? slug(options.projectName) : null;
  const kind = nameScore(stripSizeAndVariant(base), directories.at(-1)?.toLowerCase(), projectSlug);
  if (kind === null) return null;

  // A monorepo app counts as a root of its own, a little behind the project root itself.
  let location = 0;
  const first = directories[0]?.toLowerCase();
  if (first && MONOREPO_DIRECTORIES.has(first) && directories.length >= 2) {
    location -= 15;
    if (FRONT_DOOR_APPS.has(directories[1]!.toLowerCase())) location += 3;
    directories = directories.slice(2);
  }
  location += 10 - 3 * directories.length;
  if (directories.some((directory) => BRANDING_DIRECTORIES.has(directory.toLowerCase()))) {
    location += 4;
  }
  if (directories.some((directory) => directory.toLowerCase() === "build")) location -= 4;

  const smallest = smallestSizeIn(base);
  const sizePenalty = smallest !== null && smallest < 32 ? 5 : 0;

  return kind + extensionScore + location - sizePenalty;
}

/** The best `limit` candidates among `paths`, best first; paths that are not candidates drop. */
export function rankProjectIconPaths(
  paths: Iterable<string>,
  options?: { readonly projectName?: string | undefined; readonly limit?: number },
): string[] {
  const scored: Array<{ readonly path: string; readonly score: number }> = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const score = scoreProjectIconPath(path, options);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.path.length - right.path.length ||
      left.path.localeCompare(right.path),
  );
  return scored.slice(0, options?.limit ?? 8).map((entry) => entry.path);
}

function isLocalImageReference(reference: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("//")) return false;
  const clean = reference.split(/[?#]/)[0] ?? "";
  return /\.(?:svg|png|ico|webp|jpe?g)$/i.test(clean);
}

function cleanReference(reference: string): string {
  return (reference.split(/[?#]/)[0] ?? "").replace(/^\.\//, "").replace(/^\//, "");
}

/**
 * Logo images the top of a README shows: local image references whose path or alt text says
 * logo, icon or brand, skipping banners, screenshots and badges. Paths are relative to the README.
 */
export function iconPathsFromReadme(markdown: string): string[] {
  const head = markdown.split("\n").slice(0, 60).join("\n");
  const references: Array<{ readonly source: string; readonly alt: string }> = [];
  for (const match of head.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
    references.push({ alt: match[1] ?? "", source: match[2] ?? "" });
  }
  for (const match of head.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const source = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (source)
      references.push({ source, alt: /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "" });
  }
  const paths: string[] = [];
  for (const { source, alt } of references) {
    if (!isLocalImageReference(source)) continue;
    const text = `${source} ${alt}`.toLowerCase();
    if (/banner|screenshot|screen-shot|demo|preview|badge|shields|hero|cover/.test(text)) continue;
    if (!/logo|icon|brand|mark/.test(text)) continue;
    paths.push(cleanReference(source));
  }
  return paths;
}

function iconSourcesFromList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries = value.flatMap((entry) => {
    if (typeof entry === "string") return [{ source: entry, size: smallestSizeIn(entry) ?? 0 }];
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { src?: unknown }).src === "string"
    ) {
      const sizes = (entry as { sizes?: unknown }).sizes;
      const size =
        typeof sizes === "string"
          ? Math.max(0, ...sizes.split(/\s+/).map((s) => Number.parseInt(s, 10) || 0))
          : 0;
      return [{ source: (entry as { src: string }).src, size }];
    }
    return [];
  });
  // Largest first: the pickers draw them small, and a large source stays crisp.
  return [...entries]
    .sort((left, right) => right.size - left.size)
    .map((entry) => entry.source)
    .filter(isLocalImageReference)
    .map(cleanReference);
}

/** Icons a web app manifest declares, largest first, relative to the manifest. */
export function iconPathsFromWebManifest(source: string): string[] {
  try {
    return iconSourcesFromList((JSON.parse(source) as { icons?: unknown }).icons);
  } catch {
    return [];
  }
}

/**
 * Icons a project config declares, relative to the config file: package.json "icon" (VS Code
 * extensions) and electron-builder's "build.icon", Expo's app.json "expo.icon", and Tauri's
 * "bundle.icon" list (tauri.conf.json, v1 or v2).
 */
export function iconPathsFromProjectConfig(source: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const pick = (value: unknown): string[] =>
    typeof value === "string" && isLocalImageReference(value) ? [cleanReference(value)] : [];
  const nested = (value: unknown, key: string): unknown =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return [
    ...pick(record.icon),
    ...pick(nested(record.build, "icon")),
    ...pick(nested(record.expo, "icon")),
    ...iconSourcesFromList(nested(record.bundle, "icon")),
    ...iconSourcesFromList(nested(nested(record.tauri, "bundle"), "icon")),
  ];
}
