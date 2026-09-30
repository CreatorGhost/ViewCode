import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { usageLimitNotificationBody } from "@t3tools/client-runtime/usage-resume";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isLimitError } from "@t3tools/shared/usageLimit";
import * as Option from "effect/Option";
import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useAgentControl } from "../state/agentControl";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

export function ThreadNotificationCoordinator() {
  const { environments } = useEnvironments();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = useCallback((environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  }, []);

  useEffect(() => {
    const activeIds = new Set(environments.map(({ environmentId }) => environmentId));
    const count = pending.current.size;
    for (const [tag, { environmentId, notification }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environments]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environments.map((environment) => (
    <EnvironmentNotifications
      key={environment.environmentId}
      environmentId={environment.environmentId}
      onNotification={onNotification}
    />
  ));
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const control = useAgentControl(environmentId);
  const previous = useRef(
    new Map<ThreadId, { attention: string | null; completion: number | null }>(),
  );
  // Threads that just failed on a usage limit. Their failure is not announced;
  // once the server says what happens next (a resume time or "send a message")
  // the limit notification goes out instead.
  const awaitingLimit = useRef(new Map<ThreadId, string>());

  /**
   * One notification for a thread: a sound, then an in-app toast when the app
   * is focused on another thread, or a desktop notification when it is not
   * focused at all. Nothing when the user is looking at that thread.
   */
  const present = useCallback(
    (input: {
      readonly threadId: ThreadId;
      readonly sound: "completion" | "input";
      readonly toastType: "success" | "error" | "warning";
      readonly icon: "completion" | "approval" | "failed" | "input" | "limit";
      readonly title: string;
      readonly description: string;
      readonly desktopTitle: string;
      readonly desktopBody: string;
    }) => {
      if (hasNotificationSound(mode)) {
        void playNotificationSound(input.sound, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      if (
        inAppNotificationsEnabled &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        (activeEnvironmentId !== environmentId || activeThreadId !== input.threadId)
      ) {
        const toastId = toastManager.add({
          type: input.toastType,
          title: input.title,
          description: input.description,
          data: {
            hideCopyButton: true,
            leadingIcon:
              input.icon === "completion" ? (
                <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
              ) : input.icon === "approval" ? (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ) : input.icon === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
              ) : input.icon === "limit" ? (
                <AlarmClockIcon aria-hidden className="size-4 text-warning-foreground" />
              ) : (
                <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
              ),
          },
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: input.threadId },
              });
            },
          },
        });
        return;
      }
      if (
        !hasDesktopNotifications(mode) ||
        (document.visibilityState === "visible" && document.hasFocus()) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        return;
      try {
        const notification = new Notification(input.desktopTitle, {
          body: input.desktopBody,
          tag: `${environmentId}:${input.threadId}`,
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: input.threadId },
          });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    },
    [
      activeEnvironmentId,
      activeThreadId,
      environmentId,
      inAppNotificationsEnabled,
      mode,
      navigate,
      onNotification,
    ],
  );

  // The control stream and the shell stream arrive independently, so both
  // effects look for a thread that has finished waiting.
  const controlRef = useRef(control);
  useEffect(() => {
    controlRef.current = control;
  }, [control]);
  const flushLimits = useCallback(() => {
    for (const [threadId, title] of awaitingLimit.current) {
      const usageResume = controlRef.current.get(threadId)?.usageResume;
      if (!usageResume) continue;
      awaitingLimit.current.delete(threadId);
      const body = usageLimitNotificationBody(usageResume.resumeAt, Date.now());
      present({
        threadId,
        sound: "input",
        toastType: "warning",
        icon: "limit",
        title: body,
        description: title,
        desktopTitle: title,
        desktopBody: body,
      });
    }
  }, [present]);
  useEffect(flushLimits, [control, flushLimits]);

  useEffect(() => {
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
      previous.current.clear();
      awaitingLimit.current.clear();
      return;
    }
    const next = new Map<ThreadId, { attention: string | null; completion: number | null }>();
    for (const thread of shell.snapshot.value.threads) {
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestTurn?.state === "error") status = "failed";
      const prior = previous.current.get(thread.id);
      const attention =
        status === "input" || status === "approval" || status === "failed"
          ? `${thread.latestTurn?.turnId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestTurn?.completedAt ?? "");
      const completion =
        status === "ready" &&
        thread.latestTurn?.state === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { attention, completion });
      // A child agent's limit failure is still a failure: its lead handles the
      // rest. Every other thread that stops on a usage limit resumes or waits
      // for the user, which the limit notification says.
      const stoppedOnLimit =
        status === "failed" &&
        thread.parentThreadId == null &&
        isLimitError(thread.session?.lastError);
      if (!stoppedOnLimit) awaitingLimit.current.delete(thread.id);
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      if (stoppedOnLimit) {
        awaitingLimit.current.set(thread.id, thread.title);
        continue;
      }
      const title =
        kind === "completion"
          ? "Thread completed"
          : status === "approval"
            ? "Approval needed"
            : status === "failed"
              ? "Thread failed"
              : "Input needed";
      present({
        threadId: thread.id,
        sound: kind,
        toastType: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        icon:
          kind === "completion"
            ? "completion"
            : status === "approval"
              ? "approval"
              : status === "failed"
                ? "failed"
                : "input",
        title,
        description: thread.title,
        desktopTitle: title,
        desktopBody: thread.title,
      });
    }
    previous.current = next;
    flushLimits();
  }, [flushLimits, present, shell]);

  return null;
}
