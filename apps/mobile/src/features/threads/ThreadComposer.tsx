import type { OrchestrationThreadShell } from "@t3tools/client-runtime/viewcodeThread";

import { ChatGptUsageLimitNotice } from "./ChatGptUsageLimitNotice";
import { NoProviderNotice } from "./NoProviderNotice";
import { isGlassEffectAPIAvailable } from "expo-glass-effect";
import type { ComposerTextPaste } from "../../native/T3ComposerEditor.types";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { pastedTextDisposition, replaceTextSelection } from "@t3tools/client-runtime/text-paste";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig as T3ServerConfig,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  hasProviderUsageLimits,
  isUsageLimitsCommand,
} from "@t3tools/shared/usageLimits";
import type { MenuAction } from "@react-native-menu/menu";
import {
  StackActions,
  useFocusEffect,
  useIsFocused,
  useNavigation,
} from "@react-navigation/native";
import type { ReactNode } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Alert,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  type LayoutAnimationFunction,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { flattenThemeColor, themeColorWithAlpha } from "../../lib/mobileTheme";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  getComposerDraftSnapshot,
  composerDraftsAtom,
  setComposerDraftText,
  composerContextImportsAtom,
  countComposerDraftAttachmentsAfterSelection,
} from "../../state/use-composer-drafts";
import { appAtomRegistry } from "../../state/atom-registry";
import type { ComposerDocumentAttachment } from "../../lib/composerContext";
import { useProject } from "../../state/entities";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
} from "../../components/ComposerAttachmentStrip";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { GlassSurface } from "../../components/GlassSurface";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import { fileRoutePathSegments } from "../files/filePath";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ControlPillMenu } from "../../components/ControlPill";
import {
  composerStripAttachments,
  type DraftComposerAttachment,
  type DraftComposerFileAttachment,
} from "../../lib/composerImages";
import {
  buildModelOptions,
  groupByProvider,
  isModelSelectionUnavailable,
  resolveHandoffFromKey,
} from "../../lib/modelOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { modelChipLabel, resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import { ComposerPopoverAnchor } from "./ComposerPopoverAnchor";
import { ComposerCheckoutStrip } from "./ComposerCheckoutStrip";
import {
  liveRingWedges,
  resolveComposerGlowPaint,
  type ComposerCheckout,
  type ComposerGlowPaint,
} from "./composerChrome";
import { RUNTIME_MODE_CHOICES } from "./thread-settings-options";
import { useComposerCommandMenu } from "./use-composer-command-menu";
import { useThreadGoalActions } from "./useThreadGoalActions";
import { isThreadGoalPaused, parseThreadSlashCommand } from "@t3tools/client-runtime/threadGoal";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = 60;

/**
 * Height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
 * Used by the parent to compute the larger feed bottom inset when the composer is focused.
 */
export const COMPOSER_EXPANDED_CHROME = 156;

export interface ThreadComposerProps {
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  /** The composer is mounted but hidden (a question card owns its slot): no running light. */
  readonly hidden?: boolean;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  readonly selectedThread: OrchestrationThreadShell;
  readonly hasCompactableConversation: boolean;
  readonly serverConfig: T3ServerConfig | null;
  readonly queueCount: number;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  /** Why sending is blocked right now (shown as the send button's label), or null. */
  readonly sendBlockedReason?: string | null;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: () => Promise<MessageId | null>;
  /** `/usage-limits` resolves locally; the host decides where the report shows. Null clears it. */
  readonly onShowUsageLimits: (report: UsageLimitsReport | null) => void;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** Fires on editor focus/blur; hosts use it to vet stale keyboard state. */
  readonly onEditorFocusChange?: (focused: boolean) => void;
  /** A bar glued to the composer's top edge (the Active agents bar). */
  readonly topAccessory?: ReactNode;
  /** Where the thread works, shown in a strip glued under the composer; null hides it. */
  readonly checkout?: ComposerCheckout | null;
  readonly onPressCheckoutBranch?: () => void;
}

/**
 * The pill / card container — renders with Expo's native GlassView on supported
 * iOS 26+ devices, with a frosted blur fallback where supported.
 * Exported so NewTaskDraftScreen can render the same composer chrome.
 */
// The bottom-anchored dock position and clipped surface height use the same
// transition so the card grows upward without exposing its final-size content.
// Android gets NO layout transition: the composer rides the keyboard via
// KeyboardStickyView (frame-synced to the IME), and a time-based morph
// running alongside that translate reads as jitter. Snapping the layout and
// letting the keyboard-synced slide be the only motion looks native there.
export const COMPOSER_TRANSITION_DURATION_MS = 220;
// Side panes already animate the dock's width. Nested horizontal layout
// transitions would leave the surface trailing its toolbar's new position.
// Keep the vertical pill/card morph while horizontal layout follows the dock.
const composerHeightTransition: LayoutAnimationFunction = (values) => {
  "worklet";
  const timing = {
    duration: COMPOSER_TRANSITION_DURATION_MS,
    reduceMotion: ReduceMotion.System,
  };
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, timing),
      width: values.targetWidth,
      height: withTiming(values.targetHeight, timing),
    },
  };
};
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android" ? undefined : composerHeightTransition;

