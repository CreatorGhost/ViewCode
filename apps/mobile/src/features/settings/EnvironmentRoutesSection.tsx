import { useAtomValue } from "@effect/atom-react";
import {
  type ConnectionRoute,
  connectionRouteAddress,
  connectionRouteId,
  connectionRouteLabel,
  connectionRoutes,
  isLearned,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

/**
 * The ways this device reaches an environment, preferred first, and the one
 * in use. The first route that answers is used, and the connection moves back
 * up the list when a better route is reachable again. Add route pairs this
 * machine over another address.
 *
 * ViewCode keeps this smaller than upstream: no drag reordering, since new
 * routes are already placed fastest first (LAN, then Tailscale, then public).
 */
export function EnvironmentRoutesSection({
  environmentId,
  connected,
  onAddRoute,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly onAddRoute: () => void;
}) {
  const entry = useAtomValue(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  const prepared = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  const removeRoute = useAtomCommand(environmentCatalog.removeRoute, "route removal");
  if (entry === undefined) return null;

  const routes = connectionRoutes(entry);
  const activeRouteId =
    connected && Option.isSome(prepared) ? connectionRouteId(prepared.value.target) : null;
  const confirmRemove = (route: ConnectionRoute) =>
    Alert.alert(
      `Remove ${connectionRouteLabel(route)}?`,
      connectionRouteAddress(route) ?? undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            void removeRoute({ environmentId, routeId: connectionRouteId(route.target) }),
        },
      ],
    );

  return (
    <SettingsSection title="Routes">
      {routes.map((route, index) => (
        <RouteRow
          key={connectionRouteId(route.target)}
          route={route}
          position={index + 1}
          count={routes.length}
          inUse={connectionRouteId(route.target) === activeRouteId}
          // The last route goes with the machine, which is "Remove" on the row.
          // A learned route would be learned again, so it cannot be removed.
          onRemove={
            routes.length > 1 && !isLearned(route) ? () => confirmRemove(route) : undefined
          }
        />
      ))}
      <Pressable
        accessibilityRole="button"
        onPress={onAddRoute}
        className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-70"
      >
        <SymbolView name="plus" size={16} tintColorClassName="accent-icon" type="monochrome" />
        <Text className="text-base text-primary-text">Add route</Text>
      </Pressable>
    </SettingsSection>
  );
}

function RouteRow(props: {
  readonly route: ConnectionRoute;
  readonly position: number;
  readonly count: number;
  readonly inUse: boolean;
  readonly onRemove: (() => void) | undefined;
}) {
  const { route } = props;
  const label = connectionRouteLabel(route);
  const address = connectionRouteAddress(route);
  return (
    <View className="min-h-16 flex-row items-center">
      <View
        accessible
        accessibilityLabel={[
          label,
          address,
          isLearned(route) ? "Found automatically" : null,
          props.inUse ? "In use" : null,
          `Route ${props.position} of ${props.count}`,
        ]
          .filter((part) => part !== null)
          .join(", ")}
        className="min-w-0 flex-1 gap-0.5 px-4 py-3"
      >
        <View className="flex-row items-center gap-2">
          <Text className="text-base text-foreground">{label}</Text>
          {props.inUse ? (
            <Text className="text-xs font-t3-medium text-success-foreground">In use</Text>
          ) : null}
        </View>
        {address !== null ? (
          <Text numberOfLines={1} className="text-sm text-foreground-muted">
            {isLearned(route) ? `${address} · found automatically` : address}
          </Text>
        ) : null}
      </View>
      {props.onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label} route`}
          onPress={props.onRemove}
          className="h-full items-center justify-center px-4 active:opacity-70"
        >
          <SymbolView
            name="xmark.circle.fill"
            size={20}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
        </Pressable>
      ) : null}
    </View>
  );
}
