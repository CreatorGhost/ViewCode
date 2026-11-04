import {
  AppearancePreferencesContext,
  type AppearancePreferencesContextValue,
} from "../../../lib/appearancePreferencesContext";
export { useAppearancePreferences } from "../../../lib/appearancePreferencesContext";

import {
  startTransition,
  useCallback,
  useEffect,
  useState,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { AppState, Appearance, Platform, useColorScheme } from "react-native";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { ScopedTheme, ScopedVariables, Uniwind } from "uniwind";

import {
  resolveAppearance,
  resolveAppearancePreferences,
} from "../../../lib/appearancePreferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import type { Preferences } from "../../../persistence/mobile-preferences";
import { isSystemColorsAvailable, readSystemColorPalettes } from "../../../lib/materialYouPalette";
import { materialYouPaletteToMobileThemeVariables } from "../../../lib/materialYouTheme";
import { getMobileThemeRuntimeVariables } from "../../../lib/mobileThemeVariables";
import {
  createMobileThemeCardPatch,
  createMobileThemeSelectionPatch,
  normalizeMobileThemeMode,
  resolveMobileThemeIds,
  type MobileThemeAppearance,
  type MobileThemeIds,
  type MobileThemeId,
  type MobileThemeMode,
} from "../../../lib/mobileTheme";
import {
  createMobileThemeRuntimeOperations,
  getMobileUniwindThemeName,
  type MobileThemeRuntimeState,
} from "../../../lib/mobileThemeRuntime";

export function AppearancePreferencesProvider(props: { readonly children: ReactNode }) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const systemColorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const storedPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : null;
  const preferences = useMemo(
    () => resolveAppearancePreferences(storedPreferences),
    [storedPreferences],
  );
  const themeMode = normalizeMobileThemeMode(storedPreferences?.themeMode);
  const themeAppearance = themeMode === "system" ? systemColorScheme : themeMode;
  const resolvedThemeIds = resolveMobileThemeIds(storedPreferences ?? {});
  const themeIds = useMemo<MobileThemeIds>(
    () => ({ light: resolvedThemeIds.light, dark: resolvedThemeIds.dark }),
    [resolvedThemeIds.dark, resolvedThemeIds.light],
  );
  const themeId = themeIds[themeAppearance];
  const systemColorsActive = themeId === "material-you" && isSystemColorsAvailable;
  const [systemColorPalettes, setSystemColorPalettes] = useState(readSystemColorPalettes);
  useEffect(() => {
    if (!isSystemColorsAvailable) return;
    const refresh = () => {
      const next = readSystemColorPalettes();
      setSystemColorPalettes((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    const focusSubscription = AppState.addEventListener("focus", refresh);
    return () => {
      subscription.remove();
      focusSubscription.remove();
    };
  }, []);
  const themeVariablesByAppearance = useMemo(() => {
    const resolve = (appearance: MobileThemeAppearance) => {
      const base = getMobileThemeRuntimeVariables(themeIds[appearance], appearance, Platform.OS);
      return themeIds[appearance] === "material-you" && systemColorPalettes
        ? materialYouPaletteToMobileThemeVariables(
            systemColorPalettes[appearance],
            appearance,
            base,
          )
        : base;
    };
    return { light: resolve("light"), dark: resolve("dark") };
  }, [themeIds, systemColorPalettes]);
  const themeVariables = themeVariablesByAppearance[themeAppearance];
  const activeThemeName = getMobileUniwindThemeName(themeId, themeAppearance);
  const { baseFontSize, codeFontSize, codeWordBreak, terminalFontSize } = preferences;
  const appearance = useMemo(
    () => resolveAppearance({ baseFontSize, codeFontSize, codeWordBreak, terminalFontSize }),
    [baseFontSize, codeFontSize, codeWordBreak, terminalFontSize],
  );
  // Preference patches are optimistic. Keep controls interactive while a save is
  // in flight so rapid theme choices can supersede one another immediately.
  const isReady = AsyncResult.isSuccess(preferencesResult);
  const runtimeState = useMemo<MobileThemeRuntimeState>(
    () => ({
      baseFontSize,
      themeAppearance,
      themeMode,
    }),
    [baseFontSize, themeAppearance, themeMode],
  );
  const appliedRuntimeStateRef = useRef<MobileThemeRuntimeState | null>(null);
  const selectedThemeIdsRef = useRef(themeIds);

  const applyThemeRuntime = useCallback((next: MobileThemeRuntimeState) => {
    const operations = createMobileThemeRuntimeOperations(appliedRuntimeStateRef.current, next);
    for (const operation of operations) {
      if (operation.kind === "update-text-variables") {
        Uniwind.updateCSSVariables(operation.themeName, operation.variables);
        continue;
      }
      if (operation.kind === "set-appearance-mode") {
        Appearance.setColorScheme(
          operation.themeMode === "system" ? "unspecified" : operation.appearance,
        );
      }
    }
    appliedRuntimeStateRef.current = next;
  }, []);

  const syncThemeRuntime = useCallback(
    (next: MobileThemeRuntimeState) => applyThemeRuntime(next),
    [applyThemeRuntime],
  );

  const updatePreferences = useCallback(
    (patch: Partial<Preferences>) => {
      startTransition(() => savePreferences(patch));
    },
    [savePreferences],
  );

  const updateThemePreferences = useCallback(
    (patch: Partial<Preferences>) => {
      // Theme selection owns the visible root ScopedTheme value. Keep its
      // optimistic atom update urgent so the first frame after a press is the
      // complete new palette rather than a deferred transition render.
      savePreferences(patch);
    },
    [savePreferences],
  );

  useLayoutEffect(() => {
    selectedThemeIdsRef.current = themeIds;
    syncThemeRuntime(runtimeState);
  }, [runtimeState, syncThemeRuntime, themeIds]);

  const setThemeIdForAppearance = useCallback(
    (appearance: MobileThemeAppearance, value: MobileThemeId) => {
      const patch = createMobileThemeSelectionPatch(
        selectedThemeIdsRef.current,
        themeAppearance,
        appearance,
        value,
      );
      selectedThemeIdsRef.current = resolveMobileThemeIds(patch);
      updateThemePreferences(patch);
    },
    [themeAppearance, updateThemePreferences],
  );

  const selectTheme = useCallback(
    (value: MobileThemeId) => {
      const patch = createMobileThemeCardPatch(selectedThemeIdsRef.current, themeAppearance, value);
      selectedThemeIdsRef.current = resolveMobileThemeIds(patch);
      updateThemePreferences(patch);
    },
    [themeAppearance, updateThemePreferences],
  );

  const setThemeMode = useCallback(
    (value: MobileThemeMode) => {
      const current = appliedRuntimeStateRef.current ?? runtimeState;

      // Clear a forced native appearance before publishing System. The
      // resulting useColorScheme notification still sees the previous forced
      // preference, so React batches the actual system palette into the one
      // urgent preference commit below.
      if (value === "system") {
        Appearance.setColorScheme("unspecified");
      }
      const nextAppearance =
        value === "system" ? (Appearance.getColorScheme() === "dark" ? "dark" : "light") : value;
      const next = {
        ...current,
        themeAppearance: nextAppearance,
        themeMode: value,
      };

      updateThemePreferences({ themeMode: value });
      if (value === "system") {
        appliedRuntimeStateRef.current = next;
      } else {
        syncThemeRuntime(next);
      }
    },
    [runtimeState, syncThemeRuntime, updateThemePreferences],
  );

  const setBaseFontSize = useCallback(
    (value: number) => {
      const current = appliedRuntimeStateRef.current ?? runtimeState;
      syncThemeRuntime({ ...current, baseFontSize: value });
      updatePreferences({ baseFontSize: value });
    },
    [runtimeState, syncThemeRuntime, updatePreferences],
  );

  const setTerminalFontSize = useCallback(
    (value: number | null) => {
      updatePreferences({ terminalFontSize: value });
    },
    [updatePreferences],
  );

  const setCodeFontSize = useCallback(
    (value: number | null) => {
      updatePreferences({ codeFontSize: value });
    },
    [updatePreferences],
  );

  const setCodeWordBreak = useCallback(
    (value: boolean) => {
      updatePreferences({ codeWordBreak: value });
    },
    [updatePreferences],
  );

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance,
      themeId,
      themeIds,
      themeMode,
      themeAppearance,
      systemColorsAvailable: isSystemColorsAvailable,
      systemColorsActive,
      themeVariables,
      themeVariablesByAppearance,
      systemColorPalettes,
      isReady,
      setThemeIdForAppearance,
      selectTheme,
      setThemeMode,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
    }),
    [
      appearance,
      themeId,
      themeIds,
      themeMode,
      themeAppearance,
      systemColorsActive,
      themeVariables,
      themeVariablesByAppearance,
      systemColorPalettes,
      isReady,
      setThemeIdForAppearance,
      selectTheme,
      setThemeMode,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
    ],
  );

  return (
    <AppearancePreferencesContext.Provider value={value}>
      <ScopedTheme theme={activeThemeName}>
        <ScopedVariables variables={themeVariables}>{props.children}</ScopedVariables>
      </ScopedTheme>
    </AppearancePreferencesContext.Provider>
  );
}
