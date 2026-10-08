import type { ReactNode } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { cn } from "../../lib/cn";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/**
 * Home's outlined pill surface: round icon buttons and the environment pill in
 * the Android top bar, and the floating composer launcher. A card-colored fill
 * with a hairline border reads in both light and dark themes.
 */
export function HomePillSurface(props: {
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string;
  readonly onPress?: () => void;
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}) {
  const { themeVariables } = useAppearancePreferences();
  const { buttonSize } = useAndroidControlSizing();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      android_ripple={{ color: themeVariables["--color-row-hover"], foreground: true }}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center justify-center overflow-hidden rounded-full border border-border-subtle bg-card",
        props.className,
      )}
      style={[{ minWidth: buttonSize, height: buttonSize }, props.style]}
    >
      {props.children}
    </Pressable>
  );
}

export function HomePillIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly selected?: boolean;
}) {
  const { iconSize } = useAndroidControlSizing();
  return (
    <HomePillSurface
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      className={props.selected ? "border-foreground" : undefined}
    >
      <SymbolView
        name={props.icon}
        size={iconSize}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
    </HomePillSurface>
  );
}
