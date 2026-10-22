/**
 * ViewCode: `gh api` as the transport for a GitHub Enterprise host Node cannot reach.
 *
 * Before the v2 merge every GitHub read went through `gh`, which brings the machine's own TLS
 * trust store, proxy and VPN routing. Upstream's API clients take only a token from `gh` and call
 * the host from Node, which on a managed machine can fail where `gh` succeeds (a corporate root CA
 * Node does not trust, a proxy only the system knows). A request to a host other than github.com
 * that fails before any HTTP answer is therefore sent again through `gh api`, with the same token,
 * and the host is sent through `gh` from then on. github.com is always read directly.
 *
 * @module GitHubGhTransport
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

/** A first direct request that has not answered by then is taken as a proxy that drops it. */
const FIRST_CONTACT_TIMEOUT = Duration.seconds(10);
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
/** Hop-by-hop or encoding headers describe gh's own connection, not the body it prints. */
const DROPPED_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding"]);

/**
 * Wraps the HTTP client a GitHub transport sends with. The default sends every request directly,
 * which is what tests that build a transport by hand get.
 */
export const GitHubGhTransport = Context.Reference<{
  readonly wrap: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
}>("@t3tools/source-control-github/server/GitHubGhTransport", {
  defaultValue: () => ({ wrap: (client) => client }),
});

/**
 * The gh host and endpoint an API URL names, or null for github.com, which never falls back.
 * GitHub Enterprise Server serves its API under `/api/v3` and `/api/graphql`; GHE.com data
 * residency from `api.<tenant>.ghe.com`.
 */
function ghEndpointOf(
  url: URL,
): { readonly host: string; readonly endpoint: string } | null {
  const host = url.host.toLowerCase();
  if (host === "api.github.com" || host === "github.com") return null;
  const tenant = host.startsWith("api.") && host.endsWith(".ghe.com") ? host.slice(4) : null;
  const path =
    tenant !== null
      ? url.pathname
      : url.pathname.startsWith("/api/v3/")
        ? url.pathname.slice("/api/v3".length)
        : url.pathname === "/api/graphql"
          ? "/graphql"
          : null;
  if (path === null) return null;
  const endpoint = path.replace(/^\/+/, "");
  return {
    host: tenant ?? host,
    endpoint: endpoint === "graphql" ? endpoint : endpoint + url.search,
  };
}

/** Whether a client failure happened before any HTTP answer: connection, DNS, TLS, proxy. */
function isTransportFailure(error: HttpClientError.HttpClientError): boolean {
  return error.reason._tag === "TransportError" && error.response === undefined;
}

/** `gh api -i` output: the status line, headers, a blank line, then the body. */
function parseGhApiOutput(
  stdout: string,
): { readonly status: number; readonly headers: Headers; readonly body: string } | null {
  const status = /^HTTP\/[\d.]+\s+(\d{3})/.exec(stdout);
  if (status === null) return null;
  const split = /\r?\n\r?\n/.exec(stdout);
  const head = split === null ? stdout : stdout.slice(0, split.index);
  const body = split === null ? "" : stdout.slice(split.index + split[0].length);
  const headers = new Headers();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (DROPPED_HEADERS.has(name)) continue;
    try {
      headers.append(name, line.slice(colon + 1).trim());
    } catch {
      // A header the Fetch API refuses is not one a GitHub caller reads.
    }
  }
  return { status: Number(status[1]), headers, body };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const cwd = yield* HostProcess.WorkingDirectory;
  /** Hosts Node could not reach, read through gh for the life of the server. */
  const throughGh = new Set<string>();
  /** Hosts Node has reached, whose slow answers are only slow. */
  const reachedDirectly = new Set<string>();

  const viaGh = (
    request: Parameters<HttpClient.HttpClient["execute"]>[0],
    target: { readonly host: string; readonly endpoint: string },
    direct: HttpClientError.HttpClientError | null,
  ) =>
    Effect.gen(function* () {
      const body = request.body;
      const stdin =
        body._tag === "Uint8Array"
          ? new TextDecoder().decode(body.body)
          : body._tag === "Raw" && typeof body.body === "string"
            ? body.body
            : body._tag === "Empty"
              ? undefined
              : null;
      const failed = (description: string) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            ...(direct === null ? {} : { cause: direct.reason.cause }),
            description,
          }),
        });
      if (stdin === null) return yield* failed("the request body cannot be sent through gh");
      const token = /^Bearer\s+(.+)$/i.exec(request.headers["authorization"] ?? "")?.[1];
      const headerArgs = [
        ...Object.entries(request.headers).flatMap(([name, value]) =>
          name === "authorization" || name === "user-agent" ? [] : ["-H", `${name}: ${value}`],
        ),
        ...(body._tag === "Uint8Array" || body._tag === "Raw"
          ? ["-H", `content-type: ${body.contentType}`]
          : []),
      ];
      const output = yield* process
        .run({
          operation: "GitHubGhTransport.api",
          command: "gh",
          args: [
            "api",
            "--hostname",
            target.host,
            "-X",
            request.method,
            "-i",
            ...headerArgs,
            ...(stdin === undefined ? [] : ["--input", "-"]),
            target.endpoint,
          ],
          cwd,
          ...(stdin === undefined ? {} : { stdin }),
          // The request's own token, so a routed account stays the account; never in argv.
          env: {
            GH_DEBUG: "",
            GH_PROMPT_DISABLED: "1",
            ...(token === undefined ? {} : { GH_ENTERPRISE_TOKEN: token, GH_TOKEN: token }),
          },
          // gh exits 1 on an HTTP refusal and still prints it, which the caller reads as one.
          allowNonZeroExit: true,
          timeoutMs: 60_000,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        })
        .pipe(
          Effect.mapError((error) =>
            failed(`gh could not be run either (${error._tag.replace(/Error$/, "")})`),
          ),
        );
      const parsed = parseGhApiOutput(output.stdout);
      if (parsed === null) {
        const reason = output.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";
        return yield* failed(
          reason.length === 0 ? "gh did not reach the host either" : `gh: ${reason}`,
        );
      }
      throughGh.add(target.host);
      const empty = [101, 204, 205, 304].includes(parsed.status);
      return HttpClientResponse.fromWeb(
        request,
        new Response(empty || parsed.body === "" ? null : parsed.body, {
          status: parsed.status,
          headers: parsed.headers,
        }),
      );
    });

  const wrap = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.transform(client, (effect, request) => {
      const target = ghEndpointOf(new URL(request.url));
      if (target === null) return effect;
      if (throughGh.has(target.host)) return viaGh(request, target, null);
      const firstContact = !reachedDirectly.has(target.host);
      return (
        firstContact
          ? effect.pipe(
              Effect.timeoutOrElse({
                duration: FIRST_CONTACT_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new HttpClientError.HttpClientError({
                      reason: new HttpClientError.TransportError({
                        request,
                        description: "the host did not answer",
                      }),
                    }),
                  ),
              }),
            )
          : effect
      ).pipe(
        Effect.tap(() => Effect.sync(() => reachedDirectly.add(target.host))),
        Effect.catchIf(
          (error): error is HttpClientError.HttpClientError =>
            HttpClientError.isHttpClientError(error) && isTransportFailure(error),
          (error) => viaGh(request, target, error),
        ),
      );
    });

  return { wrap };
});

export const layer = Layer.effect(GitHubGhTransport, make);
