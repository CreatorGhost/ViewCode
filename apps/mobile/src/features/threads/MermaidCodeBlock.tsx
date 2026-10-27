import { useMemo, useState, type ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useAppearancePreferences } from "../../lib/appearancePreferencesContext";
import {
  mermaidRenderHtml,
  mermaidStaticHtml,
  readMermaidMessage,
  type MermaidColors,
} from "./mermaidDiagram";

type Rendered = { readonly svg: string; readonly height: number };

// Feed rows unmount as they scroll away; a diagram renders once per source and theme.
// ponytail: unbounded per session, a few KB per diagram; add LRU eviction if chats get huge.
const renderedDiagrams = new Map<string, Rendered | "failed">();

function useMermaidColors(): MermaidColors {
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  return useMemo(
    () => ({
      dark: themeAppearance === "dark",
      canvas: themeVariables["--color-card"],
      surface: themeVariables["--color-subtle"],
      text: themeVariables["--color-foreground"],
      muted: themeVariables["--color-foreground-muted"],
      border: themeVariables["--color-border"],
    }),
    [themeAppearance, themeVariables],
  );
}

/** The app's `renderCodeBlock` for chat markdown: mermaid fences become diagrams. */
export function renderMarkdownCodeBlock(
  block: { readonly language: string; readonly code: string },
  fallback: ReactNode,
) {
  return block.language.toLowerCase() === "mermaid" ? (
    <MermaidCodeBlock code={block.code} fallback={fallback} />
  ) : (
    fallback
  );
}

/** A finished ```mermaid block drawn as a diagram; tap for full screen. Falls back to the code. */
export function MermaidCodeBlock(props: { readonly code: string; readonly fallback: ReactNode }) {
  const colors = useMermaidColors();
  const key = `${JSON.stringify(colors)}\0${props.code}`;
  const [, setRevision] = useState(0);
  const [fullScreen, setFullScreen] = useState(false);
  const result = renderedDiagrams.get(key);

  if (result === "failed") return props.fallback;

  const onMessage = (event: WebViewMessageEvent) => {
    const message = readMermaidMessage(event.nativeEvent.data);
    if (message === null || renderedDiagrams.get(key) !== undefined) return;
    renderedDiagrams.set(
      key,
      message.type === "rendered" ? { svg: message.svg, height: message.height } : "failed",
    );
    setRevision((value) => value + 1);
  };

  if (result === undefined) {
    // The code stays on screen while the diagram renders off to the side.
    return (
      <View>
        {props.fallback}
        <View
          pointerEvents="none"
          style={{ position: "absolute", width: "100%", height: 1, opacity: 0, overflow: "hidden" }}
        >
          <WebView
            source={{ html: mermaidRenderHtml(props.code, colors) }}
            originWhitelist={["*"]}
            onMessage={onMessage}
            onError={() => {
              renderedDiagrams.set(key, "failed");
              setRevision((value) => value + 1);
            }}
            // Mermaid loads as a subresource; the page itself never navigates.
            onShouldStartLoadWithRequest={(request) => /^(about|data):/.test(request.url)}
            style={{ height: 800, backgroundColor: "transparent" }}
          />
        </View>
      </View>
    );
  }

  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel="Diagram"
        accessibilityHint="Opens the diagram full screen"
        className="overflow-hidden rounded-[10px] border border-border bg-card active:opacity-80"
        onPress={() => setFullScreen(true)}
      >
        <View className="min-h-[42px] flex-row items-center justify-between border-b border-border pr-3.5 pl-3.5">
          <Text className="font-mono text-xs text-foreground-muted">DIAGRAM</Text>
          <SymbolView
            name="arrow.up.left.and.arrow.down.right"
            size={13}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
        </View>
        <View pointerEvents="none" className="m-3" style={{ height: result.height }}>
          <WebView
            source={{
              html: mermaidStaticHtml(result.svg, { background: colors.canvas, zoomable: false }),
            }}
            originWhitelist={["*"]}
            javaScriptEnabled={false}
            scrollEnabled={false}
            style={{ flex: 1, backgroundColor: "transparent" }}
          />
        </View>
      </Pressable>
      {fullScreen ? (
        <MermaidFullScreen svg={result.svg} colors={colors} onClose={() => setFullScreen(false)} />
      ) : null}
    </>
  );
}

function MermaidFullScreen(props: {
  readonly svg: string;
  readonly colors: MermaidColors;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="fade" onRequestClose={props.onClose} statusBarTranslucent>
      <View
        className="flex-1 bg-card"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="flex-row items-center justify-between px-4 py-2">
          <Text className="text-sm text-foreground-muted">Pinch to zoom</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close diagram"
            className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
            onPress={props.onClose}
          >
            <SymbolView
              name="xmark"
              size={16}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>
        </View>
        <WebView
          source={{
            html: mermaidStaticHtml(props.svg, { background: props.colors.canvas, zoomable: true }),
          }}
          originWhitelist={["*"]}
          javaScriptEnabled={false}
          scalesPageToFit
          setBuiltInZoomControls
          setDisplayZoomControls={false}
          style={{ flex: 1, backgroundColor: props.colors.canvas }}
        />
      </View>
    </Modal>
  );
}
