// Fixture Cursor stores are built and hashed with Node's own fs, crypto and sqlite.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

/** A root blob: other fields around field 1 entries holding the message blob ids. */
const rootBlob = (messageIds: ReadonlyArray<string>) =>
  Buffer.concat([
    Buffer.from([0x10, 0x05]),
    ...messageIds.flatMap((id) => [Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex")]),
    Buffer.from([0x1a, 0x03, 1, 2, 3]),
    Buffer.from([0x25, 0, 0, 0, 0]),
  ]);

/** A Cursor CLI chat at `<chatsDir>/<hash>/<id>/`: `meta.json` plus its `store.db`. */
export const writeCliChat = (options: {
  readonly chatsDir: string;
  readonly hash: string;
  readonly id: string;
  readonly meta: Record<string, unknown>;
  readonly name?: string;
  readonly messages?: ReadonlyArray<unknown>;
  readonly skipStore?: boolean;
  readonly storeSchema?: string;
}) => {
  const dir = NodePath.join(options.chatsDir, options.hash, options.id);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "meta.json"), JSON.stringify(options.meta));
  if (options.skipStore === true) return;
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "store.db"));
  db.exec(
    options.storeSchema ??
      "CREATE TABLE meta (key TEXT, value TEXT); CREATE TABLE blobs (id TEXT, data BLOB)",
  );
  if (options.storeSchema === undefined) {
    const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
    const ids = (options.messages ?? []).map((message) => {
      const data = Buffer.from(JSON.stringify(message));
      const id = NodeCrypto.createHash("sha256").update(data).digest("hex");
      insert.run(id, data);
      return id;
    });
    const root = rootBlob(ids);
    const rootId = NodeCrypto.createHash("sha256").update(root).digest("hex");
    insert.run(rootId, root);
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(
      Buffer.from(
        JSON.stringify({
          agentId: options.id,
          latestRootBlobId: rootId,
          name: options.name ?? "",
          lastUsedModel: "composer-2",
          blobEncryptionKey: "SECRET-KEY-MATERIAL",
        }),
      ).toString("hex"),
    );
  }
  db.close();
};

/** A typed prompt as the Cursor CLI stores it, inside injected context. */
export const userPrompt = (query: string) => ({
  role: "user",
  content: [
    {
      type: "text",
      text: `<user_info>OS: darwin</user_info>\n<user_query>\n${query}\n</user_query>`,
    },
  ],
});
