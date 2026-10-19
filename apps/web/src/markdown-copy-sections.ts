/** Agents often enclose a drafted message in horizontal rules; copy that draft separately. */

interface MarkdownAstNode {
  type?: string;
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
}

export function remarkCopySections() {
  return (tree: MarkdownAstNode) => {
    const children = tree.children;
    if (!children) return;
    const result: MarkdownAstNode[] = [];
    let openRule = -1;
    for (const node of children) {
      if (node.type !== "thematicBreak") {
        result.push(node);
        continue;
      }
      if (openRule >= 0 && result.length - openRule > 1) {
        const body = result.splice(openRule + 1);
        result.push({
          // Any parent node works; the hast name makes it a plain div.
          type: "blockquote",
          data: { hName: "div", hProperties: { dataCopySection: "" } },
          children: body,
        });
        result.push(node);
        openRule = -1;
        continue;
      }
      result.push(node);
      openRule = result.length - 1;
    }
    tree.children = result;
  };
}
