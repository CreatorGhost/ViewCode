import { VIEWCODE_MARK as mark } from "@t3tools/shared/viewcodeBrand";
import Svg, { G, Path } from "react-native-svg";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

/** Flat code-bracket/git-branch emblem for small native UI, keeping the upstream name. */
export function T3Wordmark(props: { readonly height: number }) {
  const { themeAppearance } = useAppearancePreferences();
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
      <Path d={mark.bracketPath} fill={mark.teal} />
      <G transform="translate(1000 0) scale(-1 1)">
        <Path
          d={mark.bracketPath}
          fill={themeAppearance === "dark" ? mark.darkSlate : mark.slate}
        />
      </G>
      {mark.branchPaths.map((d) => (
        <Path key={d} d={d} stroke={mark.teal} strokeWidth={mark.branchStrokeWidth} />
      ))}
      {mark.ringPaths.map((d) => (
        <Path key={d} d={d} fill={mark.teal} fillRule="evenodd" />
      ))}
    </Svg>
  );
}