const COMPOSER_ATTACHMENT_ENTERING =
  Platform.OS === "android"
    ? FadeIn.duration(160)
    : FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS).duration(160).reduceMotion(ReduceMotion.System);

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

// The composer surface draws native Liquid Glass here (GlassSurface), which an opaque cover would hide.
const COMPOSER_USES_LIQUID_GLASS = Platform.OS === "ios" && isGlassEffectAPIAvailable();

/** The glow the composer wears while the thread's turn runs. */
export interface ComposerSurfaceGlow {
  readonly paint: ComposerGlowPaint;
  /** The composer's fill made opaque: it covers the running light inside a 2px band. */
  readonly cover: string;
  /**
   * Whether the light circles the edge. Off while the composer is hidden (a question card owns
   * its slot) and over iOS Liquid Glass, whose see-through surface the opaque cover would flatten
   * for the whole turn; the edge and halo still show there.
   */
  readonly running: boolean;
}

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  /** Morphs between the compact and expanded composer layouts. */
  readonly animateLayout?: boolean;
  readonly glow?: ComposerSurfaceGlow | null;
}) {
  const colors = useUniwindTheme();
  const targetBorderRadius =
    typeof props.style.borderRadius === "number" ? props.style.borderRadius : 0;
  const animatedBorderRadius = useSharedValue(targetBorderRadius);
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  useLayoutEffect(() => {
    animatedBorderRadius.value = shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius;
  }, [animatedBorderRadius, shouldAnimate, targetBorderRadius]);
  const animatedShapeStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;
  const glow = props.glow ?? null;

  // Each native frame follows the same transition. Animating only the outer
  // clip leaves the glass and content at their final height on the first frame.
  // The unclipped wrapper is always there (never only while glowing) so the
  // composer's content never remounts when a turn starts.
  return (
    <Animated.View layout={layoutTransition}>
      {/* The halo: rings outside the edge, fading outward. Static, so they cost
          nothing per frame. */}
      {glow
        ? glow.paint.halo.map((band) => (
            <Animated.View
              key={band.offset}
              layout={layoutTransition}
              pointerEvents="none"
              style={{
                position: "absolute",
                top: -band.offset,
                right: -band.offset,
                bottom: -band.offset,
                left: -band.offset,
                borderRadius: targetBorderRadius + band.offset,
                borderWidth: band.width,
                borderColor: band.color,
              }}
            />
          ))
        : null}
      <Animated.View
        className={
          Platform.OS === "android"
            ? undefined
            : "shadow-[0_6px_28px] shadow-adaptive-black-a15-a35"
        }
        layout={layoutTransition}
        style={[
          animatedShapeStyle,
          {
            overflow: "hidden",
          },
        ]}
      >
        <AnimatedGlassSurface
          chrome="none"
          fallbackColor={colors["--color-composer-surface"]}
          fallbackClassName="border border-composer-border"
          glassEffectStyle="regular"
          // The composer is a passive material containing interactive controls.
          // Keep native glass out of the interactive content's layout path.
          pointerEvents="none"
          tintColor="transparent"
          layout={layoutTransition}
          style={[{ position: "absolute", inset: 0 }, animatedShapeStyle]}
        >
          {null}
        </AnimatedGlassSurface>
        {glow?.running ? (
          <ComposerLiveRing
            color={glow.paint.color}
            cover={glow.cover}
            borderRadius={animatedBorderRadius}
            layoutTransition={layoutTransition}
          />
        ) : null}
        <Animated.View
          collapsable={false}
          layout={layoutTransition}
          style={[props.style, animatedShapeStyle]}
        >
          {props.children}
        </Animated.View>
        {glow ? (
          <Animated.View
            layout={layoutTransition}
            pointerEvents="none"
            style={[
              { position: "absolute", inset: 0, borderWidth: 1, borderColor: glow.paint.border },
              animatedShapeStyle,
            ]}
          />
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

const LIVE_RING_PERIOD_MS = 3200;
const LIVE_RING_BAND = 2;

/** One wedge of the unit circle, clockwise from the top, for a `-1 -1 2 2` viewBox. */
function liveRingWedgePath(from: number, to: number): string {
  const point = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return `${Math.sin(radians).toFixed(4)} ${(-Math.cos(radians)).toFixed(4)}`;
  };
  return `M0 0 L${point(from)} A1 1 0 0 1 ${point(to)} Z`;
}

/**
 * Web's "Agent live" light, circling the composer's edge while a turn runs: a
 * conic sweep drawn once as SVG wedges and spun with a Reanimated transform on
 * the UI thread, under an opaque cover that leaves a 2px band. Nothing is
 * redrawn per frame. Off under reduced motion (the static glow remains) and
 * paused while another screen covers the thread.
 */
function ComposerLiveRing(props: {
  readonly color: string;
  readonly cover: string;
  readonly borderRadius: SharedValue<number>;
  readonly layoutTransition: LayoutAnimationFunction | undefined;
}) {
  const reducedMotion = useReducedMotion();
  const screenIsFocused = useIsFocused();
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  const rotation = useSharedValue(0);
  const { borderRadius } = props;
  const spins = !reducedMotion && screenIsFocused && size !== null;

  useEffect(() => {
    if (!spins) return;
    rotation.value = withRepeat(
      withTiming(rotation.value + 360, {
        duration: LIVE_RING_PERIOD_MS,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(rotation);
  }, [rotation, spins]);

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  const coverStyle = useAnimatedStyle(() => ({
    borderRadius: Math.max(0, borderRadius.value - LIVE_RING_BAND),
  }));
  const wedges = useMemo(() => liveRingWedges(props.color), [props.color]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current?.width === width && current.height === height ? current : { width, height },
    );
  }, []);

  if (reducedMotion) return null;
  // Large enough that the sweep reaches every corner of the composer.
  const radius = size ? Math.ceil(Math.hypot(size.width, size.height) / 2) + LIVE_RING_BAND : 0;
  return (
    <>
      <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
        {size ? (
          <Animated.View
            style={[
              {
                position: "absolute",
                left: size.width / 2 - radius,
                top: size.height / 2 - radius,
                width: radius * 2,
                height: radius * 2,
              },
              spinStyle,
            ]}
          >
            <Svg width={radius * 2} height={radius * 2} viewBox="-1 -1 2 2">
              {wedges.map((wedge) => (
                <Path
                  key={wedge.from}
                  d={liveRingWedgePath(wedge.from, wedge.to)}
                  fill={wedge.color}
                />
              ))}
            </Svg>
          </Animated.View>
        ) : null}
      </View>
      <Animated.View
        layout={props.layoutTransition}
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            inset: LIVE_RING_BAND,
            backgroundColor: props.cover,
          },
          coverStyle,
        ]}
      />
    </>
  );
}

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const project = useProject(scopeProjectRef(props.environmentId, props.selectedThread.projectId));
  const { themeVariables: materialTheme, themeAppearance } = useAppearancePreferences();
  const composerPanel = materialTheme["--color-composer-panel"];
  const navigation = useNavigation();
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const pendingPastedTextAttachmentCountRef = useRef(0);
  const [pendingPastedTextAttachmentCount, setPendingPastedTextAttachmentCount] = useState(0);
  const settingsSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: inputRef,
    isEditorFocused: isFocused,
  });
  const settingsRoutePresentation = useExistingThreadSettingsRoutePresentation();
  const settingsRoutePresentedRef = useRef(false);
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());
  const { onExpandedChange } = props;

  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0;
  // Only media belongs above the composer; every other file reads as its inline chip.
  const stripAttachments = useMemo(
    () => composerStripAttachments(props.draftAttachments),
    [props.draftAttachments],
  );
  const isTurnRunning =
    props.selectedThread.session?.status === "running" ||
    props.selectedThread.session?.status === "starting";
  const showStopAction = !hasContent && isTurnRunning;
  const projectColor = project?.projectColor ?? null;
  const glowAccent = materialTheme["--color-focus"];
  const glowSurface = materialTheme["--color-screen"];
  const composerSurfaceColor = materialTheme["--color-composer-surface"];
  const glow = useMemo<ComposerSurfaceGlow | null>(
    () =>
      isTurnRunning
        ? {
            paint: resolveComposerGlowPaint({
              projectColor,
              appearance: themeAppearance,
              accentColor: glowAccent,
              surfaceColor: glowSurface,
            }),
            // Matches GlassBackdrop's fill: opaque on Android, over the screen on iOS.
            cover:
              Platform.OS === "android"
                ? themeColorWithAlpha(composerSurfaceColor, 1)
                : flattenThemeColor(composerSurfaceColor, glowSurface),
            running: !props.hidden && !COMPOSER_USES_LIQUID_GLASS,
          }
        : null,
    [
      composerSurfaceColor,
      glowAccent,
      glowSurface,
      isTurnRunning,
      projectColor,
      props.hidden,
      themeAppearance,
    ],
  );

  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentsUploading =
    props.connectionState === "connected" &&
    composerAttachmentsStillUploading({
      environmentId: props.environmentId,
      attachments: props.draftAttachments,
      serverConfig: props.serverConfig,
      states: uploadStates,
    });
  // Every send goes through the outbox; the label says whether it leaves now
  // or waits (for the connection, an earlier queued message, or an upload).
  const sendLabel =
    props.connectionState !== "connected" || props.queueCount > 0 || attachmentsUploading
      ? "Queue"
      : "Send";
  const currentModelSelection = props.selectedThread.modelSelection;
  const currentRuntimeMode = props.selectedThread.runtimeMode;
  const modelUnavailable =
    props.connectionState === "connected" &&
    isModelSelectionUnavailable(
      props.serverConfig,
      currentModelSelection,
      props.selectedThread.projectId,
    );
  const selectedProviderStatus = useMemo(() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  }, [props.serverConfig, props.selectedThread.modelSelection.instanceId]);
  const composerOwnerKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const openDraftDocument = (attachment: ComposerDocumentAttachment) => {
    Keyboard.dismiss();
    navigation.navigate("ThreadAttachment", {
      environmentId: String(props.environmentId),
      threadId: String(props.selectedThread.id),
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: String(attachment.sizeBytes),
      draftKey: composerOwnerKey,
    });
  };
  const { onSendMessage, onChangeDraftMessage, onShowUsageLimits } = props;
  const interactionModeOffered = selectedProviderStatus?.showInteractionModeToggle !== false;
  const threadGoal = useThreadGoalActions({
    environmentId: props.environmentId,
    thread: props.selectedThread,
    ...(interactionModeOffered ? { onUpdateInteractionMode: props.onUpdateInteractionMode } : {}),
  });
  const { applyGoalAction, applyThreadCommand } = threadGoal;
  // T3 owns /usage-limits only where Limits has data for the selected provider;
  // elsewhere the name stays the provider's own and is sent through untouched.
  const usageLimitsOffered =
    selectedProviderStatus !== null &&
    hasProviderUsageLimits(
      selectedProviderStatus.driver,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
    );
  // Answered locally from the last Limits snapshot; the agent never sees it.
  const openUsageLimits = useCallback(() => {
    const report = collectProviderUsageLimits(
      currentModelSelection.instanceId,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
      Date.now(),
    );
    onShowUsageLimits(report);
    if (!report) {
      Alert.alert("Usage limits unavailable", "This provider does not currently report limits.");
    }
    return report !== null;
  }, [currentModelSelection.instanceId, onShowUsageLimits, props.serverConfig]);

  const composerMenu = useComposerCommandMenu({
    draftMessage: props.draftMessage,
    ownerKey: composerOwnerKey,
    environmentId: props.environmentId,
    projectCwd: props.projectCwd,
    pullRequestProjectId: props.serverConfig?.environment.capabilities.pullRequests
      ? (project?.id ?? null)
      : null,
    pullRequestRepository: project?.repositoryIdentity?.displayName ?? null,
    selectedProviderStatus,
    hasThread: true,
    hasCompactableConversation: props.hasCompactableConversation,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onUpdateInteractionMode:
      selectedProviderStatus?.showInteractionModeToggle === false
        ? undefined
        : props.onUpdateInteractionMode,
    offersUsageLimits: usageLimitsOffered,
    onThreadCommand: threadGoal.applyThreadCommand,
    // With attachments aboard the pick just inserts the text, so it sends as a prompt.
    onUsageLimits:
      usageLimitsOffered && props.draftAttachments.length === 0 ? openUsageLimits : undefined,
  });
  const voiceInput = useVoiceInputController({
    ownerKey: composerOwnerKey,
    label: props.selectedThread.title || "Untitled thread",
    thread: { environmentId: props.environmentId, threadId: props.selectedThread.id },
    readDraftMessage: () => getComposerDraftSnapshot(composerOwnerKey).text,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    selection: composerMenu.selection,
    onChangeDraftMessage: (text) => setComposerDraftText(composerOwnerKey, text),
    onChangeSelection: composerMenu.onSelectionChange,
  });
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isVoiceInputPresented = voicePresentation.statusLabel !== null;
  // An open draft stays visible; only a collapsed composer becomes a voice strip.
  const isExpanded = isFocused || settingsSheetPresentation.keepsComposerExpanded;
  const showsCompactDictation = isVoiceInputPresented && !isExpanded;
  const isToolbarVisible = isExpanded || isVoiceInputPresented;
  const attachmentBlockReason = composerAttachmentUploadBlockReason({
    environmentId: props.environmentId,
    attachments: props.draftAttachments,
    connected: props.connectionState === "connected",
    serverConfig: props.serverConfig,
    states: uploadStates,
  });
  const contextImports = useAtomValue(composerContextImportsAtom);
  const sendBlockedReason =
    props.sendBlockedReason ??
    (pendingPastedTextAttachmentCount > 0 ? "Attaching pasted text" : null) ??
    attachmentBlockReason;
  const canSend =
    hasContent &&
    !contextImports[composerOwnerKey] &&
    !voiceInput.blocksSubmission &&
    sendBlockedReason === null &&
    !modelUnavailable;

  // Keep the feed inset aligned with the card or compact dictation strip.
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onPressPreview = useCallback(
    (source: FilePreviewSource) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewVideo(null);
      setPreviewFile((current) => current ?? source);
    },
    [isFocused],
  );

  const closePreview = useCallback(() => {
    setPreviewFile(null);
    setPreviewVideo(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => {
        if (navigation.isFocused()) inputRef.current?.focus();
      }, 100);
    }
  }, [inputRef, navigation]);

  const onPressVideo = useCallback(
    (attachment: DraftComposerFileAttachment, sourceIdentifier: string) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewFile(null);
      setPreviewVideo((current) => current ?? { type: "local", attachment, sourceIdentifier });
    },
    [isFocused],
  );

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onExpandedChange?.(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange, onExpandedChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    if (!settingsSheetPresentation.keepsComposerExpanded) {
      onExpandedChange?.(false);
    }
    onEditorFocusChange?.(false);
  }, [onEditorFocusChange, onExpandedChange, settingsSheetPresentation.keepsComposerExpanded]);
  const handleSend = useCallback(async () => {
    if (voiceInput.blocksSubmission || pendingPastedTextAttachmentCountRef.current > 0) return;
    // ViewCode's own thread commands change the thread; nothing is sent.
    const threadCommand =
      props.draftAttachments.length === 0 ? parseThreadSlashCommand(props.draftMessage) : null;
    if (threadCommand) {
      if (threadCommand.command === "goal") applyGoalAction(threadCommand.goal);
      else applyThreadCommand(threadCommand.command);
      onChangeDraftMessage("");
      return;
    }
    // Typed out in full rather than picked from the menu. Attachments mean the
    // user is sending a prompt, so those go through as usual.
    if (
      usageLimitsOffered &&
      isUsageLimitsCommand(props.draftMessage) &&
      props.draftAttachments.length === 0
    ) {
      if (openUsageLimits()) onChangeDraftMessage("");
      return;
    }
    const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
    if (inFlightThreadIdsRef.current.has(threadKey)) return;
    inFlightThreadIdsRef.current.add(threadKey);
    try {
      const messageId = await onSendMessage();
      if (messageId === null) {
        return;
      }
    } finally {
      inFlightThreadIdsRef.current.delete(threadKey);
    }
  }, [
    props.draftMessage,
    props.draftAttachments.length,
    onChangeDraftMessage,
    openUsageLimits,
    usageLimitsOffered,
    onSendMessage,
    props.environmentId,
    props.environmentLabel,
    props.selectedThread.id,
    props.selectedThread.title,
    applyGoalAction,
    applyThreadCommand,
    voiceInput.blocksSubmission,
  ]);

  // ── Model menu ───────────────────────────────────────────
  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        props.serverConfig,
        currentModelSelection,
        undefined,
        props.selectedThread.projectId,
      ),
    [props.serverConfig, currentModelSelection, props.selectedThread.projectId],
  );
  // ViewCode never locks a started thread to its provider (as on web): every
  // enabled provider is offered, and a model outside the native session's
  // continuation group hands the chat off on the next turn.
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const handoffFromKey = useMemo(
    () =>
      resolveHandoffFromKey(props.serverConfig, props.selectedThread.session?.providerInstanceId),
    [props.serverConfig, props.selectedThread.session?.providerInstanceId],
  );
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;
  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: currentModelSelection.options,
      }),
    [currentModelOption?.capabilities, currentModelSelection.options],
  );
  const settingsOwnerId = composerOwnerKey;
  const settingsRouteSession = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: settingsOwnerId,
      environmentId: props.environmentId,
      providerInstanceId: currentModelSelection.instanceId,
      providerGroups,
      handoffFromKey,
      selectedModel: currentModelSelection,
      onSelectModel: (option) => props.onUpdateModelSelection(option.selection),
      optionDescriptors: providerOptionDescriptors,
      onUpdateOptionSelections: (options) =>
        props.onUpdateModelSelection({ ...currentModelSelection, options }),
      runtimeMode: currentRuntimeMode,
      onUpdateRuntimeMode: props.onUpdateRuntimeMode,
    }),
    [
      currentModelSelection,
      currentRuntimeMode,
      props.onUpdateModelSelection,
      props.onUpdateRuntimeMode,
      providerOptionDescriptors,
      settingsOwnerId,
      providerGroups,
      handoffFromKey,
    ],
  );
  const openSettings = useCallback(() => {
    settingsRoutePresentation.present(settingsRouteSession);
    settingsSheetPresentation.open();
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.open]);

  // ── Access (runtime mode) chip ───────────────────────────
  const runtimeModeLabel =
    RUNTIME_MODE_CHOICES.find((choice) => choice.mode === currentRuntimeMode)?.label ??
    currentRuntimeMode;
  const runtimeModeActions = useMemo<MenuAction[]>(
    () =>
      RUNTIME_MODE_CHOICES.map((choice) => ({
        id: choice.mode,
        title: choice.label,
        state: choice.mode === currentRuntimeMode ? "on" : "off",
      })),
    [currentRuntimeMode],
  );
  const { onUpdateRuntimeMode } = props;
  const onPressRuntimeModeAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const choice = RUNTIME_MODE_CHOICES.find((candidate) => candidate.mode === nativeEvent.event);
      if (choice && choice.mode !== currentRuntimeMode) onUpdateRuntimeMode(choice.mode);
    },
    [currentRuntimeMode, onUpdateRuntimeMode],
  );

  useEffect(() => {
    if (settingsSheetPresentation.isActive) {
      settingsRoutePresentation.present(settingsRouteSession);
    }
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.isActive]);

  useEffect(() => {
    if (!settingsSheetPresentation.isVisible || settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = true;
    navigation.dispatch(StackActions.push("ThreadSettingsSheet"));
  }, [navigation, settingsSheetPresentation.isVisible]);

  useFocusEffect(
    useCallback(() => {
      if (!settingsRoutePresentedRef.current) {
        return;
      }

      settingsRoutePresentedRef.current = false;
      settingsSheetPresentation.onDismissed();
      settingsRoutePresentation.clear(settingsOwnerId);
    }, [settingsOwnerId, settingsRoutePresentation.clear, settingsSheetPresentation.onDismissed]),
  );

  useEffect(
    () =>
      // UIKit's completion callback for the sheet dismissal, surfaced by the
      // native-stack patch. This is when the queued keyboard restore runs.
      (navigation as unknown as NavigationWithFinishTransitioning).addListener(
        "finishTransitioning",
        settingsSheetPresentation.onStackTransitionsFinished,
      ),
    [navigation, settingsSheetPresentation.onStackTransitionsFinished],
  );

  return (
    <Animated.View
      className="px-[12px]"
      style={{
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
        backgroundColor:
          Platform.OS === "android" ? themeColorWithAlpha(composerPanel, 1) : undefined,
      }}
    >
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          silently drops experimental_backgroundImage on Android, which left this
          strip fully transparent and the feed text legible through the composer. */}
      <View
        className={
          Platform.OS === "android"
            ? "hidden"
            : "absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        }
        pointerEvents="none"
      />
      <Animated.View
        className="relative w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        <ChatGptUsageLimitNotice
          environmentId={props.environmentId}
          thread={props.selectedThread}
        />
        <NoProviderNotice environmentId={props.environmentId} />
        {!voiceInput.isBusy &&
        composerMenu.trigger &&
        (composerMenu.items.length > 0 || composerMenu.trigger.kind === "pull-request") ? (
          <ComposerPopoverAnchor>
            <ComposerCommandPopover
              items={composerMenu.items}
              triggerKind={composerMenu.trigger.kind}
              isLoading={composerMenu.isLoading}
              error={composerMenu.error}
              onSelect={composerMenu.onSelect}
            />
          </ComposerPopoverAnchor>
        ) : null}

        {selectedProviderStatus?.compatibilityAdvisory?.message &&
        (selectedProviderStatus.compatibilityAdvisory.status === "unsupported" ||
          selectedProviderStatus.compatibilityAdvisory.status === "broken") ? (
          <Text
            accessibilityRole={
              selectedProviderStatus.compatibilityAdvisory.status === "broken" ? "alert" : undefined
            }
            accessibilityLiveRegion={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "assertive"
                : "polite"
            }
            className={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "bg-danger px-3 py-2 text-xs text-danger-foreground"
                : "px-3 py-2 text-xs text-foreground"
            }
          >
            {selectedProviderStatus.compatibilityAdvisory.message}
          </Text>
        ) : null}
        {modelUnavailable ? (
          <Pressable accessibilityRole="button" className="px-3 py-2" onPress={openSettings}>
            <Text className="text-xs text-foreground">Model unavailable. Open model settings.</Text>
          </Pressable>
        ) : null}

        {props.topAccessory ? (
          // Above the glow's halo, like the checkout strip below: the glow
          // wraps the composer around its glued bars, not over them.
          <Animated.View layout={COMPOSER_LAYOUT_TRANSITION} style={{ zIndex: 1 }}>
            {props.topAccessory}
          </Animated.View>
        ) : null}
        <ComposerSurface
          glow={glow}
          style={
            isExpanded
              ? {
                  borderRadius: 22,
                  minHeight: 140,
                  overflow: "hidden" as const,
                  paddingBottom: 6,
                  paddingTop: 14,
                }
              : {
                  // Keep the numeric radius close to the expanded card so the
                  // shape morph stays bounded while rendering as a capsule.
                  borderRadius: 24,
                  overflow: "hidden" as const,
                  paddingVertical: 2,
                }
          }
        >
          <ComposerDictationDraftContent
            className={isExpanded ? undefined : "flex-row items-center"}
            compact={!isExpanded}
            hidden={showsCompactDictation}
          >
            {!isExpanded ? (
              <ComposerAttachmentButton
                supportsFiles={Boolean(
                  props.serverConfig?.environment.capabilities.fileAttachments,
                )}
                onPickMedia={props.onPickDraftMedia}
                onPickFiles={props.onPickDraftFiles}
              />
            ) : null}
            {isExpanded && stripAttachments.length > 0 ? (
              <Animated.View
                className="px-[14px] pb-2.5"
                entering={COMPOSER_ATTACHMENT_ENTERING}
                exiting={FadeOut.duration(120)}
              >
                <ComposerAttachmentStrip
                  environmentId={props.environmentId}
                  attachments={stripAttachments}
                  onRemove={voiceInput.isBusy ? () => undefined : props.onRemoveDraftImage}
                  onPressPreview={voiceInput.isBusy ? undefined : onPressPreview}
                  onPressVideo={voiceInput.isBusy ? undefined : onPressVideo}
                  onPressDocument={
                    voiceInput.isBusy
                      ? undefined
                      : (attachment) =>
                          openDraftDocument({
                            attachmentId: attachment.id,
                            name: attachment.name,
                            mimeType: attachment.mimeType,
                            sizeBytes: attachment.sizeBytes,
                          })
                  }
                />
              </Animated.View>
            ) : null}
            <Animated.View
              className={isExpanded ? "px-[14px]" : "min-w-0 flex-1 px-[4px]"}
              layout={COMPOSER_LAYOUT_TRANSITION}
            >
              <ComposerEditor
                draftKey={composerOwnerKey}
                environmentId={props.environmentId}
                onOpenMention={(path) => {
                  Keyboard.dismiss();
                  navigation.navigate("ThreadFile", {
                    environmentId: String(props.environmentId),
                    threadId: String(props.selectedThread.id),
                    path: fileRoutePathSegments(path),
                  });
                }}
                onOpenAttachment={openDraftDocument}
                // A rested composer full of chips left almost nowhere to tap to start typing:
                // every chip opened its file instead. Collapsed, they focus the editor.
                chipsInert={!isExpanded}
                onInertChipPress={() => inputRef.current?.focus()}
                ref={inputRef}
                multiline
                value={props.draftMessage}
                readOnly={voiceInput.freezesEditor}
                skills={composerMenu.skills}
                selection={composerMenu.selection}
                onChangeText={props.onChangeDraftMessage}
                onSelectionChange={composerMenu.onSelectionChange}
                onPasteImages={(uris) => void props.onNativePasteImages(uris)}
                onPasteText={(paste) => {
                  const insertPaste = () => {
                    const insertion = replaceTextSelection({
                      value: paste.value,
                      selection: paste.selection,
                      text: paste.text,
                    });
                    const selection = { start: insertion.cursor, end: insertion.cursor };
                    props.onChangeDraftMessage(insertion.value);
                    composerMenu.onSelectionChange(selection);
                  };
                  const capabilities = props.serverConfig?.environment.capabilities;
                  const advertisedMax =
                    capabilities?.attachmentUploads === true
                      ? capabilities.fileAttachments?.maxUploadBytes
                      : undefined;
                  const maxBytes =
                    advertisedMax === undefined
                      ? null
                      : clampFileAttachmentUploadBytes(advertisedMax);
                  const wouldExceedInputLimit =
                    paste.value.length -
                      Math.max(0, paste.selection.end - paste.selection.start) +
                      paste.text.length >
                    PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
                  const canAttach =
                    maxBytes !== null &&
                    countComposerDraftAttachmentsAfterSelection(composerOwnerKey, {
                      text: paste.value,
                      ...paste.selection,
                    }) < PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
                    new TextEncoder().encode(paste.text).byteLength <= maxBytes;
                  if (
                    pastedTextDisposition({
                      text: paste.text,
                      wouldExceedInputLimit,
                      canAttach: true,
                    }) === "attachment"
                  ) {
                    if (canAttach) {
                      pendingPastedTextAttachmentCountRef.current += 1;
                      setPendingPastedTextAttachmentCount(
                        pendingPastedTextAttachmentCountRef.current,
                      );
                      const finishAttachment = () => {
                        pendingPastedTextAttachmentCountRef.current = Math.max(
                          0,
                          pendingPastedTextAttachmentCountRef.current - 1,
                        );
                        setPendingPastedTextAttachmentCount(
                          pendingPastedTextAttachmentCountRef.current,
                        );
                      };
                      void props.onNativePasteText(paste).then(finishAttachment, finishAttachment);
                    } else if (!wouldExceedInputLimit) {
                      insertPaste();
                    } else {
                      Alert.alert(
                        wouldExceedInputLimit
                          ? "Pasted text is too large for this message"
                          : "Could not attach pasted text",
                        wouldExceedInputLimit
                          ? "Remove some text or an attachment, then paste again."
                          : "Remove an attachment or use a smaller paste, then try again.",
                      );
                    }
                    return;
                  }
                  insertPaste();
                }}
                placeholder={props.placeholder}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onSubmit={handleSend}
                scrollEnabled={isExpanded}
                // Android: collapsed single line centers natively (gravity) in
                // a pill-height box matching the send button; iOS keeps insets.
                singleLineCentered={!isExpanded}
                contentInsetVertical={isExpanded || Platform.OS === "android" ? 0 : 6}
                style={
                  isExpanded
                    ? {
                        minHeight: 72,
                        maxHeight: 160,
                        paddingVertical: 4,
                      }
                    : {
                        height: 36,
                      }
                }
                textStyle={{
                  ...bodyText,
                  color: foregroundColor,
                }}
              />
            </Animated.View>
            {!isExpanded && stripAttachments.length > 0 ? (
              <View className="flex-row gap-1 pl-1">
                {stripAttachments.slice(0, 3).map((attachment) => (
                  <ComposerAttachmentThumbnail
                    environmentId={props.environmentId}
                    key={attachment.id}
                    attachment={attachment}
                    size={30}
                    borderRadius={8}
                    compact
                    onPressPreview={onPressPreview}
                    onPressVideo={onPressVideo}
                  />
                ))}
                {stripAttachments.length > 3 ? (
                  <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                    <Text className="text-foreground-muted text-2xs font-t3-bold">
                      +{stripAttachments.length - 3}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {!isExpanded ? (
              <View className="flex-row items-center">
                <ComposerDictationStartAction
                  state={voiceInput.state}
                  isAvailable={voiceInput.isAvailable}
                  onStart={voiceInput.start}
                  onCancel={voiceInput.cancel}
                />
                {showStopAction ? (
                  <ComposerActionButton
                    accessibilityLabel="Stop agent"
                    icon="stop.fill"
                    variant="danger"
                    onPress={props.onStopThread}
                  />
                ) : (
                  <ComposerActionButton
                    accessibilityLabel={sendBlockedReason ?? sendLabel}
                    icon="arrow.up"
                    variant="primary"
                    disabled={!canSend}
                    onPress={handleSend}
                  />
                )}
              </View>
            ) : null}
            {isExpanded ? <View className="h-1" /> : null}
          </ComposerDictationDraftContent>
          <Animated.View
            accessibilityElementsHidden={!isToolbarVisible}
            collapsable={false}
            importantForAccessibility={isToolbarVisible ? "auto" : "no-hide-descendants"}
            layout={COMPOSER_LAYOUT_TRANSITION}
            pointerEvents={isToolbarVisible ? "auto" : "none"}
            style={
              isExpanded
                ? undefined
                : {
                    position: "absolute",
                    bottom: 2,
                    left: 0,
                    right: 0,
                  }
            }
          >
            <ComposerDictationToolbar
              showsDictation={isVoiceInputPresented}
              visible={isToolbarVisible}
            >
              <ComposerToolbarRow
                paddingBottom={0}
                paddingHorizontal={0}
                paddingTop={0}
                style={{ gap: 0 }}
              >
                <ComposerDictationCancelAction
                  presentation={voicePresentation}
                  onCancel={voiceInput.cancel}
                />
                {isVoiceInputPresented ? (
                  <ComposerDictationStatus
                    audioLevels={voiceInput.audioLevels}
                    elapsedSeconds={voiceInput.elapsedSeconds}
                    phase={voiceInput.state.phase}
                    presentation={voicePresentation}
                    onDismissError={voiceInput.cancel}
                  />
                ) : (
                  <View className="min-w-0 flex-1 flex-row items-center">
                    <ComposerAttachmentButton
                      supportsFiles={Boolean(
                        props.serverConfig?.environment.capabilities.fileAttachments,
                      )}
                      onPickMedia={props.onPickDraftMedia}
                      onPickFiles={props.onPickDraftFiles}
                    />
                    <ControlPillMenu
                      accessible
                      accessibilityLabel={`Access: ${runtimeModeLabel}`}
                      accessibilityRole="button"
                      actions={runtimeModeActions}
                      onPressAction={onPressRuntimeModeAction}
                      style={{ flexShrink: 1 }}
                    >
                      <ComposerInlineControl
                        accessibilityLabel={`Access: ${runtimeModeLabel}`}
                        dense
                        icon="shield"
                        label={runtimeModeLabel}
                        maxWidth={128}
                        showChevron={false}
                        tone={currentRuntimeMode === "full-access" ? "warning" : undefined}
                      />
                    </ControlPillMenu>
                    <View className="min-w-0 shrink flex-row items-center">
                      <ComposerInlineControl
                        accessibilityLabel="Model and reasoning settings"
                        filled
                        renderIcon={(size) => (
                          <ProviderIcon provider={currentModelOption?.providerDriver} size={size} />
                        )}
                        label={modelChipLabel({
                          label: currentModelOption?.label ?? currentModelSelection.model,
                          capabilities: currentModelOption?.capabilities,
                          selections: currentModelSelection.options,
                        })}
                        maxWidth="100%"
                        onPress={openSettings}
                      />
                      {threadGoal.goal !== null ? (
                        <ComposerInlineControl
                          accessibilityLabel={`Goal: ${threadGoal.goal.objective}`}
                          icon="target"
                          label={isThreadGoalPaused(threadGoal.goal) ? "Paused" : "Goal"}
                          onPress={threadGoal.openGoalActions}
                        />
                      ) : null}
                      {threadGoal.debugMode ? (
                        <ComposerInlineControl
                          accessibilityLabel="Debug mode is on"
                          accessibilityHint="Leave debug mode"
                          icon="ant"
                          label="Debug"
                          selected
                          onPress={threadGoal.confirmLeaveDebugMode}
                        />
                      ) : null}
                    </View>
                  </View>
                )}
                <View className="shrink-0 flex-row items-center">
                  <ComposerDictationPrimaryAction
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                  {showStopAction ? (
                    <ComposerActionButton
                      accessibilityLabel="Stop agent"
                      icon="stop.fill"
                      variant="danger"
                      onPress={props.onStopThread}
                    />
                  ) : voicePresentation.showsSend ? (
                    <ComposerActionButton
                      accessibilityLabel={sendBlockedReason ?? sendLabel}
                      icon="arrow.up"
                      variant="primary"
                      disabled={!canSend}
                      onPress={handleSend}
                    />
                  ) : null}
                </View>
              </ComposerToolbarRow>
            </ComposerDictationToolbar>
          </Animated.View>
        </ComposerSurface>
        {props.checkout ? (
          <ComposerCheckoutStrip
            checkout={props.checkout}
            onPressBranch={props.onPressCheckoutBranch}
          />
        ) : null}
      </Animated.View>

      <VideoPreviewModal source={previewVideo} onRequestClose={closePreview} />
      <FilePreviewModal source={previewFile} onRequestClose={closePreview} />
    </Animated.View>
  );
});
