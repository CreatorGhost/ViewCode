import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ModelSelection, RuntimeMode, ServerConfig } from "@t3tools/contracts";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { Keyboard } from "react-native";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { ProviderIcon } from "../../components/ProviderIcon";
import { buildModelOptions, groupByProvider, resolveHandoffFromKey } from "../../lib/modelOptions";
import { modelChipLabel, resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "../threads/ThreadSettingsSheet";

/**
 * Uses the thread composer's picker, with choices staged only for what this picks for: a side
 * chat by default, or another reuser such as an agent review naming itself in `title`.
 */
export function SidechatModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
  readonly selection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly sessionInstanceId: string | null;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection) => void;
  /** The settings sheet's title. */
  readonly title?: string;
  readonly accessibilityLabel?: string;
}) {
  const navigation = useNavigation();
  const { present, clear } = useExistingThreadSettingsRoutePresentation();
  const ownerId = useId();
  const presentedRef = useRef(false);
  const modelOptions = useMemo(
    () => buildModelOptions(props.serverConfig, props.selection),
    [props.serverConfig, props.selection],
  );
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const currentModelOption = modelOptions.find(
    (option) =>
      option.selection.instanceId === props.selection.instanceId &&
      option.selection.model === props.selection.model,
  );
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: props.selection.options,
      }),
    [currentModelOption?.capabilities, props.selection.options],
  );
  const { environmentId, selection, runtimeMode, onChange, serverConfig, sessionInstanceId } =
    props;
  const title = props.title ?? "Side chat model";
  const session = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId,
      environmentId,
      providerInstanceId: selection.instanceId,
      providerGroups,
      handoffFromKey: resolveHandoffFromKey(serverConfig, sessionInstanceId),
      selectedModel: selection,
      onSelectModel: (option) => onChange(option.selection),
      optionDescriptors,
      onUpdateOptionSelections: (options) => onChange({ ...selection, options }),
      runtimeMode,
      title,
    }),
    [
      title,
      ownerId,
      environmentId,
      selection,
      providerGroups,
      serverConfig,
      sessionInstanceId,
      onChange,
      optionDescriptors,
      runtimeMode,
    ],
  );
  useEffect(() => {
    if (presentedRef.current) present(session);
  }, [present, session]);
  useFocusEffect(
    useCallback(() => {
      if (!presentedRef.current) return;
      presentedRef.current = false;
      clear(ownerId);
    }, [clear, ownerId]),
  );
  useEffect(() => () => clear(ownerId), [clear, ownerId]);

  return (
    <ComposerInlineControl
      accessibilityLabel={props.accessibilityLabel ?? "Side chat model and reasoning settings"}
      disabled={props.disabled}
      emphasized
      renderIcon={(size) => (
        <ProviderIcon provider={currentModelOption?.providerDriver} size={size} />
      )}
      label={modelChipLabel({
        label: currentModelOption?.label ?? selection.model,
        capabilities: currentModelOption?.capabilities,
        selections: selection.options,
      })}
      maxWidth="100%"
      onPress={() => {
        if (presentedRef.current) return;
        Keyboard.dismiss();
        presentedRef.current = true;
        present(session);
        navigation.dispatch(StackActions.push("ThreadSettingsSheet"));
      }}
    />
  );
}
