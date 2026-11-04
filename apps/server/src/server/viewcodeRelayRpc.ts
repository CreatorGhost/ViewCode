import {
  WS_METHODS,
  type ViewCodeRelaySetupStartInput,
  type ViewCodeRelayChooseAccountInput,
  type ViewCodeRelayRemoveInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Setup from "../relay/ViewCodeRelaySetup.ts";
export const make = Effect.gen(function* () {
  const setup = yield* Setup.ViewCodeRelaySetup;
  return {
    [WS_METHODS.viewcodeRelaySetupStart]: (input: ViewCodeRelaySetupStartInput) =>
      setup.start(input),
    [WS_METHODS.viewcodeRelaySetupCancel]: () => setup.cancel,
    [WS_METHODS.viewcodeRelaySetupContinue]: () => setup.continueSetup,
    [WS_METHODS.viewcodeRelaySetupChooseAccount]: (input: ViewCodeRelayChooseAccountInput) =>
      setup.chooseAccount(input.accountId),
    [WS_METHODS.viewcodeRelayRemove]: (input: ViewCodeRelayRemoveInput) => setup.remove(input),
  };
});
