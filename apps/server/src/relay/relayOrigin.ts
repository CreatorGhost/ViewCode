/** A Quick connect address is a credential-free HTTPS origin. */
export function normalizeRelayOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
