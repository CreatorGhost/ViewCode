import { VIEWCODE_MARK as mark } from "@t3tools/shared/viewcodeBrand";
import { useId } from "react";
import Svg, { Defs, G, Mask, Path, Rect } from "react-native-svg";
import { withUniwind } from "uniwind";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

const ThemedPath = withUniwind(Path);

/** The same black and teal V as web, keeping the upstream component name. */
export function T3Wordmark(props: { readonly height: number }) {
  const cutId = useId();
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
      <Defs>
        <Mask id={cutId} maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
          <Rect width="1024" height="1024" fill="#fff" />
          <Path
            d={mark.rightPath}
            stroke="#000"
            strokeWidth={mark.cutStrokeWidth}
            strokeLinecap="round"
          />
        </Mask>
      </Defs>
      <G mask={`url(#${cutId})`}>
        {themeAppearance === "dark" ? (
          <ThemedPath
            d={mark.leftPath}
            colorClassName="accent-foreground"
            stroke="currentColor"
            strokeOpacity={0.5}
            strokeWidth={mark.outlineStrokeWidth}
            strokeLinecap="round"
          />
        ) : null}
        <Path
          d={mark.leftPath}
          stroke={mark.black}
          strokeWidth={mark.strokeWidth}
          strokeLinecap="round"
        />
      </G>
      <Path
        d={mark.rightPath}
        stroke={mark.teal}
        strokeWidth={mark.strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}
