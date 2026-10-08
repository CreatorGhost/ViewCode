import { Pressable, type StyleProp, View, type ViewStyle } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** Unscaled list clearance under the launcher: its height plus the gaps around it. */
export const HOME_COMPOSER_CLEARANCE = 96;

/**
 * Android Home's floating "start a thread" bar. It only launches the new-task
 * flow (the draft screen owns the real composer), so it never holds text.
 * The mic shows only where this device can dictate.
 */
export function HomeComposerLauncher(props: {
  readonly onStartNewTask: () => void;
  readonly onStartVoiceTask?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const { themeVariables } = useAppearancePreferences();
  const { scale, buttonSize, iconSize } = useAndroidControlSizing();
  const height = Math.round(60 * scale);
  const ripple = { color: themeVariables["--color-row-hover"], borderless: true };
  return (
    <View
      className="absolute inset-x-4 flex-row items-center rounded-full border border-border-subtle bg-card"
      style={[
        {
          height,
          paddingHorizontal: (height - buttonSize) / 2,
          gap: 8 * scale,
          elevation: 6,
          shadowColor: "#000000",
          shadowOpacity: 0.12,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
        },
        props.style,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New thread"
        android_ripple={ripple}
        onPress={props.onStartNewTask}
        className="items-center justify-center rounded-full bg-row-hover"
        style={{ width: buttonSize, height: buttonSize }}
      >
        <SymbolView
          name="plus"
          size={iconSize}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Start a new thread"
        onPress={props.onStartNewTask}
        className="min-w-0 flex-1 justify-center self-stretch"
      >
        <Text className="text-foreground-muted" style={{ fontSize: 16 * scale }} numberOfLines={1}>
          Start a new thread…
        </Text>
      </Pressable>
      {props.onStartVoiceTask ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a new thread by voice"
          android_ripple={ripple}
          onPress={props.onStartVoiceTask}
          className="items-center justify-center rounded-full bg-row-hover"
          style={{ width: buttonSize, height: buttonSize }}
        >
          <SymbolView
            name="mic"
            size={iconSize}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
        </Pressable>
      ) : null}
    </View>
  );
}
