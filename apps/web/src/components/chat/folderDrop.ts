import type { EnvironmentId } from "@t3tools/contracts";

export function folderDropTarget(input: {
  localEnvironmentDisabled: boolean;
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
}): "local" | "remote" {
  if (
    input.localEnvironmentDisabled ||
    input.primaryEnvironmentId === null ||
    input.environmentId !== input.primaryEnvironmentId
  ) {
    return "remote";
  }
  return "local";
}

export function resolveDroppedFolderPath(
  folder: File,
  getPathForFile: ((file: File) => string) | undefined,
): string | null {
  const path = getPathForFile?.(folder);
  return typeof path === "string" && path.length > 0 ? path : null;
}

/**
 * ViewCode: on the local environment the agent reads the user's disk, so an attached file
 * goes in as a path chip instead of an upload and its size stops mattering (a whole movie
 * works). Images still upload so the model can see them, and a file without a disk path
 * (a paste, a remote environment) uploads as before.
 */
export function localFileAttachmentPath(input: {
  readonly file: File;
  readonly isImage: boolean;
  readonly target: "local" | "remote";
  readonly getPathForFile: ((file: File) => string) | undefined;
}): string | null {
  if (input.target !== "local" || input.isImage) return null;
  return resolveDroppedFolderPath(input.file, input.getPathForFile);
}
