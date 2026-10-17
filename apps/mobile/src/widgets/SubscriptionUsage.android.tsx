import {
  Box,
  Button,
  Column,
  Image,
  LinearProgressIndicator,
  Row,
  Spacer,
  Text,
} from "@expo/ui/jetpack-compose";
import {
  background,
  cornerRadius,
  fillMaxSize,
  fillMaxWidth,
  height,
  padding,
  paddingAll,
  size,
} from "@expo/ui/jetpack-compose/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { SubscriptionUsageSnapshot as SubscriptionUsageProps } from "./subscriptionUsageSnapshot";

export function SubscriptionUsage(props: SubscriptionUsageProps, environment: WidgetEnvironment) {
  "widget";
  // The widget runtime evaluates this function without the app's module scope.
  // Android has no timeline: the refill alarm and each publish re-render it,
  // and a reading stays on screen until the app publishes a newer one.
  const now = Date.now();
  const dark = environment.colorScheme === "dark";
  const palette = dark
    ? {
        bg: "#141416",
        tile: "#1F1F23",
        text: "#F5F5F7",
        muted: "#9B9BA3",
        track: "#34343A",
        low: "#FF6B6B",
      }
    : {
        bg: "#FFFFFF",
        tile: "#F2F2F5",
        text: "#16161A",
        muted: "#6E6E78",
        track: "#DEDEE4",
        low: "#E5484D",
      };
  // Bar colours follow the Usage screen's chart; drivers it does not chart use the brand teal.
  const accents: Record<string, string> = {
    claudeAgent: "#D97757",
    codex: dark ? "#E6E6E6" : "#3C3C43",
    grok: dark ? "#A1A1AA" : "#52525B",
    cursor: "#8B8B8B",
    opencode: "#5B9BBD",
    antigravity: "#8C7BD1",
  };
  // Drivers with a `usage_widget_logo_<driver>` drawable in modules/t3-widget-expiry.
  const logos = new Set([
    "codex",
    "claudeAgent",
    "cursor",
    "grok",
    "opencode",
    "antigravity",
    "commandCode",
    "droid",
    "devin",
    "pi",
  ]);

  const day = (ms: number) => {
    const date = new Date(ms);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };
  // Today shows the time, the coming week the weekday, anything else the date.
  const when = (ms: number) => {
    const date = new Date(ms);
    const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const days = Math.round((day(ms) - day(now)) / 86_400_000);
    if (days === 0) return time;
    if (days > 0 && days < 7)
      return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const providers = (props.providers ?? []).map((provider) => {
    // A window whose refill has passed is full again, whatever it read before.
    const windows = provider.windows.map((window) => {
      const refilled = window.resetAt > 0 && now >= window.resetAt;
      return {
        ...window,
        remaining: refilled ? 100 : window.remaining,
        reset: refilled ? "reset" : window.resetAt > 0 ? `resets ${when(window.resetAt)}` : "",
      };
    });
    const tightest = windows.reduce<(typeof windows)[number] | undefined>(
      (result, window) => (!result || window.remaining < result.remaining ? window : result),
      undefined,
    );
    return { ...provider, windows, tightest };
  });

  // Fit the list to the widget: two limits per provider, then one, then a
  // single bar each, then as many providers as fit. Heights are in dp.
  const widgetWidth = environment.widgetSize?.width ?? 300;
  const widgetHeight = environment.widgetSize?.height ?? 250;
  const narrow = widgetWidth < 200;
  const space = widgetHeight - 28 - 32;
  const gap = 8;
  const fits = (heights: number[]) =>
    heights.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, heights.length - 1) <= space;
  const tileHeight = (windows: number) => 44 + 34 * windows;
  const perProvider = [2, 1].find((limit) =>
    fits(providers.map((provider) => tileHeight(Math.min(provider.windows.length, limit)))),
  );
  const compactHeight = 52;
  const shownCount =
    perProvider !== undefined
      ? providers.length
      : Math.max(1, Math.floor((space + gap) / (compactHeight + gap)));
  const shown = providers.slice(0, shownCount);
  const hidden = providers.length - shown.length;

  // One limit shows the tightest; more show session and weekly first, then
  // the rest, kept in the snapshot's order.
  const pick = (provider: (typeof providers)[number], limit: number) => {
    const preferred =
      limit === 1
        ? [provider.tightest]
        : [
            provider.windows.find((window) => window.kind === "session"),
            provider.windows.find((window) => window.kind === "weekly"),
            ...provider.windows,
          ];
    const chosen = new Set(preferred.filter((window) => window !== undefined).slice(0, limit));
    return provider.windows.filter((window) => chosen.has(window));
  };

  const percent = (remaining: number, fontSize: number) => (
    <Text
      color={remaining <= 10 ? palette.low : palette.text}
      maxLines={1}
      style={{ fontSize, fontWeight: "bold", textAlign: "end" }}
      modifiers={[fillMaxWidth()]}
    >
      {`${remaining}%`}
    </Text>
  );
  const bar = (remaining: number, driver: string) => (
    <LinearProgressIndicator
      progress={remaining / 100}
      color={remaining <= 10 ? palette.low : (accents[driver] ?? "#00BFC9")}
      trackColor={palette.track}
      modifiers={[fillMaxWidth(), height(6), cornerRadius(3)]}
    />
  );

  return (
    // The card is one Button. Our expo-widgets patch opens a URI `target` in
    // the app directly, so a tap reaches Usage → Limits even while the app is
    // closed; before the first publish there is no link and it opens the app.
    <Button
      {...{ target: props.url ?? "launch:" }}
      colors={{ containerColor: palette.bg }}
      modifiers={[fillMaxSize(), cornerRadius(24)]}
    >
      <Column modifiers={[fillMaxSize(), paddingAll(14)]}>
        <Box contentAlignment="centerStart" modifiers={[fillMaxWidth(), height(22)]}>
          <Row verticalAlignment="center">
            <Image
              source={{ uri: "usage_widget_mark" }}
              contentDescription={null}
              modifiers={[size(28, 18)]}
            />
            <Text
              color={palette.text}
              maxLines={1}
              style={{ fontSize: 15, fontWeight: "bold" }}
              modifiers={[padding(6, 0, 0, 0)]}
            >
              Usage
            </Text>
          </Row>
          <Text
            color={palette.muted}
            maxLines={1}
            style={{ fontSize: 11, textAlign: "end" }}
            modifiers={[fillMaxWidth()]}
          >
            {[hidden > 0 ? `+${hidden} more` : "", props.checkedAt ? when(props.checkedAt) : ""]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </Box>
        <Spacer modifiers={[height(10)]} />
        {shown.length === 0 ? (
          <Text color={palette.muted} style={{ fontSize: 12 }}>
            {props.providers
              ? "No subscription limits to show yet."
              : "Open ViewCode to load your limits."}
          </Text>
        ) : null}
        {shown.map((provider, index) => {
          const windows = perProvider === undefined ? [] : pick(provider, perProvider);
          const compact = perProvider === undefined && provider.tightest !== undefined;
          return (
            <Column key={provider.driver} modifiers={[fillMaxWidth()]}>
              {index > 0 ? <Spacer modifiers={[height(gap)]} /> : null}
              <Column
                modifiers={[
                  fillMaxWidth(),
                  background(palette.tile),
                  cornerRadius(18),
                  paddingAll(compact ? 10 : 12),
                ]}
              >
                <Box contentAlignment="centerStart" modifiers={[fillMaxWidth(), height(20)]}>
                  <Row verticalAlignment="center" modifiers={[padding(0, 0, 56, 0)]}>
                    {logos.has(provider.driver) ? (
                      <Image
                        source={{ uri: `usage_widget_logo_${provider.driver.toLowerCase()}` }}
                        contentDescription={null}
                        modifiers={[size(18, 18)]}
                      />
                    ) : null}
                    <Text
                      color={palette.text}
                      maxLines={1}
                      style={{ fontSize: 14, fontWeight: "bold" }}
                      modifiers={[padding(logos.has(provider.driver) ? 8 : 0, 0, 0, 0)]}
                    >
                      {provider.name}
                    </Text>
                  </Row>
                  {compact && provider.tightest ? (
                    percent(provider.tightest.remaining, 14)
                  ) : (
                    <Text
                      color={palette.muted}
                      maxLines={1}
                      style={{ fontSize: 11, textAlign: "end" }}
                      modifiers={[fillMaxWidth()]}
                    >
                      {provider.windows.length === 0
                        ? provider.detail || "No data yet"
                        : provider.detail}
                    </Text>
                  )}
                </Box>
                {compact && provider.tightest ? (
                  <Column modifiers={[fillMaxWidth(), padding(0, 6, 0, 0)]}>
                    {bar(provider.tightest.remaining, provider.driver)}
                  </Column>
                ) : null}
                {windows.map((window) => (
                  <Column key={window.label} modifiers={[fillMaxWidth(), padding(0, 8, 0, 0)]}>
                    <Box contentAlignment="centerStart" modifiers={[fillMaxWidth()]}>
                      <Text
                        color={palette.muted}
                        maxLines={1}
                        style={{ fontSize: 11 }}
                        modifiers={[padding(0, 0, 44, 0)]}
                      >
                        {narrow || !window.reset
                          ? window.label
                          : `${window.label} · ${window.reset}`}
                      </Text>
                      {percent(window.remaining, 12)}
                    </Box>
                    <Column modifiers={[fillMaxWidth(), padding(0, 4, 0, 0)]}>
                      {bar(window.remaining, provider.driver)}
                    </Column>
                  </Column>
                ))}
              </Column>
            </Column>
          );
        })}
      </Column>
    </Button>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);
