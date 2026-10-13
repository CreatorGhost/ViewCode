import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { ComposerCheckout } from "./composerChrome";

/**
 * The strip glued under the thread composer, as on web: where the thread works on the
 * left, its branch on the right. The branch opens the thread's git controls when the
 * host offers them.
 */
export function ComposerCheckoutStrip(props: {
  readonly checkout: ComposerCheckout;
  readonly onPressBranch?: (() => void) | undefined;
}) {
  const { place, branch } = props.checkout;
  return (
    <View className="mx-5 h-[30px] flex-row items-center justify-between gap-3 rounded-b-[14px] border border-t-0 border-composer-border bg-screen px-3">
      <View className="min-w-0 shrink flex-row items-center gap-1.5">
        <SymbolView
          name="folder"
          size={12}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <Text className="shrink text-2xs text-foreground-muted" numberOfLines={1}>
          {place}
        </Text>
      </View>
      {branch !== null ? (
        <Pressable
          accessibilityRole={props.onPressBranch ? "button" : undefined}
          accessibilityLabel={`Branch ${branch}`}
          accessibilityHint={props.onPressBranch ? "Opens the thread's git controls." : undefined}
          className="min-w-0 shrink flex-row items-center gap-1 active:opacity-70"
          disabled={!props.onPressBranch}
          hitSlop={8}
          onPress={props.onPressBranch}
        >
          <SymbolView
            name="arrow.triangle.branch"
            size={12}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
          <Text className="shrink text-2xs text-foreground-muted" numberOfLines={1}>
            {branch}
          </Text>
          {props.onPressBranch ? (
            <SymbolView
              name="chevron.down"
              size={9}
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
            />
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
}
