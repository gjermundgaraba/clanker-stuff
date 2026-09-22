import type { ContextPart, ContextSnapshot } from "./snapshot.js";

export interface TreeNode extends ContextPart {
  readonly id: string;
  readonly children: readonly TreeNode[];
}

const leaf = (part: ContextPart, id: string): TreeNode => ({ ...part, id, children: [] });

const group = (
  id: string,
  label: string,
  children: readonly TreeNode[],
  body = `${children.length} entries. Expand this group to inspect individual entries. Token counts are estimates.`,
): TreeNode => ({
  id,
  label,
  body,
  format: "text",
  tone: "text",
  estimatedTokens: children.reduce((sum, child) => sum + child.estimatedTokens, 0),
  children,
});

const largestFirst = (parts: readonly ContextPart[]): ContextPart[] =>
  [...parts].sort((a, b) => b.estimatedTokens - a.estimatedTokens);

export const buildTree = (snapshot: ContextSnapshot): TreeNode[] => [
  leaf(snapshot.system, "system"),
  group(
    "tools",
    "Active tools",
    largestFirst(snapshot.tools).map((part, index) => leaf(part, `tools-${index}`)),
  ),
  group(
    "messages",
    "Messages",
    snapshot.messages.map((message) => leaf(message, `messages-${message.sourceEntryId}`)),
    "Canonical session context before transient extension/provider transformations. Token estimates count effective content only; original content and omitted entries do not add tokens.",
  ),
];

export const groupIds = (nodes: readonly TreeNode[]): string[] =>
  nodes.flatMap((node) => (node.children.length > 0 ? [node.id] : []));

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
  parentTokens = nodes.reduce((sum, node) => sum + node.estimatedTokens, 0),
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

export const filterTree = (nodes: readonly TreeNode[], query: string): TreeNode[] => {
  const needle = query.trim().toLowerCase();

  return nodes.flatMap((node) => {
    if (node.label.toLowerCase().includes(needle) || node.body.toLowerCase().includes(needle)) {
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
  total: number,
): number => {
  if (viewport <= 0) return 0;
  const next = Math.max(selected - viewport + 1, Math.min(scroll, selected));

  return Math.max(0, Math.min(next, total - viewport));
};
