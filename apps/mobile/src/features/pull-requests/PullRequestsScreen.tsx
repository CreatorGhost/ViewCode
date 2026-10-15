import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectId } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type ScrollViewProps,
} from "react-native";
import { ScrollViewMarker } from "../../native/ScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useWorkspaceState } from "../../state/workspace";
import { useProjects } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { PullRequestListRow } from "./PullRequestListRow";
import { PullRequestListFilters } from "./PullRequestListFilters";
import { pullRequestListControlsAtom, usePullRequestList } from "./usePullRequestList";
import { usePullRequestListActions } from "./usePullRequestListActions";
import {
  filterPullRequestList,
  groupPullRequestListByProject,
  pullRequestListFacets,
  pullRequestListItemKey,
  pullRequestListRowsAreEqual,
  scopedPullRequestListKey as pullRequestKey,
  type EnvironmentPullRequestListEntry,
  type PullRequestListItem,
  PR_LIST_PAGE_SIZE,
} from "./pullRequestList";
import { useDebouncedValue } from "../../state/queries";
import { usePullRequestListContext } from "./PullRequestListContext";

function PullRequestScrollView(props: ScrollViewProps) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollViewMarker>
      <ScrollView
        {...props}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentOffset={props.contentOffset ?? { x: 0, y: -insets.top }}
      />
    </ScrollViewMarker>
  );
}

const projectLabelOf = (entry: EnvironmentPullRequestListEntry) =>
  entry.projectTitle || entry.repository;

const NO_COLLAPSED_PROJECTS: readonly string[] = [];

const pullRequestListItemsAreEqual = (previous: PullRequestListItem, next: PullRequestListItem) =>
  previous.kind === "row" && next.kind === "row"
    ? pullRequestListRowsAreEqual(previous.entry, next.entry)
    : previous.kind === "project" &&
      next.kind === "project" &&
      previous.key === next.key &&
      previous.label === next.label &&
      previous.count === next.count &&
      previous.collapsed === next.collapsed;

/** A project's header in the list: tap to fold its pull requests away or bring them back. */
function PullRequestProjectHeader(props: {
  readonly item: Extract<PullRequestListItem, { kind: "project" }>;
  readonly onToggle: (key: string) => void;
}) {
  const { item, onToggle } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: !item.collapsed }}
      accessibilityLabel={`${item.label}, ${item.count} pull ${item.count === 1 ? "request" : "requests"}`}
      onPress={() => onToggle(item.key)}
      className="flex-row items-center gap-2 px-4 pb-1 pt-4"
    >
      {/* Swapped rather than rotated: a rotated glyph leaves its viewport on Android. */}
      <SymbolView
        name={item.collapsed ? "chevron.right" : "chevron.down"}
        size={11}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <Text className="shrink text-xs font-t3-medium text-foreground-muted" numberOfLines={1}>
        {item.label}
      </Text>
      <Text className="text-xs text-foreground-muted opacity-60">{item.count}</Text>
      <View className="h-px flex-1 bg-border" />
    </Pressable>
  );
}

