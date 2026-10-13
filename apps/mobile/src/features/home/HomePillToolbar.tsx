import type { MenuAction } from "@react-native-menu/menu";
import type { ComponentProps, ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { ControlPillMenu } from "../../components/ControlPill";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { useMaterialToolbarLayout } from "../../components/useMaterialToolbarLayout";
import { useWorkspaceState } from "../../state/workspace";
import { HomePillIconButton, HomePillSurface } from "./HomePillButton";
import { workspaceFleetSubtitle } from "./workspace-connection-status";

type MenuActionHandler = NonNullable<ComponentProps<typeof ControlPillMenu>["onPressAction"]>;

type HomeScopePillsProps = {
  readonly environmentLabel: string;
  readonly environmentHealth: "online" | "attention";
  readonly environmentActions: MenuAction[];
  readonly projectLabel: string;
  readonly projectActions: MenuAction[];
  readonly onMenuAction: MenuActionHandler;
  readonly onOpenEnvironments: () => void;
  readonly onOpenPullRequests?: () => void;
};

/** Shared title and fleet status for Home's native and in-flow navigation bars. */
export function HomeFleetTitle(props: { readonly onOpenEnvironments: () => void }) {
  const { scale } = useAndroidControlSizing();
  const { state, environments } = useWorkspaceState();
  const subtitle = workspaceFleetSubtitle(state.networkStatus, environments);
  const subtitleText = subtitle.tail ? `${subtitle.lead} · ${subtitle.tail}` : subtitle.lead;
  return (
    <View className="min-w-0 items-center">
      <CompactBrandTitle showStageLabel={false} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={subtitleText}
        accessibilityHint="Opens environment settings."
        onPress={props.onOpenEnvironments}
        hitSlop={{ top: 6, bottom: 6, left: 12, right: 12 }}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <Text className="text-foreground-muted" style={{ fontSize: 12 * scale }} numberOfLines={1}>
          {subtitle.lead}
          {subtitle.tail ? (
            <>
              {" · "}
              <Text
                className={
                  subtitle.tailTone === "warning"
                    ? "text-adaptive-amber-700-400"
                    : "text-foreground-muted"
                }
                style={{ fontSize: 12 * scale }}
              >
                {subtitle.tail}
              </Text>
            </>
          ) : null}
        </Text>
      </Pressable>
    </View>
  );
}

function HomeScopeMenu(props: {
  readonly actions: MenuAction[];
  readonly onPressAction: MenuActionHandler;
  readonly children: (open?: () => void) => ReactNode;
  readonly preservesLabelWidth?: boolean;
}) {
  // Beside the pull request button the project pill keeps its label; the environment pill gives way.
  const labelWidthStyle = props.preservesLabelWidth
    ? ({ flexShrink: 0, maxWidth: "40%" } as const)
    : undefined;
  if (Platform.OS === "android") {
    return (
      <AndroidAnchoredMenu
        actions={props.actions}
        onPressAction={props.onPressAction}
        className="min-w-0 shrink"
        style={labelWidthStyle}
      >
        {props.children}
      </AndroidAnchoredMenu>
    );
  }
  return (
    <View className="min-w-0 shrink" style={labelWidthStyle}>
      <ControlPillMenu actions={props.actions} onPressAction={props.onPressAction}>
        {props.children()}
      </ControlPillMenu>
    </View>
  );
}

/** Environment and project scope, with platform-native menu presentation. */
export function HomeScopePills(props: HomeScopePillsProps) {
  const { scale } = useAndroidControlSizing();
  const { state } = useWorkspaceState();
  const filterPill = (input: {
    readonly label: string;
    readonly accessibilityLabel: string;
    readonly accessibilityHint: string;
    readonly showsHealth?: boolean;
    readonly onPress?: () => void;
  }) => (
    <HomePillSurface
      accessibilityLabel={input.accessibilityLabel}
      accessibilityHint={input.accessibilityHint}
      onPress={input.onPress}
      className="min-w-0 shrink"
      // Lighter than the round buttons above: a filter row, not primary actions.
      style={{ height: Math.round(40 * scale), paddingHorizontal: 12 * scale, gap: 6 * scale }}
    >
      {input.showsHealth ? (
        <View
          className={`size-2 rounded-full ${
            props.environmentHealth === "online"
              ? "bg-adaptive-emerald-600-400"
              : "bg-adaptive-amber-700-400"
          }`}
        />
      ) : null}
      <Text
        className="min-w-0 shrink font-t3-medium text-foreground"
        style={{ fontSize: 14 * scale }}
        numberOfLines={1}
      >
        {input.label}
      </Text>
      <SymbolView
        name="chevron.down"
        size={Math.round(13 * scale)}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
    </HomePillSurface>
  );

  const environmentPill = (onPress?: () => void) =>
    filterPill({
      label: props.environmentLabel,
      accessibilityLabel: `Environment: ${props.environmentLabel}`,
      accessibilityHint: "Chooses which environment's threads to show.",
      showsHealth: true,
      onPress,
    });

  return (
    <View
      className="flex-row items-center"
      style={{ gap: 8 * scale, paddingHorizontal: 16, paddingBottom: 8 * scale }}
    >
      {state.hasConnections ? (
        <HomeScopeMenu actions={props.environmentActions} onPressAction={props.onMenuAction}>
          {(open) => environmentPill(open)}
        </HomeScopeMenu>
      ) : (
        environmentPill(props.onOpenEnvironments)
      )}
      {props.projectActions.length > 1 ? (
        <HomeScopeMenu
          actions={props.projectActions}
          onPressAction={props.onMenuAction}
          preservesLabelWidth={props.onOpenPullRequests !== undefined}
        >
          {(open) =>
            filterPill({
              label: props.projectLabel,
              accessibilityLabel: `Project: ${props.projectLabel}`,
              accessibilityHint: "Chooses which project's threads to show.",
              onPress: open,
            })
          }
        </HomeScopeMenu>
      ) : null}
      {props.onOpenPullRequests ? (
        <HomePillIconButton
          accessibilityLabel="Open pull requests"
          icon="arrow.triangle.pull"
          onPress={props.onOpenPullRequests}
        />
      ) : null}
    </View>
  );
}

/** Android uses the same title and scope pills beneath its safe area. */
export function HomePillToolbar(
  props: HomeScopePillsProps & {
    readonly onOpenSettings: () => void;
    readonly onOpenUsage: () => void;
  },
) {
  const { paddingTop } = useMaterialToolbarLayout();
  const { scale } = useAndroidControlSizing();
  return (
    <View className="bg-screen" style={{ paddingTop }}>
      <View
        className="flex-row items-center"
        style={{ gap: 8 * scale, paddingHorizontal: 16, paddingVertical: 8 * scale }}
      >
        <HomePillIconButton
          accessibilityLabel="Open settings"
          icon="gearshape"
          onPress={props.onOpenSettings}
        />
        <View className="min-w-0 flex-1 items-center">
          <HomeFleetTitle onOpenEnvironments={props.onOpenEnvironments} />
        </View>
        <HomePillIconButton
          accessibilityLabel="Open usage"
          icon="chart.bar.xaxis"
          onPress={props.onOpenUsage}
        />
      </View>
      <HomeScopePills {...props} />
    </View>
  );
}
