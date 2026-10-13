/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import {
  iconPathsFromProjectConfig,
  iconPathsFromReadme,
  iconPathsFromWebManifest,
  isSkippedIconDirectory,
  projectIconFamilyKey,
  rankProjectIconPaths,
} from "@t3tools/shared/projectIconCandidates";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

// Resolution probes 21 well-known paths plus 7 source files, then the declared icons and a
// bounded walk of the tree, so a miss costs a few hundred filesystem calls. AssetAccess resolves
// on every project-favicon asset URL, and a project's icon does not move, so the answer is cached.
const FAVICON_CACHE_CAPACITY = 512;
const FAVICON_POSITIVE_CACHE_TTL = Duration.minutes(10);
const FAVICON_NEGATIVE_CACHE_TTL = Duration.minutes(5);

// Logo choices the icon pickers offer, best first.
const ICON_CANDIDATE_LIMIT = 8;
// The walk for logo-like images: deep enough for apps/web/public/favicon.svg and
// src-tauri/icons/icon.png, bounded so a huge tree costs a fixed amount.
const ICON_SCAN_MAX_DEPTH = 4;
const ICON_SCAN_MAX_DIRECTORIES = 300;
const ICON_SCAN_IMAGE_RE = /\.(?:svg|png|ico|webp|jpe?g)$/i;

// Files that declare an icon outright: web manifests, package.json (VS Code "icon",
// electron-builder "build.icon"), Expo's app.json, Tauri's config, and the README's logo.
const ICON_MANIFEST_FILES = [
  "site.webmanifest",
  "manifest.json",
  "manifest.webmanifest",
  "public/site.webmanifest",
  "public/manifest.json",
  "public/manifest.webmanifest",
  "static/site.webmanifest",
  "static/manifest.json",
  "app/manifest.json",
  "web/manifest.json",
] as const;
const ICON_CONFIG_FILES = [
  "package.json",
  "app.json",
  "src-tauri/tauri.conf.json",
  "tauri.conf.json",
] as const;
const ICON_README_FILES = ["README.md", "readme.md", "Readme.md", ".github/README.md"] as const;

function faviconCacheKey(cwd: string, faviconPath?: string): string {
  return `${faviconPath ?? ""}\0${cwd}`;
}

function parseFaviconCacheKey(key: string): {
  readonly cwd: string;
  readonly faviconPath?: string;
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return { cwd: key };
  }
  const faviconPath = key.slice(0, separatorIndex);
  const cwd = key.slice(separatorIndex + 1);
  return faviconPath.length === 0 ? { cwd } : { cwd, faviconPath };
}

// Well-known favicon paths checked in order.
const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".idea/icon.svg",
] as const;

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
// The tag pattern is anchored on `<link`, so it only starts at real candidates. Object metadata
// is matched by scanning brace-free runs instead of by one combined pattern: an unanchored
// pattern restarts at every offset and rescans forward, which is quadratic on large sources.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

