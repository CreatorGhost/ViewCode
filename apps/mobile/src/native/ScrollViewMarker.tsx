import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

/**
 * Stand-in for react-native-screens 5's `ScrollViewMarker`, which upstream T3 Code uses for iOS
 * scroll-edge effects. ViewCode is on react-native-screens 4, so the marker only keeps the layout
 * its children expect: a styled wrapper when given a style, nothing otherwise.
 */
export function ScrollViewMarker(props: {
  readonly style?: StyleProp<ViewStyle>;
  readonly scrollEdgeEffects?: Readonly<Record<string, string>>;
  readonly children: ReactNode;
}) {
  return props.style === undefined ? (
    props.children
  ) : (
    <View style={props.style}>{props.children}</View>
  );
}
