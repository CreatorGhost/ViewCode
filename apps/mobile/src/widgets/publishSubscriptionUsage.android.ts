import { requireOptionalNativeModule } from "expo";
import {
  subscriptionUsageDeadlines,
  type SubscriptionUsageSnapshot,
} from "./subscriptionUsageSnapshot";

export async function publishSubscriptionUsage(snapshot: SubscriptionUsageSnapshot) {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const { default: widget } = await import("./SubscriptionUsage");
  widget.updateSnapshot(snapshot);
  // Android has no timeline; an alarm re-renders the stored snapshot at each
  // refill so a window that has reset shows full while the app is closed.
  requireOptionalNativeModule<{ schedule: (name: string, deadlines: number[]) => void }>(
    "T3WidgetExpiry",
  )?.schedule("SubscriptionUsage", subscriptionUsageDeadlines(snapshot, Date.now()));
}
