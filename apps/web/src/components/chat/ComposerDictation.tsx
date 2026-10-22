import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { DICTATION_IDLE, type DictationState, dictationIsActive } from "~/lib/dictation.logic";
import { DICTATION_FRAME_MS } from "~/lib/dictationAudio";
import { subscribeDictationLevels, useDictationStore } from "~/lib/dictationSession";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The dictation `ownerKey` owns, or idle while another composer (or none) dictates. */
export function useComposerDictation(ownerKey: string): {
  readonly state: DictationState;
  readonly transcript: string;
} {
  const state = useDictationStore((store) =>
    store.ownerKey === ownerKey ? store.state : DICTATION_IDLE,
  );
  const transcript = useDictationStore((store) =>
    store.ownerKey === ownerKey ? store.transcript : "",
  );
  return { state, transcript };
}

// Keeps the editor's focus and caret, where the transcript will go.
const keepEditorFocus = (event: React.PointerEvent) => event.preventDefault();

/** The microphone in the composer's actions; while dictating, the dictation row covers it. */
export function ComposerDictationButton(props: {
  readonly disabled: boolean;
  readonly shortcutLabel: string | null;
  readonly onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Dictate"
            disabled={props.disabled}
            onPointerDown={keepEditorFocus}
            onClick={props.onToggle}
          />
        }
      >
        <MicIcon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.shortcutLabel ? `Dictate (${props.shortcutLabel})` : "Dictate"}
      </TooltipPopup>
    </Tooltip>
  );
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function statusLabel(state: DictationState): string {
  switch (state.phase) {
    case "idle":
    case "preparing":
      return "Starting…";
    case "downloading":
      return state.totalBytes
        ? `Downloading the speech model, ${megabytes(state.downloadedBytes)} of ${megabytes(state.totalBytes)}`
        : "Downloading the speech model…";
    case "listening":
      return "Listening…";
    case "finishing":
      return "Finishing…";
    case "error":
      return state.message;
  }
}

/** Errors a second press could fix; the others need a change elsewhere first. */
function canRetry(state: DictationState): boolean {
  return (
    state.phase === "error" && state.reason !== "unsupported" && state.reason !== "unavailable"
  );
}

/**
 * What the model has heard so far, in italic grey above the composer's controls.
 * On confirm it darkens while the last words are read, then goes into the prompt.
 */
export function ComposerDictationTranscript(props: {
  readonly state: DictationState;
  readonly transcript: string;
}) {
  const { state, transcript } = props;
  if (state.phase !== "listening" && state.phase !== "finishing") return null;
  const loading = state.phase === "listening" && state.model === "loading";
  if (transcript.length === 0 && !loading) return null;
  const words = transcript.length > 0 ? transcript.split(" ") : [];
  return (
    <div
      data-dictation-enter=""
      aria-live="polite"
      className={cn(
        "flex max-h-16 flex-col justify-end overflow-hidden px-4 pb-1 text-sm italic transition-colors duration-150",
        state.phase === "finishing" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <p>
        {words.length > 0
          ? words.map((word, index) => (
              // A word the model revises remounts and softens in again; settled words stay still.
              // oxlint-disable-next-line react/no-array-index-key -- A word's place is its identity: the same word twice is two words.
              <span key={`${index}:${word}`} data-dictation-word="">
                {index > 0 ? " " : ""}
                {word}
              </span>
            ))
          : `Loading the speech model${state.phase === "listening" && state.loaded ? `, ${Math.round(state.loaded * 100)}%` : "…"}`}
      </p>
    </div>
  );
}

/**
 * Takes the place of the composer's controls while dictating: status, the
 * waveform, and cancel and confirm. Escape cancels.
 */
export function ComposerDictationControls(props: {
  readonly state: DictationState;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}) {
  const { state, onCancel } = props;
  const active = dictationIsActive(state);
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active, onCancel]);
  if (!active) return null;

  const label = statusLabel(state);
  const error = state.phase === "error";
  return (
    <div
      data-dictation-enter=""
      data-chat-composer-dictation="true"
      className="absolute inset-0 flex min-w-0 items-center gap-2 px-3 pb-3 sm:px-4 sm:pb-4"
    >
      <span
        key={label}
        data-dictation-swap=""
        role={error ? "alert" : "status"}
        className={cn(
          "min-w-0 shrink text-xs",
          error ? "text-destructive-foreground" : "shrink-0 text-muted-foreground",
        )}
      >
        {label}
      </span>
      {state.phase === "downloading" ? (
        <DictationDownloadProgress state={state} />
      ) : state.phase === "listening" ? (
        <DictationWaveform />
      ) : (
        <span className="flex-1" />
      )}
      {error && canRetry(state) ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          onPointerDown={keepEditorFocus}
          onClick={props.onRetry}
        >
          Try again
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-sm"
              aria-label={error ? "Close" : "Discard dictation"}
              onPointerDown={keepEditorFocus}
              onClick={onCancel}
            />
          }
        >
          <XIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">{error ? "Close (Esc)" : "Discard (Esc)"}</TooltipPopup>
      </Tooltip>
      {error ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="primary-solid"
                size="icon-sm"
                aria-label="Insert dictation"
                disabled={state.phase !== "listening"}
                onPointerDown={keepEditorFocus}
                onClick={props.onConfirm}
              />
            }
          >
            <CheckIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">Insert into the prompt</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function DictationDownloadProgress(props: {
  readonly state: Extract<DictationState, { phase: "downloading" }>;
}) {
  const { downloadedBytes, totalBytes } = props.state;
  const fraction = totalBytes ? Math.min(1, downloadedBytes / totalBytes) : 0;
  return (
    <div
      role="progressbar"
      aria-label="Speech model download"
      aria-valuemin={0}
      aria-valuemax={totalBytes ?? undefined}
      aria-valuenow={downloadedBytes}
      className="h-0.5 min-w-8 flex-1 overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full origin-left bg-primary transition-transform duration-100 ease-linear"
        style={{ transform: `scaleX(${fraction})` }}
      />
    </div>
  );
}

