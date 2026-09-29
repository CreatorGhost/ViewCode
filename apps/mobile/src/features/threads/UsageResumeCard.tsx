import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { RequestActionButton } from "./RequestActionButton";

/**
 * Shown above the composer when a usage limit stopped the thread: when it
 * resumes on its own (or that ViewCode cannot tell), with Cancel and Resume now.
 */
export function UsageResumeCard(props: {
  readonly text: string;
  readonly canCancel: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onResumeNow: () => void;
}) {
  return (
    <View className="gap-2.5 rounded-[20px] border border-border-subtle bg-card-alt p-4">
      <Text className="font-sans text-sm leading-normal text-foreground-secondary">
        {props.text}
      </Text>
      <View className="flex-row gap-2">
        {props.canCancel ? (
          <RequestActionButton
            label="Cancel"
            tone="secondary"
            disabled={props.busy}
            onPress={props.onCancel}
          />
        ) : null}
        <RequestActionButton label="Resume now" disabled={props.busy} onPress={props.onResumeNow} />
      </View>
    </View>
  );
}
