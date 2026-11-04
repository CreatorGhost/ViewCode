import * as Schema from "effect/Schema";

const CursorCliConfig = Schema.Struct({
  authInfo: Schema.Struct({ authId: Schema.String }),
});
const decodeCliConfig = Schema.decodeSync(Schema.fromJsonString(CursorCliConfig));

export function cursorCliLoginIdentity(config: string) {
  const identity = decodeCliConfig(config).authInfo.authId.trim();
  if (!identity) throw new Error("Cursor CLI login identity is missing");
  return identity;
}
