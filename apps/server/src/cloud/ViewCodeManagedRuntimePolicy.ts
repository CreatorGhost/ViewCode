import { viewcodeProductPolicy } from "@t3tools/shared/viewcodeProductPolicy";
import * as Context from "effect/Context";

// The retained upstream runtime installer has no ViewCode release source.
// Capture this policy when constructing services so their later operations share it.
export const NativeCliManagedRuntimeAllowed = Context.Reference<boolean>(
  "t3/cloud/ViewCodeManagedRuntimePolicy/NativeCliManagedRuntimeAllowed",
  { defaultValue: () => viewcodeProductPolicy.nativeCliManagedRuntime },
);
