// @effect-diagnostics nodeBuiltinImport:off
/**
 * ViewCode: the machine-wide policy IT deploys. It wins over the user: what it
 * blocks stays off whatever settings.json, a project or the environment says,
 * and is never run.
 *
 * ```json
 * { "providers": { "codex": { "allowed": false } }, "tailscale": { "allowed": false } }
 * ```
 *
 * macOS reads the MDM managed preferences for the app's bundle id (the same
 * keys, as a binary or XML plist, read in-process so nothing is spawned);
 * Linux and Windows read a JSON file. Each process reads it once, on first use.
 */
import * as NodeFS from "node:fs";

import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

import * as HostProcess from "./HostProcess.ts";

const VIEWCODE_BUNDLE_ID = "dev.viewcode.app";

/** Where IT deploys the policy on each platform. */
export function adminPolicyPath(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return `/Library/Managed Preferences/${VIEWCODE_BUNDLE_ID}.plist`;
    case "win32":
      return "C:\\ProgramData\\ViewCode\\policy.json";
    default:
      return "/etc/viewcode/policy.json";
  }
}

export interface AdminPolicy {
  /** Provider drivers with `providers.<driver>.allowed: false`. */
  readonly blockedDrivers: ReadonlyArray<string>;
  /** `tailscale.allowed: false`: ViewCode never runs the `tailscale` CLI. */
  readonly tailscaleBlocked: boolean;
  /** Why a policy file that exists could not be applied, for the log. */
  readonly problem: string | null;
}

