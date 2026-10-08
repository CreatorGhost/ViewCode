/** Resolves web references without inheriting the desktop renderer's custom app scheme. */
export function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) return src;
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  return `${protocol}${src}`;
}

/** Reads media only for an explicit save/copy action; remote hosts must allow browser CORS. */
async function readMediaBlob(src: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(src);
  } catch (cause) {
    throw new Error(
      "The file could not be fetched. The host may block browser access (CORS), or the connection may be unavailable.",
      { cause },
    );
  }
  if (!response.ok) throw new Error(`The file could not be fetched (HTTP ${response.status}).`);
  const blob = await response.blob();
  if (blob.type.split(";", 1)[0] === "text/html") {
    throw new Error("This link returned a web page instead of media. Open the original URL.");
  }
  return blob;
}

/** Downloads the original bytes with their original filename, without changing playback URLs. */
export async function downloadMedia(src: string, name: string): Promise<void> {
  downloadBlob(await readMediaBlob(src), name);
}

/** Saves bytes the page already holds under `name`. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

const MAX_PNG_PIXELS = 64_000_000;

/**
 * Converts browser-decodable images, including SVG, into the clipboard's
 * portable PNG format. `scale` rasterizes at a multiple of the natural size,
 * which keeps vector images crisp, within the same pixel budget.
 */
export async function readMediaPng(src: string, scale = 1): Promise<Blob> {
  const blob = await readMediaBlob(src);
  if (scale === 1 && blob.type.split(";", 1)[0] === "image/png") return blob;

  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    try {
      await image.decode();
    } catch (cause) {
      throw new Error(
        "The browser could not decode this image for copying. Try saving it instead.",
        {
          cause,
        },
      );
    }
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width <= 0 || height <= 0 || width * height > MAX_PNG_PIXELS) {
      throw new Error(
        "This image is too large or has no usable dimensions. Try saving it instead.",
      );
    }
    const factor = Math.min(scale, Math.sqrt(MAX_PNG_PIXELS / (width * height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * factor);
    canvas.height = Math.round(height * factor);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image copying is unavailable in this browser.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) =>
          png ? resolve(png) : reject(new Error("The image could not be converted to PNG.")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
