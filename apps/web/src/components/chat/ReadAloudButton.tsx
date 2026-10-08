import { memo } from "react";
import { Link } from "@tanstack/react-router";
import { SquareIcon, Volume2Icon } from "lucide-react";

import { getClientSettings } from "~/hooks/useSettings";
import {
  isReadAloudSupported,
  type ReadAloudNotice,
  speakReadAloud,
  stopReadAloud,
  useReadAloudStore,
} from "~/lib/readAloudPlayer";
import { useReadAloudEnvironmentId, useVoiceModels } from "~/state/voiceModels";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Speaker toggle in an assistant reply's action row. Hidden where no voice can read. */
export const ReadAloudButton = memo(function ReadAloudButton({
  messageKey,
  markdown,
}: {
  messageKey: string;
  markdown: string;
}) {
  const playing = useReadAloudStore((state) => state.playingKey === messageKey);
  const notice = useReadAloudStore((state) =>
    state.notice?.key === messageKey ? state.notice : null,
  );
  if (!isReadAloudSupported()) return null;
  const label = playing ? "Stop reading" : "Read aloud";

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={label}
              onClick={() =>
                playing
                  ? stopReadAloud()
                  : speakReadAloud(messageKey, markdown, getClientSettings())
              }
              type="button"
              size="xs"
              variant="ghost-muted"
            />
          }
        >
          {playing ? <SquareIcon className="size-3" /> : <Volume2Icon className="size-3" />}
        </TooltipTrigger>
        <TooltipPopup>
          <p>{label}</p>
        </TooltipPopup>
      </Tooltip>
      {notice ? <ReadAloudFallbackNotice notice={notice} /> : null}
    </>
  );
});

/** One line beside the button: why the system voice read this reply, and the download's progress. */
function ReadAloudFallbackNotice({ notice }: { notice: ReadAloudNotice }) {
  const environmentId = useReadAloudEnvironmentId();
  const { state } = useVoiceModels(notice.reason === "downloading" ? environmentId : null);
  const tier = state?.tiers.find((each) => each.tier === notice.tier);
  const percent =
    tier?.phase === "downloading" && tier.totalBytes
      ? Math.floor((tier.downloadedBytes / tier.totalBytes) * 100)
      : null;
  const text =
    notice.reason === "downloading"
      ? tier?.phase === "ready"
        ? "Natural voice downloaded. Replies use it from now on."
        : tier?.phase === "failed"
          ? "The natural voice couldn't download, so the system voice read this."
          : `Downloading the natural voice${percent === null ? "" : ` (${percent}%)`}. The system voice reads until it's ready.`
      : notice.reason === "failed"
        ? "The natural voice couldn't download, so the system voice read this."
        : notice.reason === "unavailable"
          ? "The natural voice isn't available here, so the system voice read this."
          : "The natural voice couldn't start, so the system voice read this.";

  return (
    <span className="min-w-0 text-muted-foreground" role="status">
      {text}{" "}
      <Link
        to="/settings/appearance"
        hash="appearance-read-aloud"
        className="underline underline-offset-2"
      >
        Settings
      </Link>
    </span>
  );
}