export function PullRequestsScreen() {
  const navigation = useNavigation();
  const primaryColumn = use(NativePrimaryColumnContext);
  const list = usePullRequestListContext();
  const { environments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const insets = useSafeAreaInsets();
  const [initialOffset] = useState(() => list.getScrollOffset());
  const [initialAnchor] = useState(() => list.getScrollAnchor());
  const listRef = useRef<LegendListRef>(null);
  const search = list.state;
  const maintainVisiblePosition = useMemo(
    () => ({
      data: !search.searching,
      // At the top, reveal new PRs without pushing the filter strip out of view.
      shouldRestorePosition: () => list.getScrollOffset() > 0,
    }),
    [search.searching, list],
  );
  const debouncedQuery = useDebouncedValue(search.query.trim(), 180);
  // Dismissal must restore the cached unfiltered list before restoring its offset.
  const query = !search.searching ? "" : debouncedQuery;
  const selectedEnvironmentId = list.environmentId;
  const environmentId = environments.some((item) => item.environmentId === selectedEnvironmentId)
    ? selectedEnvironmentId
    : null;
  const selectPullRequest = useCallback(
    (item: EnvironmentPullRequestListEntry) => {
      Keyboard.dismiss();
      const params = {
        environmentId: String(item.environmentId),
        projectId: String(item.projectId),
        repository: item.repository,
        number: item.number,
        host: item.host,
        initialSummary: item,
      };
      navigation.navigate("PullRequest", params);
    },
    [navigation],
  );
  const controlsAtom = pullRequestListControlsAtom(environmentId ?? "");
  const controls = useAtomValue(controlsAtom);
  const setControls = useAtomSet(controlsAtom);
  const targets = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            environment.connectionState === "connected" &&
            configs.get(environment.environmentId)?.environment.capabilities.pullRequests ===
              true &&
            (environmentId === null || environment.environmentId === environmentId) &&
            (!controls.projectEnvironmentId ||
              environment.environmentId === controls.projectEnvironmentId),
        )
        .sort((left, right) => left.environmentId.localeCompare(right.environmentId))
        .map((environment) => ({
          environmentId: environment.environmentId,
          input: {
            state: controls.state,
            involvement: controls.involvement,
            filters: controls.filters,
            limit: PR_LIST_PAGE_SIZE,
            ...(controls.projectId ? { projectId: ProjectId.make(controls.projectId) } : {}),
            ...(query ? { query } : {}),
          },
        })),
    [environments, environmentId, configs, controls, query],
  );
  const result = usePullRequestList(targets);
  const { actions, select, busyKey } = usePullRequestListActions(
    targets.map((target) => target.environmentId),
    result.updateEntry,
  );
  const sidebar = primaryColumn !== null;
  const selectedKey = primaryColumn?.selectedPullRequestKey;
  const entries = useMemo(
    () =>
      filterPullRequestList(
        result.entries,
        controls,
        result.data?.viewers ?? {},
        query,
        result.data.localSearchHosts,
      ),
    [result.entries, controls, query, result.data],
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const collapsedProjects =
    (AsyncResult.isSuccess(preferences)
      ? preferences.value.pullRequestCollapsedProjects
      : undefined) ?? NO_COLLAPSED_PROJECTS;
  const items = useMemo(
    () => groupPullRequestListByProject(entries, projectLabelOf, new Set(collapsedProjects)),
    [entries, collapsedProjects],
  );
  const toggleProject = useCallback(
    (key: string) =>
      savePreferences({
        transform: (current) => {
          const held = current.pullRequestCollapsedProjects ?? [];
          return {
            pullRequestCollapsedProjects: held.includes(key)
              ? held.filter((candidate) => candidate !== key)
              : [...held, key],
          };
        },
      }),
    [savePreferences],
  );
  const facets = useMemo(() => pullRequestListFacets(result.entries), [result.entries]);
  const [knownFacets, setKnownFacets] = useState({ environmentId, source: facets, ...facets });
  if (knownFacets.environmentId !== environmentId || knownFacets.source !== facets) {
    setKnownFacets((previous) => ({
      source: facets,
      environmentId,
      authors: [
        ...new Set([
          ...(previous.environmentId === environmentId ? previous.authors : []),
          ...facets.authors,
        ]),
      ].sort(),
      labels: [
        ...new Set([
          ...(previous.environmentId === environmentId ? previous.labels : []),
          ...facets.labels,
        ]),
      ].sort(),
    }));
  }
  const projects = useProjects().filter(
    (project) => environmentId === null || project.environmentId === environmentId,
  );
  const renderPullRequest = useCallback(
    ({ item }: { readonly item: PullRequestListItem }) =>
      item.kind === "project" ? (
        <PullRequestProjectHeader item={item} onToggle={toggleProject} />
      ) : (
        <PullRequestListRow
          item={item.entry}
          onSelect={selectPullRequest}
          getActions={actions}
          onAction={select}
          busy={busyKey === pullRequestKey(item.entry)}
          selected={selectedKey === pullRequestKey(item.entry)}
          sidebar={sidebar}
        />
      ),
    [selectPullRequest, selectedKey, actions, select, busyKey, sidebar, toggleProject],
  );
  const previousSearchMode = useRef(search.searching);
  useEffect(() => {
    const restoringSearch = previousSearchMode.current && !search.searching;
    previousSearchMode.current = search.searching;
    if (restoringSearch)
      void listRef.current?.scrollToOffset({
        offset: search.scrollOffset - (Platform.OS === "ios" ? insets.top : 0),
        animated: false,
      });
  }, [search.searching, search.scrollOffset, insets.top]);
  const resultOnViewableItemsChanged = result.onViewableItemsChanged;
  // Line counts are asked for the rows on screen; project headers have none.
  const onViewableItemsChanged = useCallback(
    ({
      viewableItems,
    }: {
      readonly viewableItems: readonly {
        readonly item: PullRequestListItem;
        readonly isViewable: boolean;
      }[];
    }) =>
      resultOnViewableItemsChanged({
        viewableItems: viewableItems.flatMap((token) =>
          token.item.kind === "row"
            ? [{ item: token.item.entry, isViewable: token.isViewable }]
            : [],
        ),
      }),
    [resultOnViewableItemsChanged],
  );
  const initialIndex = initialAnchor
    ? items.findIndex((item) => pullRequestListItemKey(item) === initialAnchor.key)
    : -1;

  return (
    <View className={sidebar ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
      <LegendList
        ref={listRef}
        data={items}
        extraData={`${selectedKey}:${busyKey}`}
        keyExtractor={pullRequestListItemKey}
        itemsAreEqual={pullRequestListItemsAreEqual}
        getItemType={(item) => item.kind}
        // Default-size rows measure about 78pt with one title line and 98pt with two.
        estimatedItemSize={88}
        // Build roughly a screen ahead so a fling reaches already-mounted rows.
        drawDistance={1_000}
        maintainVisibleContentPosition={result.continued ? maintainVisiblePosition : false}
        onEndReached={() => void result.loadMore()}
        onEndReachedThreshold={0.5}
        onViewableItemsChanged={onViewableItemsChanged}
        refreshControl={
          <RefreshControl
            refreshing={result.refreshing}
            onRefresh={() => void result.onRefresh()}
            // Place the 60pt native refresh control in the revealed pull-down space.
            // The list already accounts for the navigation header in its content inset.
            progressViewOffset={Platform.OS === "ios" ? 60 : undefined}
          />
        }
        alwaysBounceVertical
        recycleItems
        renderScrollComponent={Platform.OS === "ios" ? PullRequestScrollView : undefined}
        contentInsetAdjustmentBehavior="never"
        contentInset={Platform.OS === "ios" ? { top: insets.top } : undefined}
        initialScrollOffset={
          !initialAnchor && initialOffset > 0
            ? initialOffset - (Platform.OS === "ios" ? insets.top : 0)
            : undefined
        }
        initialScrollIndex={
          initialIndex >= 0 && initialAnchor
            ? { index: initialIndex, viewOffset: initialAnchor.viewOffset, viewPosition: 0 }
            : undefined
        }
        contentInsetStartAdjustment={Platform.OS === "ios" ? insets.top : 0}
        contentContainerStyle={{
          paddingBottom: insets.bottom + 16,
        }}
        onScroll={(event) => {
          list.recordScrollOffset(
            Math.max(
              0,
              event.nativeEvent.contentOffset.y + (Platform.OS === "ios" ? insets.top : 0),
            ),
          );
          const listState = listRef.current?.getState();
          const item = listState ? items[listState.start] : undefined;
          if (listState && item)
            list.recordScrollAnchor({
              key: pullRequestListItemKey(item),
              viewOffset:
                listState.positionAtIndex(listState.start) - event.nativeEvent.contentOffset.y,
            });
        }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        renderItem={renderPullRequest}
        ListHeaderComponent={
          <>
            <PullRequestListFilters
              environments={environments.map((item) => ({
                id: String(item.environmentId),
                label: item.environmentLabel,
              }))}
              environmentId={environmentId}
              onEnvironmentChange={list.setEnvironmentId}
              value={controls}
              onChange={(next) => {
                setControls(next);
                void listRef.current?.scrollToOffset({
                  offset: Platform.OS === "ios" ? -insets.top : 0,
                  animated: false,
                });
              }}
              authors={
                knownFacets.environmentId === environmentId ? knownFacets.authors : facets.authors
              }
              labels={
                knownFacets.environmentId === environmentId ? knownFacets.labels : facets.labels
              }
              projects={projects}
            />
            {result.data?.errors.length ? (
              <Text className="px-4 py-3 text-sm text-foreground-muted">
                {result.data.errors
                  .map(
                    (error) =>
                      `${error.projectTitle || environments.find((environment) => environment.environmentId === error.environmentId)?.environmentLabel || "Environment"}: ${error.message}`,
                  )
                  .join("\n")}
              </Text>
            ) : null}
          </>
        }
        ListFooterComponent={
          result.loadingMore ? (
            <View className="items-center py-5">
              <ActivityIndicator
                colorClassName="accent-icon"
                accessibilityLabel="Loading more pull requests"
              />
            </View>
          ) : result.loadMoreError ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading more pull requests"
              onPress={() => void result.loadMore(true)}
              className="items-center gap-2 px-8 py-4"
            >
              <Text className="text-xs text-foreground-muted">{result.loadMoreError}</Text>
              <Text className="text-sm font-t3-medium text-link">Try again</Text>
            </Pressable>
          ) : undefined
        }
        ListEmptyComponent={
          result.isPending ? (
            <View className="items-center py-12">
              <ActivityIndicator colorClassName="accent-icon" />
            </View>
          ) : (
            <View className="px-8 py-12">
              <EmptyState
                title={
                  result.error
                    ? "Couldn't load pull requests"
                    : targets.length
                      ? query
                        ? "No results"
                        : "No matching pull requests"
                      : "Connect an environment"
                }
                detail={
                  result.error ??
                  (targets.length
                    ? "Pull requests from the selected environments' projects appear here."
                    : "Add an environment in Settings to browse its pull requests.")
                }
                variant="plain"
              />
            </View>
          )
        }
      />
    </View>
  );
}
