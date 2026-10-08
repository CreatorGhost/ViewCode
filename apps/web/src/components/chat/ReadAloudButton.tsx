import { memo } from "react";
import { SquareIcon, Volume2Icon } from "lucide-react";

import { getClientSettings } from "~/hooks/useSettings";
import {
  isReadAloudSupported,
  speakReadAloud,
  stopReadAloud,
  useReadAloudStore,
} from "~/lib/readAloudPlayer";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Speaker toggle in an assistant reply's action row. Hidden without speechSynthesis. */
export const ReadAloudButton = memo(function ReadAloudButton({
  messageKey,
  markdown,
}: {
  messageKey: string;
  markdown: string;
}) {
  const playing = useReadAloudStore((state) => state.playingKey === messageKey);
  if (!isReadAloudSupported()) return null;
  const label = playing ? "Stop reading" : "Read aloud";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            onClick={() =>
              playing ? stopReadAloud() : speakReadAloud(messageKey, markdown, getClientSettings())
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
  );
});