export class ProjectFaviconResolutionError extends Schema.TaggedError<ProjectFaviconResolutionError>()(
  "ProjectFaviconResolutionError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "resolve-path",
      "stat-candidate",
      "read-source",
    ]),
    workspaceRoot: Schema.String,
    relativePath: Schema.optional(Schema.String),
    absolutePath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve project favicon during ${this.operation} for workspace ${this.workspaceRoot}.`;
  }
}

/** Service tag for project favicon resolution. */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  {
    /**
     * Resolve a favicon or icon file path for the provided workspace root.
     *
     * Returns `null` when no candidate icon file can be found.
     */
    readonly resolvePath: (
      cwd: string,
      faviconPath?: string,
    ) => Effect.Effect<string | null, ProjectFaviconResolutionError>;
    /**
     * Logo images a user may pick for the project, best first, as paths relative to the
     * workspace root: the icon chosen automatically, then declared icons, then the most
     * logo-like images in the tree.
     */
    readonly listCandidates: (
      cwd: string,
      projectName?: string,
    ) => Effect.Effect<ReadonlyArray<string>, ProjectFaviconResolutionError>;
  }
>()("t3/project/ProjectFaviconResolver") {}

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  // Icon metadata counts when `rel` and `href` share a brace-free run, so a run holding `rel`
  // but no href falls through to the next one rather than ending the search.
  for (const run of source.split("}")) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch?.[1]) return hrefMatch[1];
  }
  return null;
}

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const projectFileLoader = yield* T3ProjectFileLoader.T3ProjectFileLoader;

  const resolveIconHref = (href: string): ReadonlyArray<string> => {
    const clean = href.replace(/^\//, "");
    return [path.join("public", clean), clean];
  };

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    relativeCandidates: ReadonlyArray<string>,
    candidateScope: "workspace" | "filesystem",
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    for (const relativePath of relativeCandidates) {
      const candidate = yield* (
        candidateScope === "filesystem" && path.isAbsolute(relativePath)
          ? Effect.succeed({ absolutePath: relativePath, relativePath })
          : workspacePaths.resolveRelativePathWithinRoot({
              workspaceRoot: projectCwd,
              relativePath,
            })
      ).pipe(
        Effect.asSome,
        Effect.catchTags({
          WorkspacePathOutsideRootError: () =>
            Effect.succeed(
              Option.none<{ readonly absolutePath: string; readonly relativePath: string }>(),
            ),
        }),
      );
      if (Option.isNone(candidate)) {
        continue;
      }
      const stats = yield* optionOnNotFound(fileSystem.stat(candidate.value.absolutePath)).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "stat-candidate",
              workspaceRoot: projectCwd,
              relativePath,
              absolutePath: candidate.value.absolutePath,
              cause,
            }),
        ),
      );
      if (Option.isSome(stats) && stats.value.type === "File") {
        return candidate.value.absolutePath;
      }
    }
    return null;
  });

  // Reads one source file and resolves the icon it declares, if any.
  const findIconFromSource = Effect.fn("ProjectFaviconResolver.findIconFromSource")(function* (
    projectCwd: string,
    sourceFile: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    const sourcePath = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: projectCwd,
        relativePath: sourceFile,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "resolve-path",
              workspaceRoot: projectCwd,
              relativePath: sourceFile,
              cause,
            }),
        ),
      );
    const source = yield* optionOnNotFound(fileSystem.readFileString(sourcePath.absolutePath)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "read-source",
            workspaceRoot: projectCwd,
            relativePath: sourceFile,
            absolutePath: sourcePath.absolutePath,
            cause,
          }),
      ),
    );
    if (Option.isNone(source)) {
      return null;
    }
    const href = extractIconHref(source.value);
    if (!href) {
      return null;
    }
    return yield* findExistingFile(projectCwd, resolveIconHref(href), "workspace");
  });

  // Starts every probe at once and returns the first hit in list order. A miss
  // costs one round of filesystem latency instead of one per probe, which
  // matters when the disk is slow. Fibers are joined in order, so a hit returns
  // without waiting for lower-ranked probes (the scope interrupts them), and a
  // failure surfaces only when no earlier probe found a file.
  const firstInOrder = <A>(
    items: ReadonlyArray<A>,
    probe: (item: A) => Effect.Effect<string | null, ProjectFaviconResolutionError>,
  ) =>
    Effect.gen(function* () {
      const fibers = yield* Effect.forEach(items, (item) => Effect.forkScoped(probe(item)));
      for (const fiber of fibers) {
        const found = yield* Fiber.join(fiber);
        if (found) {
          return found;
        }
      }
      return null;
    }).pipe(Effect.scoped);

  // Reads a small text file inside the workspace; a missing or unreadable file reads as absent,
  // since these sources only add candidates and must never fail resolution.
  const readOptionalSource = (projectCwd: string, relativePath: string) =>
    workspacePaths.resolveRelativePathWithinRoot({ workspaceRoot: projectCwd, relativePath }).pipe(
      Effect.flatMap((resolved) => fileSystem.readFileString(resolved.absolutePath)),
      Effect.map((source) => (source.length > 512_000 ? null : source)),
      Effect.orElseSucceed(() => null),
    );

  // Icons the project declares, relative to the workspace root and existing on disk, in order.
  const findDeclaredIcons = Effect.fn("ProjectFaviconResolver.findDeclaredIcons")(function* (
    projectCwd: string,
  ): Effect.fn.Return<ReadonlyArray<string>, ProjectFaviconResolutionError> {
    const sources = [
      ...ICON_MANIFEST_FILES.map((file) => ({ file, read: iconPathsFromWebManifest })),
      ...ICON_CONFIG_FILES.map((file) => ({ file, read: iconPathsFromProjectConfig })),
      ...ICON_README_FILES.map((file) => ({ file, read: iconPathsFromReadme })),
    ];
    const declared = yield* Effect.forEach(
      sources,
      ({ file, read }) =>
        readOptionalSource(projectCwd, file).pipe(
          Effect.map((source) => {
            if (source === null) return [];
            const directory = path.dirname(file);
            return read(source).map((reference) =>
              directory === "." ? reference : path.join(directory, reference),
            );
          }),
        ),
      { concurrency: 8 },
    );
    const found: string[] = [];
    for (const relativePath of new Set(declared.flat())) {
      const existing = yield* findExistingFile(projectCwd, [relativePath], "workspace");
      if (existing) found.push(path.relative(projectCwd, existing));
    }
    return found;
  });

  // Image files in a bounded breadth-first walk of the workspace, relative to its root. Skips
  // dependencies, build output, tests and dot folders (isSkippedIconDirectory); only names
  // without an extension are checked as folders, so the walk stays a readdir per folder. A
  // linked folder is walked once and only when it lands inside the workspace, so a link loop
  // offers no copies and a link out of the project offers nothing from there.
  const scanImageFiles = Effect.fn("ProjectFaviconResolver.scanImageFiles")(function* (
    projectCwd: string,
  ) {
    const images: string[] = [];
    const root = yield* fileSystem
      .realPath(projectCwd)
      .pipe(Effect.orElseSucceed(() => projectCwd));
    const walked = new Set<string>([root]);
    let level: string[] = [""];
    let visited = 0;
    for (let depth = 0; depth <= ICON_SCAN_MAX_DEPTH && level.length > 0; depth += 1) {
      const directories = level.slice(0, Math.max(0, ICON_SCAN_MAX_DIRECTORIES - visited));
      visited += directories.length;
      const listings = yield* Effect.forEach(
        directories,
        (relativeDirectory) =>
          fileSystem.readDirectory(path.join(projectCwd, relativeDirectory)).pipe(
            Effect.map((names) => ({ relativeDirectory, names })),
            Effect.orElseSucceed(() => ({ relativeDirectory, names: [] as string[] })),
          ),
        { concurrency: 8 },
      );
      const next: string[] = [];
      const maybeDirectories: string[] = [];
      for (const { relativeDirectory, names } of listings) {
        for (const name of names) {
          const relativePath = relativeDirectory ? path.join(relativeDirectory, name) : name;
          if (ICON_SCAN_IMAGE_RE.test(name)) images.push(relativePath);
          else if ((!name.includes(".") || name === ".github") && !isSkippedIconDirectory(name)) {
            maybeDirectories.push(relativePath);
          }
        }
      }
      if (depth === ICON_SCAN_MAX_DEPTH) break;
      const kinds = yield* Effect.forEach(
        maybeDirectories,
        (relativePath) =>
          fileSystem.stat(path.join(projectCwd, relativePath)).pipe(
            Effect.flatMap((stats) =>
              stats.type === "Directory"
                ? fileSystem
                    .realPath(path.join(projectCwd, relativePath))
                    .pipe(Effect.map((real) => ({ relativePath, real })))
                : Effect.succeed(null),
            ),
            Effect.orElseSucceed(() => null),
          ),
        { concurrency: 16 },
      );
      for (const directory of kinds) {
        if (directory === null || walked.has(directory.real)) continue;
        if (!directory.real.startsWith(`${root}${path.sep}`)) continue;
        walked.add(directory.real);
        next.push(directory.relativePath);
      }
      level = next;
    }
    return images;
  });

  // The most logo-like images in the tree, existing and inside the workspace, best first.
  const findRankedIcons = Effect.fn("ProjectFaviconResolver.findRankedIcons")(function* (
    projectCwd: string,
    projectName: string | undefined,
  ): Effect.fn.Return<ReadonlyArray<string>, ProjectFaviconResolutionError> {
    const images = yield* scanImageFiles(projectCwd);
    const ranked = rankProjectIconPaths(
      images.map((image) => image.split(path.sep).join("/")),
      { projectName, limit: ICON_CANDIDATE_LIMIT },
    );
    const found: string[] = [];
    for (const relativePath of ranked) {
      const existing = yield* findExistingFile(projectCwd, [relativePath], "workspace");
      if (existing) found.push(path.relative(projectCwd, existing));
    }
    return found;
  });

  const resolvePathUncached = Effect.fn("ProjectFaviconResolver.resolvePathUncached")(function* (
    cwd: string,
    faviconPath?: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    const projectCwd = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "normalize-workspace",
            workspaceRoot: cwd,
            cause,
          }),
      ),
    );
    // A grouped project's saved path can be absent from one checkout. Use it
    // where it exists and retain automatic discovery for the other checkouts.
    if (faviconPath !== undefined) {
      const existing = yield* findExistingFile(projectCwd, [faviconPath], "filesystem");
      if (existing) {
        return existing;
      }
    }

    // A t3.json iconPath takes precedence over the well-known locations.
    const projectFile = yield* projectFileLoader.load(projectCwd);
    if (Option.isSome(projectFile) && projectFile.value.iconPath !== undefined) {
      const existing = yield* findExistingFile(
        projectCwd,
        [projectFile.value.iconPath],
        "workspace",
      );
      if (existing) {
        return existing;
      }
    }

    const wellKnown = yield* firstInOrder(FAVICON_CANDIDATES, (candidate) =>
      findExistingFile(projectCwd, [candidate], "workspace"),
    );
    if (wellKnown) {
      return wellKnown;
    }

    const linked = yield* firstInOrder(ICON_SOURCE_FILES, (sourceFile) =>
      findIconFromSource(projectCwd, sourceFile),
    );
    if (linked) {
      return linked;
    }

    // Projects that keep their mark elsewhere: what they declare, then the most logo-like image.
    const declared = yield* findDeclaredIcons(projectCwd);
    // The folder's name stands in for the project's, which an asset request does not carry.
    const ranked =
      declared.length > 0
        ? declared
        : yield* findRankedIcons(projectCwd, path.basename(projectCwd));
    const best = ranked[0];
    return best === undefined ? null : path.join(projectCwd, best);
  });

  const faviconCache = yield* Cache.makeWith<string, string | null, ProjectFaviconResolutionError>(
    (key) => {
      const { cwd, faviconPath } = parseFaviconCacheKey(key);
      return resolvePathUncached(cwd, faviconPath);
    },
    {
      capacity: FAVICON_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (value: string | null) =>
          value === null ? FAVICON_NEGATIVE_CACHE_TTL : FAVICON_POSITIVE_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolvePath: ProjectFaviconResolver["Service"]["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd, faviconPath) {
    const key = faviconCacheKey(cwd, faviconPath);
    const cached = yield* Cache.get(faviconCache, key);
    if (cached === null) {
      return null;
    }

    // A hit still confirms the file with one stat rather than the ~20 probes a
    // full walk costs, so a deleted icon falls back at once instead of after
    // the TTL.
    const stats = yield* optionOnNotFound(fileSystem.stat(cached)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "stat-candidate",
            workspaceRoot: cwd,
            absolutePath: cached,
            cause,
          }),
      ),
    );
    if (Option.isSome(stats) && stats.value.type === "File") {
      return cached;
    }

    yield* Cache.invalidate(faviconCache, key);
    return yield* Cache.get(faviconCache, key);
  });

  const listCandidates: ProjectFaviconResolver["Service"]["listCandidates"] = Effect.fn(
    "ProjectFaviconResolver.listCandidates",
  )(function* (cwd, projectName) {
    const projectCwd = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "normalize-workspace",
            workspaceRoot: cwd,
            cause,
          }),
      ),
    );
    const automatic = yield* resolvePath(projectCwd);
    const declared = yield* findDeclaredIcons(projectCwd);
    const ranked = yield* findRankedIcons(projectCwd, projectName ?? path.basename(projectCwd));
    // One tile per image: the automatic one first, then other sizes of it and of others drop.
    const candidates: string[] = [];
    const families = new Set<string>();
    for (const relativePath of [
      ...(automatic ? [path.relative(projectCwd, automatic)] : []),
      ...declared,
      ...ranked,
    ]) {
      const family = projectIconFamilyKey(relativePath);
      if (families.has(family)) continue;
      families.add(family);
      candidates.push(relativePath);
    }
    return candidates.slice(0, ICON_CANDIDATE_LIMIT);
  });

  return ProjectFaviconResolver.of({ resolvePath, listCandidates });
});

export const layer = Layer.effect(ProjectFaviconResolver, make);
