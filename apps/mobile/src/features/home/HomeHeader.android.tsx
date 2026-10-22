import { NativeStackScreenOptions } from "../../native/StackHeader";
import { HomePillToolbar } from "./HomePillToolbar";
import type { HomeHeaderProps } from "./HomeHeader.types";
import { useHomeScopeFilters } from "./HomeScopeFilters";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

export function HomeHeader(props: HomeHeaderProps) {
  const scope = useHomeScopeFilters(props);
  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <HomePillToolbar
        {...scope}
        onOpenSettings={props.onOpenSettings}
        onOpenUsage={props.onOpenUsage}
        rockBot={props.rockBot}
        onOpenPullRequests={props.onOpenPullRequests}
      />
    </>
  );
}
