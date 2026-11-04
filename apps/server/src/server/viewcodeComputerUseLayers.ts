import * as Layer from "effect/Layer";
import * as ComputerUse from "../computerUse/ComputerUseService.ts";
import * as ThreadState from "../computerUse/ComputerUseThreadState.ts";
import * as RuntimeRequest from "../computerUse/ComputerUseRuntimeRequest.ts";
import * as Bridge from "../computerUse/ComputerUseV2Bridge.ts";
import * as Driver from "../computerUse/Xa11yComputerDriver.ts";
import * as Ancestry from "../computerUse/computerUseAncestry.ts";
import * as Cursor from "../computerUse/ComputerUseCursor.ts";

/** Reuse this layer value for HTTP, runtime responses and startup so grants share one owner. */
export const layer = ComputerUse.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ThreadState.layer,
      ComputerUse.pendingApprovalsLayer,
      Driver.layer,
      Ancestry.layer,
      Cursor.layer,
    ),
  ),
);
export const layerRuntimeResponse = RuntimeRequest.layer.pipe(Layer.provide(layer));
export const layerBridge = Bridge.layer.pipe(Layer.provide(layer));
