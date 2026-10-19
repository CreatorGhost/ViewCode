import { memo, useState } from "react";
import { MessageSquareIcon, SquarePenIcon, XIcon } from "lucide-react";
import type { ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  type DraftId,
  type DraftSessionState,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import {
  applyProviderInstanceSettings,
  shouldShowInstanceBadge,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import type { Project } from "../../types";
import { resolveComposerProviderSelection } from "../ChatView.logic";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { viewCodeActiveDraftTitle } from "./viewCodeActiveDraft.logic";

/** A navigation row for the local active draft, including its empty first state. */
export const ViewCodeActiveDraftRow = memo(function ViewCodeActiveDraftRow(props: {
  readonly draftId: DraftId;
  readonly session: DraftSessionState;
  readonly project: Project | undefined;
  readonly settings: ServerSettings | undefined;
  readonly providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
  readonly onNavigate: (draftId: DraftId) => void;
}) {
  const { draftId } = props;
  const [title] = useState(() =>
    viewCodeActiveDraftTitle(useComposerDraftStore.getState().getComposerDraft(draftId)),
  );
  // Prompt changes do not affect these primitive/reference selectors.
  const activeProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(draftId)?.activeProvider ?? null,
  );
  const modelSelection = useComposerDraftStore((store) => {
    const composer = store.getComposerDraft(draftId);
    return composer?.activeProvider
      ? (composer.modelSelectionByProvider[composer.activeProvider] ?? null)
      : null;
  });
  const entries = sortProviderInstanceEntries(
    props.settings
      ? applyProviderInstanceSettings(
          [...props.providerEntries.values()],
          props.settings,
          props.session.projectId,
        )
      : [...props.providerEntries.values()],
  );
  const projectDefault = props.settings
    ? resolveProjectSettings(props.settings, props.session.projectId, props.project).settings
        .defaultModelSelection
    : props.project?.defaultModelSelection;
  const { selectedProviderEntry: provider } = resolveComposerProviderSelection({
    entries,
    candidateInstanceIds: [activeProvider, projectDefault?.instanceId],
    lockedProvider: null,
    lockedInstanceId: null,
  });
  const selectedModel = modelSelection?.instanceId === provider?.instanceId ? modelSelection : null;
  const modelId = selectedModel?.model ?? projectDefault?.model;
  const model = provider?.models.find((entry) => entry.slug === modelId);
  const providerLabel = provider
    ? `${provider.displayName}${model ? ` · ${getTriggerDisplayModelLabel(model)}` : ""}`
    : "Choose a provider";
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  return (
    <li className="list-none">
      <div className="group/sidebar-row flex h-7 w-full items-center gap-1.5 rounded-md bg-sidebar-foreground/12 pr-2 text-row font-medium text-sidebar-foreground">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-current="page"
                aria-label={`${title}, Unsent draft, ${providerLabel}`}
                data-testid="sidebar-active-draft-row"
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => props.onNavigate(draftId)}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {provider ? (
                    <ProviderInstanceIcon
                      driverKind={provider.driverKind}
                      displayName={provider.displayName}
                      accentColor={provider.accentColor}
                      acpRegistryAgentId={provider.acpRegistryAgentId}
                      acpRegistryIconUrl={provider.acpRegistryIconUrl}
                      showBadge={shouldShowInstanceBadge(provider, entries)}
                      iconClassName="size-3.5 opacity-70"
                      badgeClassName="right-[-0.1875rem] bottom-[-0.1875rem] h-2.5 min-w-2.5 px-0.5 text-5xs"
                    />
                  ) : (
                    <MessageSquareIcon
                      aria-hidden
                      className="size-3.5 text-sidebar-muted-foreground"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <SquarePenIcon aria-hidden className="size-3 shrink-0 text-warning-foreground" />
              </button>
            }
          />
          <TooltipPopup side="right">Unsent draft · {providerLabel}</TooltipPopup>
        </Tooltip>
        <button
          type="button"
          aria-label="Discard draft"
          className="hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:inline-flex group-hover/sidebar-row:inline-flex"
          onClick={() => {
            releaseComposerDraftUploads(draftId);
            clearDraftThread(draftId);
          }}
        >
          <XIcon className="size-3" />
        </button>
      </div>
    </li>
  );
});
