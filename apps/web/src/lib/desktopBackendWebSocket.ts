import {
  isDesktopLocalBackendUrl,
  type DesktopBridge,
  type DesktopLocalBackendSocket,
} from "@t3tools/contracts";

type OpenLocalBackendSocket = NonNullable<DesktopBridge["openLocalBackendSocket"]>;

const CONNECTING = 0 as const;
const OPEN = 1 as const;
const CLOSING = 2 as const;
const CLOSED = 3 as const;

/**
 * A WebSocket to a desktop-local backend that listens on a Unix socket or
 * named pipe. Chromium cannot dial those, so frames travel through the desktop
 * main process (`DesktopBridge.openLocalBackendSocket`), which holds the real
 * connection. Implements the WebSocket surface the client uses: events,
 * `on*` handlers, `send`, `close`, `readyState`, and `binaryType`.
 */
export class DesktopBackendWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  readonly url: string;
  readyState: WebSocket["readyState"] = CONNECTING;
  protocol = "";
  extensions = "";
  binaryType: BinaryType = "blob";
  readonly bufferedAmount = 0;

  onopen: ((this: WebSocket, event: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, event: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null;

  readonly #tunnel: DesktopLocalBackendSocket;
  #sendQueue: Promise<void> = Promise.resolve();
  #pendingBlobs = 0;

  constructor(url: string, protocols: string | string[] | undefined, open: OpenLocalBackendSocket) {
    super();
    this.url = url;
    const protocolList =
      protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : protocols;
    this.#tunnel = open(url, protocolList, {
      onOpen: ({ protocol, extensions }) => {
        if (this.readyState !== CONNECTING) return;
        this.readyState = OPEN;
        this.protocol = protocol;
        this.extensions = extensions;
        this.#emit("open", new Event("open"));
      },
      onMessage: (data) => {
        if (this.readyState !== OPEN) return;
        const payload =
          typeof data === "string" || this.binaryType === "arraybuffer" ? data : new Blob([data]);
        this.#emit("message", new MessageEvent("message", { data: payload }));
      },
      onError: () => {
        this.#emit("error", new Event("error"));
      },
      onClose: ({ code, reason, wasClean }) => {
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        this.#emit("close", new CloseEvent("close", { code, reason, wasClean }));
      },
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState === CONNECTING) {
      throw new DOMException("WebSocket is still in CONNECTING state.", "InvalidStateError");
    }
    if (this.readyState !== OPEN) return;
    if (data instanceof Blob) {
      // Blobs read asynchronously; later frames and close wait so order is kept.
      this.#pendingBlobs += 1;
      this.#sendQueue = this.#sendQueue.then(async () => {
        this.#tunnel.send(await data.arrayBuffer());
        this.#pendingBlobs -= 1;
      });
      return;
    }
    const frame =
      typeof data === "string" || ArrayBuffer.isView(data) ? data : new Uint8Array(data).slice();
    this.#afterPendingBlobs(() => this.#tunnel.send(frame));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    this.#afterPendingBlobs(() => this.#tunnel.close(code, reason));
  }

  #afterPendingBlobs(run: () => void): void {
    if (this.#pendingBlobs === 0) run();
    else this.#sendQueue = this.#sendQueue.then(run);
  }

  #emit(type: "open" | "message" | "error" | "close", event: Event): void {
    const handler = this[`on${type}`] as ((this: WebSocket, event: Event) => unknown) | null;
    handler?.call(this, event);
    this.dispatchEvent(event);
  }
}

/**
 * Routes `t3code-backend:` WebSocket URLs through the desktop bridge. Every
 * other URL still gets the native WebSocket, so remote environments are
 * untouched. No-op outside the desktop app or when the bridge lacks support.
 */
export function installDesktopBackendWebSocket(
  target: { WebSocket: typeof WebSocket; desktopBridge?: DesktopBridge } = window,
): void {
  const open = target.desktopBridge?.openLocalBackendSocket;
  if (open === undefined) return;
  const NativeWebSocket = target.WebSocket;
  if ((NativeWebSocket as { readonly __t3DesktopBackend?: true }).__t3DesktopBackend) return;
  target.WebSocket = new Proxy(NativeWebSocket, {
    construct(nativeTarget, args: [string | URL, (string | string[])?], newTarget) {
      const [url, protocols] = args;
      if (isDesktopLocalBackendUrl(url)) {
        return new DesktopBackendWebSocket(String(url), protocols, open);
      }
      return Reflect.construct(nativeTarget, args, newTarget);
    },
    get(nativeTarget, property, receiver) {
      if (property === "__t3DesktopBackend") return true;
      return Reflect.get(nativeTarget, property, receiver);
    },
  });
}
