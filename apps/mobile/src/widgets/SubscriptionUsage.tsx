import { HStack, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityLabel,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  progressViewStyle,
  tint,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { SubscriptionUsageSnapshot as SubscriptionUsageProps } from "./subscriptionUsageSnapshot";

type UsageConfiguration = {
  codexPeriod?: "auto" | "session" | "weekly";
  claudePeriod?: "auto" | "session" | "weekly";
};

function SubscriptionUsage(
  props: SubscriptionUsageProps,
  environment: WidgetEnvironment<UsageConfiguration>,
) {
  "widget";
  // The extension evaluates this function without the app's module scope.
  const family = environment.widgetFamily;
  // Gallery snapshots can render an old timeline entry after it has expired.
  const now = Math.max(environment.date?.getTime() ?? 0, Date.now());
  const accessory = family === "accessoryRectangular";
  const compact =
    family === "systemSmall" || accessory || environment.levelOfDetail === "simplified";
  // Budget short cards for two quotas per provider, including their secondary text.
  const dense = family === "systemSmall" || family === "systemMedium";
  const familyLimit = family === "systemExtraLarge" ? 6 : family === "systemLarge" ? 4 : 2;
  const monochrome =
    environment.widgetRenderingMode !== "fullColor" || environment.isLuminanceReduced;
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
  // Codex and Claude lead the snapshot; wider families make room for more.
  const allProviders = props.providers ?? [];
  const providers = allProviders.slice(
    0,
    family === "systemExtraLarge" ? 4 : family === "systemLarge" ? 3 : 2,
  );
  // More than two providers stack as rows rather than squeezing into columns.
  const stacked = compact || providers.length > 2;
  const limit = stacked && !compact ? 2 : familyLimit;
  const columns = providers.map((provider) => {
    const period =
      provider.driver === "claudeAgent"
        ? (environment.configuration?.claudePeriod ?? "auto")
        : provider.driver === "codex"
          ? (environment.configuration?.codexPeriod ?? "auto")
          : "auto";
    // A reading stays until the app publishes a newer one; a window whose
    // refill has passed is full again, whatever it read before.
    const windows = provider.windows
      .filter((window) => period === "auto" || window.kind === period)
      .map((window) => {
        const refilled = window.resetAt > 0 && now >= window.resetAt;
        return {
          ...window,
          remaining: refilled ? 100 : window.remaining,
          reset: refilled
            ? "Reset"
            : window.resetAt > 0
              ? `Resets ${when(window.resetAt)}`
              : "Reset time unavailable",
        };
      });
    // Lock Screen widgets surface the tightest selected limit.
    const tightest = windows.reduce<(typeof windows)[number] | undefined>(
      (result, window) => (!result || window.remaining < result.remaining ? window : result),
      undefined,
    );
    const compactWindows = [
      windows.find((window) => window.kind === "session"),
      windows.find((window) => window.kind === "weekly"),
    ].filter((window) => window !== undefined);
    const shown =
      accessory || environment.levelOfDetail === "simplified"
        ? tightest
          ? [tightest]
          : []
        : family === "systemSmall" && compactWindows.length > 0
          ? compactWindows
          : period === "auto" && compactWindows.length > 0
            ? [
                ...compactWindows,
                ...windows.filter((window) => !compactWindows.includes(window)),
              ].slice(0, limit)
            : windows.slice(0, limit);
    const detail =
      period !== "auto" && windows.length === 0 && provider.windows.length > 0
        ? `No ${period} limit reported`
        : provider.detail;
    const barModifiers = [
      progressViewStyle("linear"),
      frame({ height: 4 }),
      ...(monochrome ? [] : [tint(provider.driver === "claudeAgent" ? "#d97757" : "#8e8e93")]),
    ];
    if (accessory) {
      return (
        <VStack
          key={provider.name}
          alignment="leading"
          spacing={2}
          modifiers={[
            accessibilityElement("ignore"),
            accessibilityLabel(
              tightest
                ? `${provider.name}, ${tightest.label}, ${tightest.remaining} percent remaining. ${tightest.reset}. ${provider.detail}.`
                : `${provider.name}. ${detail}.`,
            ),
          ]}
        >
          <HStack spacing={4}>
            <Text
              modifiers={[
                font({ textStyle: "caption", weight: "semibold" }),
                lineLimit(1),
                foregroundStyle("primary"),
              ]}
            >
              {provider.name}
              {tightest ? ` · ${tightest.label}` : ""}
            </Text>
            <Spacer />
            <Text
              modifiers={[
                font({ textStyle: "caption", weight: "semibold" }),
                lineLimit(1),
                layoutPriority(1),
                foregroundStyle("primary"),
              ]}
            >
              {tightest
                ? `${tightest.remaining}% left`
                : period !== "auto" && provider.windows.length > 0
                  ? "N/A"
                  : "No data"}
            </Text>
          </HStack>
          {tightest ? (
            <ProgressView value={tightest.remaining / 100} modifiers={barModifiers} />
          ) : null}
        </VStack>
      );
    }
    return (
      <VStack
        key={provider.name}
        alignment="leading"
        spacing={dense ? 1 : compact ? 2 : 4}
        modifiers={[
          frame({ maxWidth: Infinity, alignment: "leading" }),
          fixedSize({ horizontal: false, vertical: true }),
        ]}
      >
        <Text
          modifiers={[
            font({ textStyle: compact ? "caption" : "headline", weight: "bold" }),
            lineLimit(1),
            foregroundStyle("primary"),
          ]}
        >
          {provider.name}
        </Text>
        {!compact || shown.length === 0 ? (
          <Text
            modifiers={[
              font({ textStyle: "caption2" }),
              foregroundStyle("secondary"),
              lineLimit(1),
            ]}
          >
            {detail || " "}
          </Text>
        ) : null}
        {shown.map((window) => (
          <VStack
            key={window.label}
            alignment="leading"
            spacing={dense ? 1 : 2}
            modifiers={[
              accessibilityElement("ignore"),
              accessibilityLabel(
                `${provider.name}, ${window.label}, ${window.remaining} percent remaining. ${window.reset}. ${provider.detail}.`,
              ),
            ]}
          >
            <HStack spacing={4}>
              <Text
                modifiers={[
                  font({ textStyle: compact || dense ? "caption2" : "caption" }),
                  foregroundStyle("secondary"),
                  lineLimit(1),
                ]}
              >
                {window.label}
              </Text>
              <Spacer />
              <Text
                modifiers={[
                  font({
                    textStyle: compact || dense ? "caption2" : "caption",
                    weight: "semibold",
                  }),
                  lineLimit(1),
                  layoutPriority(1),
                  foregroundStyle(
                    window.remaining <= 10 && !monochrome
                      ? environment.colorScheme === "light"
                        ? "#dc2626"
                        : "#fca5a5"
                      : "primary",
                  ),
                ]}
              >
                {window.remaining}% left
              </Text>
            </HStack>
            <ProgressView value={window.remaining / 100} modifiers={barModifiers} />
            {!compact ? (
              <Text modifiers={[font({ size: 10 }), foregroundStyle("secondary"), lineLimit(1)]}>
                {window.reset}
              </Text>
            ) : null}
          </VStack>
        ))}
        {!compact &&
        (period === "auto" ? (provider.totalWindows ?? windows.length) : windows.length) > limit ? (
          <Text
            modifiers={[
              font({ textStyle: "caption2" }),
              foregroundStyle("secondary"),
              lineLimit(1),
            ]}
          >
            {(period === "auto" ? (provider.totalWindows ?? windows.length) : windows.length) -
              limit}{" "}
            more in ViewCode
          </Text>
        ) : null}
      </VStack>
    );
  });
  return (
    <VStack
      alignment="leading"
      spacing={accessory || dense ? 2 : 6}
      modifiers={props.url ? [widgetURL(props.url)] : []}
    >
      {providers.length === 0 ? (
        <Text modifiers={[font({ textStyle: "caption" }), foregroundStyle("secondary")]}>
          {props.providers ? "No subscription limits to show yet." : "Open ViewCode to connect."}
        </Text>
      ) : stacked ? (
        <VStack alignment="leading" spacing={accessory || dense ? 4 : 8}>
          {columns}
        </VStack>
      ) : (
        <HStack alignment="top" spacing={16}>
          {columns}
        </HStack>
      )}
      {!accessory ? <Spacer /> : null}
      {!accessory ? (
        <Text
          modifiers={[font({ textStyle: "caption2" }), foregroundStyle("secondary"), lineLimit(1)]}
        >
          {[
            props.checkedAt ? `As of ${when(props.checkedAt)}` : "",
            allProviders.length > providers.length
              ? `${allProviders.length - providers.length} more in ViewCode`
              : "",
          ]
            .filter(Boolean)
            .join(" · ") || " "}
        </Text>
      ) : null}
    </VStack>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);
