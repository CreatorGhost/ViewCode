import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** ViewCode's "Offset" mark: two open corners framing a shared space. */
export function OffsetMark(props: {
  readonly size: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg accessibilityLabel="ViewCode" height={props.size} width={props.size} viewBox="20 20 60 60">
      <ThemedPath
        d="M20 20h42v14H34v28H20zM80 80H38V66h28V38h14z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
