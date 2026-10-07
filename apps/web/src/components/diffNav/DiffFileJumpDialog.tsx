import { useMemo, useState } from "react";

import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { filterDiffFilePaths } from "./diffNav.logic";

/** Type-to-jump picker over the files in the current diff. Enter picks the first match. */
export function DiffFileJumpDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: ReadonlyArray<string>;
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => filterDiffFilePaths(props.paths, query), [props.paths, query]);
  const pick = (path: string) => {
    props.onOpenChange(false);
    setQuery("");
    props.onPick(path);
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        props.onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Jump to file</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 px-6 pb-6">
          <Input
            autoFocus
            placeholder="Type a file name"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const first = matches[0];
              if (event.key === "Enter" && first) {
                event.preventDefault();
                pick(first);
              }
            }}
          />
          <ul className="max-h-[50vh] overflow-y-auto">
            {matches.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  className="w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-accent"
                  onClick={() => pick(path)}
                >
                  {path}
                </button>
              </li>
            ))}
            {matches.length === 0 ? (
              <li className="py-6 text-center text-muted-foreground text-sm">No files match</li>
            ) : null}
          </ul>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