const NO_ADMIN_POLICY: AdminPolicy = {
  blockedDrivers: [],
  tailscaleBlocked: false,
  problem: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDisallowed = (rule: unknown) => isRecord(rule) && rule.allowed === false;

/** What a decoded policy blocks. Anything it does not understand blocks nothing. */
function adminPolicyFromValue(value: unknown): AdminPolicy {
  if (!isRecord(value)) return NO_ADMIN_POLICY;
  const providers = isRecord(value.providers) ? value.providers : {};
  return {
    blockedDrivers: Object.keys(providers).filter((driver) => isDisallowed(providers[driver])),
    tailscaleBlocked: isDisallowed(value.tailscale),
    problem: null,
  };
}

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

/** Reads the policy at `filePath`; a missing file means no policy. */
export function readAdminPolicyFile(filePath: string): AdminPolicy {
  if (!NodeFS.existsSync(filePath)) return NO_ADMIN_POLICY;
  try {
    const bytes = NodeFS.readFileSync(filePath);
    const value = filePath.endsWith(".plist") ? decodePlist(bytes) : decodeJson(bytes.toString());
    return adminPolicyFromValue(value);
  } catch (cause) {
    return {
      ...NO_ADMIN_POLICY,
      problem: `Could not read the ViewCode admin policy at ${filePath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
}

/** This machine's policy, read once on first use; tests provide their own. */
export const AdminPolicyRef = Context.Reference<AdminPolicy>(
  "@t3tools/shared/viewcodeAdminPolicy",
  {
    defaultValue: () => readAdminPolicyFile(adminPolicyPath(HostProcess.Platform.defaultValue())),
  },
);

/** A plist as plain values: dicts, arrays, strings, numbers and booleans. */
function decodePlist(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes.subarray(0, 8));
  if (text === "bplist00") return decodeBinaryPlist(bytes);
  return decodeXmlPlist(new TextDecoder().decode(bytes));
}

const MAX_PLIST_DEPTH = 32;

// Format: https://opensource.apple.com/source/CF/CF-1153.18/CFBinaryPList.c
function decodeBinaryPlist(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 40) throw new Error("Truncated binary plist.");
  const trailer = bytes.length - 32;
  const offsetSize = view.getUint8(trailer + 6);
  const refSize = view.getUint8(trailer + 7);
  const objectCount = Number(view.getBigUint64(trailer + 8));
  const topObject = Number(view.getBigUint64(trailer + 16));
  const offsetTable = Number(view.getBigUint64(trailer + 24));
  const uint = (at: number, size: number) => {
    if (at + size > bytes.length) throw new Error("Binary plist reads past its end.");
    let result = 0;
    for (let index = 0; index < size; index++) result = result * 256 + view.getUint8(at + index);
    return result;
  };
  const read = (ref: number, depth: number): unknown => {
    if (ref >= objectCount || depth > MAX_PLIST_DEPTH) throw new Error("Malformed binary plist.");
    let at = uint(offsetTable + ref * offsetSize, offsetSize);
    const marker = uint(at++, 1);
    const kind = marker >> 4;
    let length = marker & 0x0f;
    if (kind === 0) {
      if (marker === 0x08) return false;
      if (marker === 0x09) return true;
      return null;
    }
    if (kind === 1) return uint(at, 1 << length);
    if (kind === 2) return length === 2 ? view.getFloat32(at) : view.getFloat64(at);
    if (length === 0x0f && kind !== 3) {
      const lengthSize = 1 << (uint(at, 1) & 0x0f);
      length = uint(at + 1, lengthSize);
      at += 1 + lengthSize;
    }
    if (at + length > bytes.length) throw new Error("Binary plist reads past its end.");
    switch (kind) {
      case 5:
        return Array.from(bytes.subarray(at, at + length), (byte) =>
          String.fromCharCode(byte),
        ).join("");
      case 6:
        return Array.from({ length }, (_, index) =>
          String.fromCharCode(uint(at + index * 2, 2)),
        ).join("");
      case 0xa:
        return Array.from({ length }, (_, index) =>
          read(uint(at + index * refSize, refSize), depth + 1),
        );
      case 0xd: {
        const dict: Record<string, unknown> = {};
        for (let index = 0; index < length; index++) {
          const key = read(uint(at + index * refSize, refSize), depth + 1);
          if (typeof key !== "string") throw new Error("Binary plist dict key is not a string.");
          dict[key] = read(uint(at + (length + index) * refSize, refSize), depth + 1);
        }
        return dict;
      }
      default:
        // Dates, data and UIDs carry no policy.
        return null;
    }
  };
  return read(topObject, 0);
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlPlist(text: string): unknown {
  const tokens = text
    .replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, "")
    .match(/<[^>]+>|[^<]+/g);
  if (tokens === null) throw new Error("Not a plist.");
  let index = 0;
  const nextTag = (): string => {
    while (index < tokens.length && !tokens[index]!.startsWith("<")) index++;
    const tag = tokens[index++];
    if (tag === undefined) throw new Error("Plist ends early.");
    return tag;
  };
  const textUntil = (close: string): string => {
    let value = "";
    while (index < tokens.length && tokens[index] !== close) value += tokens[index++];
    if (tokens[index++] !== close) throw new Error(`Plist is missing ${close}.`);
    return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!);
  };
  const readValue = (tag: string, depth: number): unknown => {
    if (depth > MAX_PLIST_DEPTH) throw new Error("Plist nests too deeply.");
    const name = /^<\s*([A-Za-z]+)/.exec(tag)?.[1];
    if (tag.endsWith("/>")) {
      if (name === "true") return true;
      if (name === "false") return false;
      return name === "dict" ? {} : name === "array" ? [] : "";
    }
    switch (name) {
      case "dict": {
        const dict: Record<string, unknown> = {};
        for (let next = nextTag(); next !== "</dict>"; next = nextTag()) {
          if (next !== "<key>") throw new Error("Plist dict entry has no key.");
          const key = textUntil("</key>");
          dict[key] = readValue(nextTag(), depth + 1);
        }
        return dict;
      }
      case "array": {
        const array: Array<unknown> = [];
        for (let next = nextTag(); next !== "</array>"; next = nextTag()) {
          array.push(readValue(next, depth + 1));
        }
        return array;
      }
      case "string":
        return textUntil("</string>");
      case "integer":
      case "real":
        return Number(textUntil(`</${name}>`));
      case "date":
      case "data":
        textUntil(`</${name}>`);
        return null;
      default:
        throw new Error(`Unexpected plist element ${tag}.`);
    }
  };
  const root = nextTag();
  if (!/^<plist[\s>]/.test(root)) throw new Error("Not a plist.");
  return readValue(nextTag(), 0);
}
