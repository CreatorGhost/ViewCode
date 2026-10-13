import { memo, useCallback, useMemo } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../../../components/AppSymbol";
import { AppText as Text } from "../../../../components/AppText";
import { SegmentedControl } from "../../../../components/SegmentedControl";
import { cn } from "../../../../lib/cn";
import {
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemeAppearances,
  getMobileThemeCardColors,
  MOBILE_THEME_OPTIONS,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeMode,
} from "../../../../lib/mobileTheme";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

const APPEARANCE_MODES: ReadonlyArray<{
  readonly value: MobileThemeMode;
  readonly label: string;
}> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type ThemeCardColors = ReturnType<typeof getMobileThemeCardColors>;

/**
 * A card's picture of the app in its theme, as desktop draws it: the sidebar strip, two lines of
 * text and the accent, on the theme's own canvas. The palette's colours are the point, so they
 * are inline rather than tokens.
 */
function ThemeMiniPreview({ colors }: { readonly colors: ThemeCardColors }) {
  return (
    <View
      className="h-14 flex-row overflow-hidden rounded-[10px] border border-continuous"
      style={{ backgroundColor: colors.canvas, borderColor: "rgba(127, 127, 127, 0.16)" }}
    >
      <View className="w-[26%]" style={{ backgroundColor: colors.sidebar }} />
      <View className="min-w-0 flex-1 gap-1.5 p-2">
        <View
          className="h-1.5 w-4/5 rounded-full"
          style={{ backgroundColor: colors.text, opacity: 0.55 }}
        />
        <View
          className="h-1.5 w-1/2 rounded-full"
          style={{ backgroundColor: colors.text, opacity: 0.3 }}
        />
        <View
          className="mt-auto h-2 w-2/5 rounded-full"
          style={{ backgroundColor: colors.accent }}
        />
      </View>
    </View>
  );
}