/** One bar per 50 ms frame, scrolling at about 67 px/s. */
const BAR_STEP = (67 * DICTATION_FRAME_MS) / 1000;
const BAR_WIDTH = 2;

function barHeight(level: number, height: number): number {
  // Speech RMS sits around 0.02–0.2; the square root spreads it over the row.
  return Math.max(2, Math.min(1, Math.sqrt(level) * 3.2) * height);
}

/**
 * The microphone's level as scrolling bars. The canvas is drawn only when a bar
 * arrives and slides one step with a transform; nothing repaints in between, and
 * under reduced motion it stays hidden.
 */
function DictationWaveform() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!container || !canvas || !context) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const levels: number[] = [];
    let width = 0;
    let height = 0;
    let color = "";
    let slide: Animation | null = null;

    const draw = () => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      for (let index = 0; index < levels.length; index += 1) {
        const x = width - BAR_WIDTH - index * BAR_STEP;
        if (x < -BAR_WIDTH) break;
        const bar = barHeight(levels[index] ?? 0, height);
        context.fillRect(x, (height - bar) / 2, BAR_WIDTH, bar);
      }
    };
    const resize = () => {
      // One step wider than the row: the slide brings the newest bar in from the right.
      width = container.clientWidth + BAR_STEP;
      height = container.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      color = getComputedStyle(canvas).color;
      draw();
    };
    const stopResize = observeResize(container, resize);
    resize();
    const stopLevels = subscribeDictationLevels((level) => {
      levels.unshift(level);
      if (levels.length > Math.ceil(width / BAR_STEP) + 1)
        levels.length = Math.ceil(width / BAR_STEP) + 1;
      if (reducedMotion.matches || document.visibilityState !== "visible") return;
      draw();
      slide?.cancel();
      slide = canvas.animate(
        [{ transform: `translateX(${BAR_STEP}px)` }, { transform: "translateX(0)" }],
        { duration: DICTATION_FRAME_MS, easing: "linear" },
      );
    });
    return () => {
      stopLevels();
      stopResize();
      slide?.cancel();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-dictation-waveform=""
      aria-hidden="true"
      className="relative h-6 min-w-8 flex-1 overflow-hidden motion-reduce:invisible"
    >
      <canvas ref={canvasRef} className="absolute top-0 right-0 text-muted-foreground" />
    </div>
  );
}
