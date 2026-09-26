import { create } from "zustand";

import { ImportSessionsDialog, type ImportSessionsTarget } from "./ImportSessionsDialog";
import {
  RemoveImportedSessionsDialog,
  type RemoveImportedSessionsTarget,
} from "./RemoveImportedSessionsDialog";

type Request =
  | { readonly kind: "import"; readonly target: ImportSessionsTarget }
  | { readonly kind: "remove"; readonly target: RemoveImportedSessionsTarget };

const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Opens the session picker for one project, from any menu. */
export function openImportSessionsDialog(target: ImportSessionsTarget) {
  useRequest.setState({ request: { kind: "import", target } });
}

/** Opens the archive-imported-threads dialog for a sidebar project. */
export function openRemoveImportedSessionsDialog(target: RemoveImportedSessionsTarget) {
  useRequest.setState({ request: { kind: "remove", target } });
}

function close() {
  useRequest.setState({ request: null });
}

export function AgentSessionDialogsHost() {
  const request = useRequest((state) => state.request);
  return (
    <>
      <ImportSessionsDialog
        target={request?.kind === "import" ? request.target : null}
        onClose={close}
      />
      <RemoveImportedSessionsDialog
        target={request?.kind === "remove" ? request.target : null}
        onClose={close}
      />
    </>
  );
}
