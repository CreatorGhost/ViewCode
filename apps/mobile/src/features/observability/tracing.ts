import Constants from "expo-constants";
import { makeRelayClientTracingLayer } from "@t3tools/shared/relayTracing";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly appVariant: string;
}

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Traces export only when `extra.observability` carries a URL, dataset and token. */
export function resolveTracingConfig(
  extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra,
): TracingConfig | null {
  const observability = extra?.observability as Record<string, unknown> | undefined;
  const tracesUrl = normalizeSecureUrl(observability?.tracesUrl);
  const tracesDataset = trimNonEmpty(observability?.tracesDataset);
  const tracesToken = trimNonEmpty(observability?.tracesToken);
  return tracesUrl && tracesDataset && tracesToken
    ? { tracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeTracingLayer(config: TracingConfig | null, resource: TracingResource) {
  return makeRelayClientTracingLayer(config, {
    serviceName: "t3code-mobile",
    serviceVersion: resource.serviceVersion,
    runtime: "react-native",
    client: `mobile-${resource.appVariant}`,
  });
}

export const tracingLayer = makeTracingLayer(resolveTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});
