#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [
  graphArg = ".pr-lens/drawn.graph.json",
  manifestArg = ".pr-lens/manifest.json",
  outputArg = ".pr-lens/report.html",
] = process.argv.slice(2);

/** @typedef {null | boolean | number | string | JsonValue[] | JsonObject} JsonValue */
/** @typedef {{ [key: string]: JsonValue }} JsonObject */

/** @param {JsonValue | undefined} value */
const display = (value) =>
  value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");

/** @param {JsonValue | undefined} value */
const escapeHtml = (value) =>
  display(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** @param {JsonValue | undefined} value */
const array = (value) => (Array.isArray(value) ? value : []);

/** @param {JsonValue | undefined} value
 * @returns {JsonObject}
 */
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

/** @param {JsonValue | undefined} value */
const text = (value, fallback = "") =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

/** @param {JsonValue | undefined} value */
const shortSha = (value) => text(value).slice(0, 12);

/** @param {JsonValue | undefined} views
 * @returns {JsonObject[]}
 */
const flattenViews = (views) =>
  array(views)
    .map(object)
    .flatMap((view) => [view, ...flattenViews(view.children)]);

/** @param {JsonValue | undefined} delta */
const deltaLabel = (delta) => {
  switch (delta) {
    case "added":
      return "Added";
    case "modified":
      return "Modified";
    case "removed":
      return "Removed";
    default:
      return "Context";
  }
};

/** @param {{ label: JsonValue | undefined, value: JsonValue | undefined, tone?: JsonValue | undefined }} stat */
const renderStat = ({ label, value, tone = "neutral" }) => `
  <div class="stat ${escapeHtml(tone)}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
  </div>`;

/** @param {JsonObject} node */
const renderNode = (node) => {
  const files = [
    ...new Set(
      array(node.files)
        .map((file) => text(object(file).path))
        .filter(Boolean),
    ),
  ];

  return `
    <article class="node-card">
      <div class="node-heading">
        <span class="badge ${escapeHtml(node.delta)}">${escapeHtml(deltaLabel(node.delta))}</span>
        <h3>${escapeHtml(node.label)}</h3>
      </div>
      <p>${escapeHtml(node.summary)}</p>
      ${
        files.length
          ? `<div class="files">${files.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>`
          : ""
      }
    </article>`;
};

const main = async () => {
  const graphPath = path.resolve(graphArg);
  const manifestPath = path.resolve(manifestArg);
  const outputPath = path.resolve(outputArg);
  /** @type {JsonValue} */
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Native JSON.parse produces only the recursive JSON values modeled here; graph semantics are validated by the PR Lens CLI.
  const graphJson = JSON.parse(await readFile(graphPath, "utf8"));
  /** @type {JsonValue} */
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- The native parser restricts this generated manifest to JSON values, without asserting a manifest schema.
  const manifestJson = JSON.parse(await readFile(manifestPath, "utf8"));
  const graph = object(graphJson);
  const manifest = object(manifestJson);
  const provenance = object(graph.provenance);
  const manifestGraph = object(manifest.graph);
  const graphHash = text(manifestGraph.contentHash);
  const manifestSha = text(manifestGraph.headSha);
  const graphSha = text(object(provenance.head).sha);

  if (manifestSha && graphSha && manifestSha !== graphSha) {
    throw new Error("manifest and graph describe different commits");
  }

  const views = new Map(flattenViews(graph.views).map((view) => [view.id, view]));
  const manifestDir = path.dirname(manifestPath);
  const outputDir = path.dirname(outputPath);

  const diagramCards = await Promise.all(
    array(manifest.assets)
      .map(object)
      .map(async (asset, index) => {
        const assetPath = path.resolve(manifestDir, text(asset.path));

        if (!assetPath.startsWith(`${manifestDir}${path.sep}`)) {
          throw new Error(`asset escapes the manifest directory: ${text(asset.path)}`);
        }

        const svg = await readFile(assetPath, "utf8");

        if (/<script\b|javascript:|\bon\w+\s*=/i.test(svg)) {
          throw new Error(`unsafe SVG content: ${text(asset.path)}`);
        }

        const viewId = text(asset.view);
        const view = views.get(viewId) ?? {};
        const relativeAsset = path.relative(outputDir, assetPath).split(path.sep).join("/");
        const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

        return `
        <article class="view-card" id="view-${escapeHtml(asset.view || index)}">
          <div class="view-heading">
            <div>
              <span class="kicker">${escapeHtml(asset.lens || "diagram")}</span>
              <h2>${escapeHtml(text(view.title, viewId || `Diagram ${index + 1}`))}</h2>
              <p>${escapeHtml(text(view.summary, "Rendered view of this change."))}</p>
            </div>
            <a class="raw-link" href="${escapeHtml(relativeAsset)}" target="_blank">Open raw SVG ↗</a>
          </div>
          <div class="diagram" role="img" aria-label="${escapeHtml(text(view.title, viewId))}">
            <img src="${dataUrl}" alt="${escapeHtml(text(view.title, viewId))}">
          </div>
          <div class="asset-meta">${escapeHtml(asset.width)} × ${escapeHtml(asset.height)} · embedded in this report</div>
        </article>`;
      }),
  );

  const stats = object(graph.stats);

  const statCards = [
    { label: "Files changed", value: stats.filesChanged ?? "—" },
    { label: "Additions", value: `+${display(stats.additions ?? 0)}`, tone: "added" },
    { label: "Deletions", value: `−${display(stats.deletions ?? 0)}`, tone: "removed" },
    ...array(stats.chips)
      .map(object)
      .map((chip) => ({
        label: chip.label,
        value: chip.value,
        tone: chip.tone,
      })),
  ];

  const nodes = array(graph.nodes).map(object);
  const changedNodes = nodes.filter((node) => node.delta !== "unchanged");

  const contextNodes = nodes.filter((node) => node.delta === "unchanged");

  const heroEdges = array(graph.edges)
    .map(object)
    .filter((edge) => edge.emphasis === "hero");

  const nodeNames = new Map(nodes.map((node) => [node.id, node.label]));

  const heroCards = heroEdges
    .map(
      (edge) => `
        <article class="hero-card">
          <span>${escapeHtml(nodeNames.get(text(edge.from)) || edge.from)}</span>
          <strong>→ ${escapeHtml(edge.label)} →</strong>
          <span>${escapeHtml(nodeNames.get(text(edge.to)) || edge.to)}</span>
          ${edge.summary ? `<p>${escapeHtml(edge.summary)}</p>` : ""}
        </article>`,
    )
    .join("");

  const flowSections = array(graph.flows)
    .map(object)
    .map(
      (flow) => `
        <article class="flow-card">
          <h3>${escapeHtml(flow.title)}</h3>
          <p>${escapeHtml(flow.summary)}</p>
          <ol>
            ${array(flow.messages)
              .map(object)
              .map(
                (message) => `<li>
                  <span>${escapeHtml(nodeNames.get(text(message.from)) || message.from)}</span>
                  <strong>${escapeHtml(message.label)}</strong>
                  <span>${escapeHtml(nodeNames.get(text(message.to)) || message.to)}</span>
                  ${message.repeat ? `<em>×${escapeHtml(message.repeat)}</em>` : ""}
                </li>`,
              )
              .join("")}
          </ol>
        </article>`,
    )
    .join("");

  const repo = object(provenance.repo);
  const base = object(provenance.base);
  const head = object(provenance.head);

  const repoName =
    [text(repo.owner), text(repo.name)].filter(Boolean).join("/") || "Local repository";

  const branchLine = [text(head.ref), text(base.ref) ? `against ${text(base.ref)}` : ""]
    .filter(Boolean)
    .join(" ");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <title>${escapeHtml(text(graph.title, "PR Lens report"))}</title>
  <style>
    :root { color-scheme: dark; --bg:#080b10; --panel:#111722; --panel2:#151d29; --line:#273244; --text:#edf2f7; --muted:#9ba9ba; --blue:#7dd3fc; --green:#59d499; --amber:#f4bd62; --red:#ff7b79; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:radial-gradient(circle at 20% -10%,#17304a 0,transparent 35%),var(--bg); color:var(--text); font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(1380px,calc(100% - 32px)); margin:auto; padding:56px 0 72px; }
    header { max-width:980px; margin-bottom:30px; }
    h1 { margin:8px 0 14px; font-size:clamp(32px,5vw,58px); line-height:1.05; letter-spacing:-.035em; }
    h2 { margin:4px 0 6px; font-size:clamp(22px,3vw,32px); line-height:1.2; letter-spacing:-.02em; }
    h3 { margin:0; font-size:16px; }
    p { margin:0; color:var(--muted); }
    .eyebrow,.kicker { color:var(--blue); font-size:12px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
    .lead { max-width:900px; color:#ced7e3; font-size:18px; }
    .meta { margin-top:18px; color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(155px,1fr)); gap:10px; margin:28px 0 36px; }
    .stat { min-height:92px; padding:16px; border:1px solid var(--line); border-radius:14px; background:linear-gradient(145deg,var(--panel2),var(--panel)); }
    .stat span { display:block; color:var(--muted); font-size:12px; }
    .stat strong { display:block; margin-top:8px; font-size:19px; }
    .stat.added strong { color:var(--green); } .stat.modified strong,.stat.hero strong { color:var(--amber); } .stat.removed strong { color:var(--red); }
    nav { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:42px; }
    nav a,.raw-link { color:#cdeeff; text-decoration:none; border:1px solid #31506b; border-radius:999px; padding:7px 11px; background:#102030; }
    nav a:hover,.raw-link:hover { border-color:var(--blue); }
    .section-title { margin:46px 0 16px; }
    .legend { display:flex; flex-wrap:wrap; gap:14px; margin-top:12px; color:var(--muted); font-size:13px; }
    .legend span::before { content:""; display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; background:var(--muted); }
    .legend .added::before { background:var(--green); } .legend .modified::before { background:var(--amber); } .legend .removed::before { background:var(--red); }
    .view-card,.flow-card { margin:16px 0; border:1px solid var(--line); border-radius:18px; background:rgba(17,23,34,.92); overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,.22); }
    .view-heading { display:flex; gap:20px; align-items:flex-start; justify-content:space-between; padding:22px 24px; }
    .view-heading p { max-width:780px; }
    .raw-link { flex:none; font-size:13px; }
    .diagram { overflow:auto; border-top:1px solid var(--line); border-bottom:1px solid var(--line); background:#090d14; }
    .diagram img { display:block; width:100%; min-width:820px; height:auto; }
    .asset-meta { padding:8px 24px 10px; color:#718096; font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .hero-grid,.node-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .hero-card,.node-card { padding:18px; border:1px solid var(--line); border-radius:14px; background:var(--panel); }
    .hero-card { display:grid; grid-template-columns:1fr auto 1fr; gap:10px; align-items:center; text-align:center; }
    .hero-card strong { color:var(--amber); font-size:12px; }
    .hero-card p { grid-column:1/-1; text-align:left; padding-top:12px; border-top:1px solid var(--line); }
    .node-heading { display:flex; gap:10px; align-items:center; margin-bottom:9px; }
    .badge { border-radius:999px; padding:3px 8px; background:#293241; color:#cbd5e1; font-size:10px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .badge.added { color:var(--green); background:#123528; } .badge.modified { color:var(--amber); background:#392b15; } .badge.removed { color:var(--red); background:#3d1e21; }
    .files { display:flex; flex-wrap:wrap; gap:6px; margin-top:13px; }
    code { color:#b9d9ee; background:#0b121b; border:1px solid #243143; border-radius:6px; padding:3px 6px; font-size:11px; }
    .flow-card { padding:22px 24px; }
    .flow-card ol { margin:20px 0 0; padding:0; list-style:none; counter-reset:step; }
    .flow-card li { counter-increment:step; display:grid; grid-template-columns:32px minmax(130px,1fr) 2fr minmax(130px,1fr) auto; gap:10px; align-items:center; padding:10px 0; border-top:1px solid var(--line); }
    .flow-card li::before { content:counter(step); display:grid; place-items:center; width:24px; height:24px; border-radius:50%; background:#1a3449; color:var(--blue); font-weight:800; font-size:11px; }
    .flow-card li strong { color:#d9e6f2; font-weight:600; }
    .flow-card li em { color:var(--amber); font-style:normal; }
    .context { margin-top:14px; padding:15px 18px; border-left:3px solid #5c6b7d; background:#10151d; color:var(--muted); }
    footer { margin-top:52px; padding-top:18px; border-top:1px solid var(--line); color:#6f7e90; font-size:12px; }
    @media (max-width:760px) { main { width:min(100% - 20px,1380px); padding-top:30px; } .hero-grid,.node-grid { grid-template-columns:1fr; } .view-heading { display:block; } .raw-link { display:inline-block; margin-top:14px; } .flow-card li { grid-template-columns:28px 1fr; } .flow-card li span:last-of-type,.flow-card li strong,.flow-card li em { grid-column:2; } }
  </style>
</head>
<body>
<main>
  <header>
    <div class="eyebrow">Local PR Lens report · ${escapeHtml(repoName)}</div>
    <h1>${escapeHtml(text(graph.title, "PR Lens report"))}</h1>
    <p class="lead">${escapeHtml(text(graph.summary, "Architecture and data-flow views of the current change."))}</p>
    <div class="meta">${escapeHtml(branchLine)}${graphSha ? ` · ${escapeHtml(shortSha(graphSha))}` : ""}${graphHash ? ` · graph ${escapeHtml(graphHash.slice(0, 10))}` : ""}</div>
  </header>

  <section class="stats" aria-label="Change metrics">${statCards.map(renderStat).join("")}</section>
  <nav aria-label="Report sections">
    <a href="#diagrams">Diagrams</a>
    ${heroCards ? '<a href="#connections">Key connections</a>' : ""}
    ${flowSections ? '<a href="#sequence">Sequence</a>' : ""}
    <a href="#inventory">Changed areas</a>
  </nav>

  <section id="diagrams">
    <div class="section-title">
      <span class="kicker">Visual overview</span>
      <h2>${diagramCards.length} diagrams, together and labeled</h2>
      <p>Scroll horizontally inside a diagram when its labels need more room. Each SVG is embedded, so this HTML remains viewable on its own.</p>
      <div class="legend"><span class="added">Added</span><span class="modified">Modified</span><span class="removed">Removed</span><span>Unchanged context</span></div>
    </div>
    ${diagramCards.join("")}
  </section>

  ${
    heroCards
      ? `<section id="connections"><div class="section-title"><span class="kicker">Architectural center</span><h2>Key connections</h2></div><div class="hero-grid">${heroCards}</div></section>`
      : ""
  }

  ${
    flowSections
      ? `<section id="sequence"><div class="section-title"><span class="kicker">Plain-language trace</span><h2>What happens, in order</h2></div>${flowSections}</section>`
      : ""
  }

  <section id="inventory">
    <div class="section-title"><span class="kicker">Source map</span><h2>${changedNodes.length} changed areas</h2><p>The diagram's components mapped back to their source files.</p></div>
    <div class="node-grid">${changedNodes.map(renderNode).join("")}</div>
    ${
      contextNodes.length
        ? `<div class="context"><strong>Unchanged context:</strong> ${contextNodes.map((node) => escapeHtml(node.label)).join(" · ")}</div>`
        : ""
    }
  </section>

  <footer>Generated locally from <code>${escapeHtml(path.basename(graphPath))}</code> and <code>${escapeHtml(path.basename(manifestPath))}</code>. No PR or remote asset was modified.</footer>
</main>
</body>
</html>`;

  await writeFile(outputPath, html, "utf8");
  console.log(outputPath);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
