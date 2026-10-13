import { VIEWCODE_MARK as mark } from "@t3tools/shared/viewcodeBrand";
import Svg, { Circle, G, Path } from "react-native-svg";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

/** Flat code-bracket/git-branch emblem for small native UI, keeping the upstream name. */
export function T3Wordmark(props: { readonly height: number }) {
  const { themeAppearance } = useAppearancePreferences();
  const fill = themeAppearance === "dark" ? "#ffffff" : mark.ink;
  return (
    <Svg
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      height={props.height}
      width={props.height * mark.aspectRatio}
      viewBox={mark.viewBox}
      fill="none"
    >
      <Path d={mark.bracketPath} fill={fill} />
      <G transform="translate(1000 0) scale(-1 1)">
        <Path d={mark.bracketPath} fill={fill} />
      </G>
      {mark.branchPaths.map((d) => (
        <Path key={d} d={d} stroke={fill} strokeWidth={mark.branchStrokeWidth} />
      ))}
      {mark.ringPaths.map((d) => (
        <Path key={d} d={d} fill={fill} fillRule="evenodd" />
      ))}
      {mark.nodeCenters.map(([cx, cy]) => (
        <Circle key={cx} cx={cx} cy={cy} r={mark.nodeDotRadius} fill={mark.teal} />
      ))}
    </Svg>
  );
}
