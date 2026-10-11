import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  Keyboard,
  Pressable,
  TextInput,
  type TextInputInstance,
  View,
  type ViewStyle,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";

import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { cn } from "../../lib/cn";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { HomeTerminalTarget } from "./homeTerminalTargets";

/** Unscaled list clearance under the bar: its height plus the gaps around it. */
export const HOME_COMPOSER_CLEARANCE = 72;

/** Most recently active projects the terminal menu lists. */
const TERMINAL_MENU_LIMIT = 8;

const FLOATING_SHADOW = {
  elevation: 4,
  shadowColor: "#000000",
  shadowOpacity: 0.12,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
} satisfies ViewStyle;

function RoundBarButton(props: {
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  /** The dark primary action; the rest share the outlined card look of Home's top pills. */
  readonly filled?: boolean;
}) {
  const { themeVariables } = useAppearancePreferences();
  const { buttonSize, iconSize } = useAndroidControlSizing();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: props.disabled === true }}
      android_ripple={{ color: themeVariables["--color-row-hover"], foreground: true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "items-center justify-center overflow-hidden rounded-full",
        props.filled ? "bg-foreground" : "border border-border-subtle bg-card",
      )}
      style={[
        { width: buttonSize, height: buttonSize, opacity: props.disabled ? 0.4 : 1 },
        FLOATING_SHADOW,
      ]}
    >
      <SymbolView
        name={props.icon}
        size={iconSize}
        tintColorClassName={props.filled ? "accent-screen" : "accent-foreground"}
        type="monochrome"
      />
    </Pressable>
  );
}

/** Terminals belong to a thread, so each project opens through its latest one. */
function TerminalButton(props: {
  readonly targets: ReadonlyArray<HomeTerminalTarget>;
  readonly selected: HomeTerminalTarget | null;
  readonly onOpen: (target: HomeTerminalTarget) => void;
}) {
  const { onOpen, targets } = props;
  const menuTargets = useMemo(() => targets.slice(0, TERMINAL_MENU_LIMIT), [targets]);
  const actions = useMemo<MenuAction[]>(
    () =>
      menuTargets.map((target) => ({
        id: target.scopeKey,
        title: target.projectTitle,
        subtitle: target.threadTitle,
      })),
    [menuTargets],
  );
  const handleAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const target = menuTargets.find(
        (candidate) => candidate.scopeKey === event.nativeEvent.event,
      );
      if (target) onOpen(target);
    },
    [menuTargets, onOpen],
  );
  const { selected } = props;
  return (
    <AndroidAnchoredMenu title="Open terminal in…" actions={actions} onPressAction={handleAction}>
      {(open) => (
        <RoundBarButton
          accessibilityLabel={
            selected ? `Open terminal in ${selected.projectTitle}` : "Open terminal in…"
          }
          accessibilityHint={
            targets.length === 0
              ? "Disabled until a project has a thread, since terminals open inside a thread."
              : selected
                ? "Opens a terminal in the selected project's latest thread."
                : "Chooses which project to open a terminal in."
          }
          icon="terminal"
          disabled={targets.length === 0}
          onPress={selected ? () => onOpen(selected) : open}
        />
      )}
    </AndroidAnchoredMenu>
  );
}

function SearchField(props: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}) {
  const { scale, buttonSize, iconSize } = useAndroidControlSizing();
  const { onQueryChange, query } = props;
  const inputRef = useRef<TextInputInstance>(null);
  const [focused, setFocused] = useState(false);
  const active = focused || query.length > 0;

  const focusSearch = useCallback(() => {
    inputRef.current?.focus();
    return true;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);

  // Back leaves search first: clear the query and drop focus before navigating away.
  useEffect(() => {
    if (!active) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onQueryChange("");
      inputRef.current?.blur();
      Keyboard.dismiss();
      return true;
    });
    return () => subscription.remove();
  }, [active, onQueryChange]);

  return (
    <View
      className="min-w-0 flex-1 flex-row items-center rounded-full border border-border-subtle bg-card"
      style={[
        {
          height: buttonSize,
          paddingLeft: 14 * scale,
          paddingRight: query.length > 0 ? 4 * scale : 14 * scale,
          gap: 8 * scale,
        },
        FLOATING_SHADOW,
      ]}
    >
      <SymbolView
        name="magnifyingglass"
        size={Math.round(iconSize * 0.75)}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <TextInput
        ref={inputRef}
        accessibilityLabel="Search threads"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        placeholder="Search threads"
        placeholderTextColorClassName="accent-placeholder"
        selectionColorClassName="accent-focus/32"
        cursorColorClassName="accent-focus"
        selectionHandleColorClassName="accent-focus"
        className="min-w-0 flex-1 font-sans text-foreground"
        style={{ fontSize: 16 * scale, paddingVertical: 0 }}
        value={query}
        onChangeText={onQueryChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {query.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={8}
          onPress={() => onQueryChange("")}
          className="items-center justify-center rounded-full"
          style={{ width: buttonSize - 8, height: buttonSize - 8 }}
        >
          <SymbolView
            name="xmark"
            size={Math.round(iconSize * 0.75)}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Android Home's floating bottom bar: the thread search field, a terminal
 * shortcut and the new-thread button. It rides just above the soft keyboard
 * while the search field is focused.
 */
export function HomeComposerLauncher(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly terminalTargets: ReadonlyArray<HomeTerminalTarget>;
  readonly selectedTerminalTarget: HomeTerminalTarget | null;
  readonly onOpenTerminal: (target: HomeTerminalTarget) => void;
  readonly onStartNewTask: () => void;
  /** Gap between the bar and the screen bottom while the keyboard is closed. */
  readonly bottomInset: number;
}) {
  const { scale } = useAndroidControlSizing();
  return (
    // The sticky host lifts the whole bar by the keyboard height; once the
    // keyboard is open the system inset gap is dropped, leaving a small margin.
    <KeyboardStickyView
      pointerEvents="box-none"
      style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
      offset={{ closed: 0, opened: props.bottomInset - 8 }}
    >
      <View
        pointerEvents="box-none"
        className="absolute inset-x-4 flex-row items-center"
        style={{ bottom: props.bottomInset, gap: 8 * scale }}
      >
        <SearchField query={props.searchQuery} onQueryChange={props.onSearchQueryChange} />
        <TerminalButton
          targets={props.terminalTargets}
          selected={props.selectedTerminalTarget}
          onOpen={props.onOpenTerminal}
        />
        <RoundBarButton
          accessibilityLabel="New thread"
          icon="square.and.pencil"
          filled
          onPress={props.onStartNewTask}
        />
      </View>
    </KeyboardStickyView>
  );
}