/** Sun and moon on a two-appearance card: each gives the theme only that half of the pair. */
function ThemeModePicks(props: {
  readonly disabled: boolean;
  readonly label: string;
  readonly lightPicked: boolean;
  readonly darkPicked: boolean;
  readonly onPick: (appearance: MobileThemeAppearance) => void;
}) {
  return (
    // 32pt discs with 6pt of slop make 44pt targets; the 12pt gap keeps the two from overlapping.
    <View className="absolute bottom-1 right-1 flex-row gap-3">
      {(["light", "dark"] as const).map((appearance) => {
        const picked = appearance === "light" ? props.lightPicked : props.darkPicked;
        return (
          <Pressable
            accessibilityLabel={`Use ${props.label} for ${appearance} mode only`}
            accessibilityRole="button"
            accessibilityState={{ disabled: props.disabled, selected: picked }}
            className={cn(
              "size-8 items-center justify-center rounded-full",
              picked ? "bg-foreground" : "border border-border bg-card",
            )}
            disabled={props.disabled}
            hitSlop={6}
            key={appearance}
            onPress={() => props.onPick(appearance)}
          >
            <SymbolView
              name={appearance === "light" ? "sun.max" : "moon"}
              size={15}
              tintColorClassName={picked ? "accent-screen" : "accent-icon-muted"}
              type="monochrome"
              weight="medium"
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A one-appearance theme's mark: the moon (or sun) it is for, filled while the theme holds that
 * half. Tapping such a card in the other mode changes nothing on screen, so this is its feedback.
 */
function ThemeOnlyBadge(props: {
  readonly appearance: MobileThemeAppearance;
  readonly picked: boolean;
}) {
  return (
    <View
      className={cn(
        "absolute bottom-1 right-1 h-7 flex-row items-center gap-1 rounded-full px-2",
        props.picked ? "bg-foreground" : "border border-border bg-card",
      )}
      pointerEvents="none"
    >
      <SymbolView
        name={props.appearance === "light" ? "sun.max" : "moon"}
        size={12}
        tintColorClassName={props.picked ? "accent-screen" : "accent-icon-muted"}
        type="monochrome"
        weight="medium"
      />
      <Text
        className={cn(
          "text-2xs font-t3-medium",
          props.picked ? "text-screen" : "text-foreground-muted",
        )}
      >
        {props.appearance === "light" ? "Light only" : "Dark only"}
      </Text>
    </View>
  );
}

const ThemeCard = memo(function ThemeCard(props: {
  readonly appearance: MobileThemeAppearance;
  readonly disabled: boolean;
  readonly label: string;
  readonly lightPicked: boolean;
  readonly darkPicked: boolean;
  readonly materialYouColors: ThemeCardColors | null;
  readonly onPick: (themeId: MobileThemeId, appearance: MobileThemeAppearance) => void;
  readonly onSelect: (themeId: MobileThemeId) => void;
  readonly themeId: MobileThemeId;
}) {
  const appearances = getMobileThemeAppearances(props.themeId);
  // The card shows the appearance on screen when the theme has it.
  const previewAppearance = appearances.includes(props.appearance)
    ? props.appearance
    : appearances[0]!;
  const { materialYouColors, themeId } = props;
  const colors = useMemo(
    () =>
      themeId === "material-you" && materialYouColors
        ? materialYouColors
        : getMobileThemeCardColors(
            themeId === "material-you" ? DEFAULT_MOBILE_THEME_ID : themeId,
            previewAppearance,
          ),
    [materialYouColors, previewAppearance, themeId],
  );
  const showing = props.appearance === "light" ? props.lightPicked : props.darkPicked;
  const twoSided = appearances.length > 1;

  return (
    <Pressable
      // The sun and moon sit inside the card, where screen readers cannot reach them on their own.
      accessibilityActions={
        twoSided
          ? [
              { name: "light", label: "Use for light mode only" },
              { name: "dark", label: "Use for dark mode only" },
            ]
          : undefined
      }
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        if (name === "light" || name === "dark") props.onPick(themeId, name);
      }}
      accessibilityHint={
        appearances.length > 1
          ? "Uses this theme in light and dark mode"
          : `Uses this theme in ${appearances[0]} mode`
      }
      accessibilityLabel={`${props.label} theme`}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, selected: showing }}
      className="w-[48%] gap-2 rounded-[16px] border border-border border-continuous bg-grouped-card p-2 active:opacity-80"
      disabled={props.disabled}
      onPress={() => props.onSelect(themeId)}
    >
      {/* The theme on screen is ringed in its own accent, as its preview shows it. */}
      {showing ? (
        <View
          className="absolute -inset-px rounded-[16px] border-2 border-continuous"
          pointerEvents="none"
          style={{ borderColor: colors.accent }}
        />
      ) : null}
      <View>
        <ThemeMiniPreview colors={colors} />
        {twoSided ? (
          <ThemeModePicks
            darkPicked={props.darkPicked}
            disabled={props.disabled}
            label={props.label}
            lightPicked={props.lightPicked}
            onPick={(appearance) => props.onPick(themeId, appearance)}
          />
        ) : (
          <ThemeOnlyBadge
            appearance={appearances[0]!}
            picked={appearances[0] === "light" ? props.lightPicked : props.darkPicked}
          />
        )}
      </View>
      <View className="flex-row items-center gap-1.5 px-0.5 pb-0.5">
        <View className="size-2 rounded-full" style={{ backgroundColor: colors.accent }} />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground" numberOfLines={1}>
          {props.label}
        </Text>
      </View>
    </Pressable>
  );
});

function SectionHeading(props: { readonly title: string; readonly detail?: string }) {
  const android = Platform.OS === "android";
  return (
    <View className={cn("flex-row items-baseline gap-2", android ? "px-4" : "px-2")}>
      <Text
        className={cn(
          "text-sm font-t3-medium",
          android ? "text-primary-text" : "text-foreground-muted",
        )}
      >
        {props.title}
      </Text>
      {props.detail ? <Text className="text-xs text-foreground-muted">{props.detail}</Text> : null}
    </View>
  );
}

export function ThemeAppearanceSection() {
  const {
    isReady,
    selectTheme,
    setThemeIdForAppearance,
    setThemeMode,
    systemColorPalettes,
    systemColorsAvailable,
    themeAppearance,
    themeIds,
    themeMode,
  } = useAppearancePreferences();
  const options = MOBILE_THEME_OPTIONS.filter(
    (theme) => theme.id !== "material-you" || systemColorsAvailable,
  );
  const pickHalf = useCallback(
    (themeId: MobileThemeId, appearance: MobileThemeAppearance) =>
      setThemeIdForAppearance(appearance, themeId),
    [setThemeIdForAppearance],
  );
  const materialYouPalette = systemColorPalettes?.[themeAppearance];
  const materialYouColors = useMemo(
    () =>
      materialYouPalette
        ? {
            canvas: materialYouPalette.surface,
            sidebar: materialYouPalette.surfaceContainer,
            text: materialYouPalette.onSurface,
            accent: materialYouPalette.primary,
          }
        : null,
    [materialYouPalette],
  );

  return (
    <View className="gap-6">
      <SettingsSection>
        <View
          className={cn(
            "flex-row items-center gap-3 p-4 android:min-h-14 android:py-3",
            !isReady && "opacity-[0.45]",
          )}
          pointerEvents={isReady ? "auto" : "none"}
        >
          <Text className="min-w-0 flex-1 text-lg text-foreground android:text-base">Mode</Text>
          <SegmentedControl
            className="w-[210px]"
            onSelect={setThemeMode}
            options={APPEARANCE_MODES}
            selected={themeMode}
            size="compact"
          />
        </View>
      </SettingsSection>

      <View className="gap-3">
        <SectionHeading detail={`${options.length} themes`} title="Theme" />
        <View className="flex-row flex-wrap justify-between gap-y-3">
          {options.map((theme) => (
            <ThemeCard
              appearance={themeAppearance}
              darkPicked={theme.id === themeIds.dark}
              disabled={!isReady}
              key={theme.id}
              label={theme.label}
              lightPicked={theme.id === themeIds.light}
              materialYouColors={theme.id === "material-you" ? materialYouColors : null}
              onPick={pickHalf}
              onSelect={selectTheme}
              themeId={theme.id}
            />
          ))}
        </View>
      </View>
    </View>
  );
}
