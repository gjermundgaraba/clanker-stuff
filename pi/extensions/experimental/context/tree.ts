import type { ContextPart, InspectorSnapshot } from "./snapshot.js";

export interface TreeNode extends ContextPart {
  readonly id: string;
  readonly children: readonly TreeNode[];
}

const leaf = (part: ContextPart, id: string): TreeNode => ({
  ...part,
  id,
  children: [],
});

const group = (
  id: string,
  label: string,
  children: readonly TreeNode[],
  body = `${children.length} entries. Expand this group to inspect individual entries. Token counts are estimates.`
): TreeNode => ({
  id,
  label,
  body,
  format: "text",
  tone: "text",
  estimatedTokens: children.reduce(
    (sum, child) => sum + child.estimatedTokens,
    0
  ),
  children,
});

export const buildTree = (snapshot: InspectorSnapshot): TreeNode[] => {
  if (snapshot.kind === "tools") {
    return [
      group(
        "registered",
        "Registered tools",
        snapshot.tools.map((part, index) => leaf(part, `registered-${index}`)),
        "Registration is not a model declaration. Direct tools are callable from tools only while active; codemode and deferred tools are callable while registered. Model-only and hidden tools are never callable from tools. reachesTools is a capability flag, not an exact dependency list. No token estimates."
      ),
    ];
  }

  if (snapshot.kind === "request") {
    return snapshot.request
      ? [
          leaf(
            {
              label: "Provider payload",
              body: snapshot.request.body,
              format: snapshot.request.format,
              tone: "code",
              estimatedTokens: 0,
            },
            "payload"
          ),
        ]
      : [];
  }

  return [
    leaf(snapshot.system, "system"),
    group(
      "tools",
      "Tool declarations",
      snapshot.tools
        .toSorted((a, b) => b.estimatedTokens - a.estimatedTokens)
        .map((part, index) => leaf(part, `tools-${index}`)),
      snapshot.recorded
        ? undefined
        : "No request has recorded tool declarations yet. Run a turn, then reopen /context."
    ),
    group(
      "messages",
      "Messages",
      snapshot.messages.map((message) =>
        leaf(message, `messages-${message.sourceEntryId}`)
      ),
      "Canonical session context before transient extension/provider transformations. Token estimates count effective content only; original content and omitted entries do not add tokens."
    ),
  ];
};

export interface FlatRow {
  readonly depth: number;
  readonly expanded: boolean;
  readonly last: boolean;
  /** Share of the parent's tokens (top level: share of the whole snapshot), 0-1. */
  readonly share: number;
  readonly node: TreeNode;
}

export const flattenTree = (
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parentTokens = nodes.reduce((sum, node) => sum + node.estimatedTokens, 0)
): FlatRow[] =>
  nodes.flatMap((node, index) => [
    {
      depth,
      expanded: expanded.has(node.id),
      last: index === nodes.length - 1,
      share: parentTokens > 0 ? node.estimatedTokens / parentTokens : 0,
      node,
    },
    ...(expanded.has(node.id)
      ? flattenTree(node.children, expanded, depth + 1, node.estimatedTokens)
      : []),
  ]);

export const filterTree = (
  nodes: readonly TreeNode[],
  query: string
): TreeNode[] => {
  const needle = query.trim().toLowerCase();

  return nodes.flatMap((node) => {
    if (
      node.label.toLowerCase().includes(needle) ||
      node.body.toLowerCase().includes(needle)
    ) {
      return [node];
    }

    const children = filterTree(node.children, needle);

    return children.length > 0 ? [{ ...node, children }] : [];
  });
};

export const followSelection = (
  selected: number,
  scroll: number,
  viewport: number,
  total: number
): number => {
  if (viewport <= 0) {
    return 0;
  }

  const next = Math.max(selected - viewport + 1, Math.min(scroll, selected));

  return Math.max(0, Math.min(next, total - viewport));
};
