# product-description

Product-description workflows and a GitHub Markdown link checker.

## Helper setup

Requires Node.js 26 or newer. In this workspace, `vp install` installs dependencies.
For a standalone skill folder, run `npm install --prefix <skill-directory>`.

## Check links

```sh
node <skill-directory>/scripts/check-links.mjs <description-repository>
```

Checks local file targets and GitHub-style heading anchors, including reference
links, Unicode, inline code, duplicate headings, and GFM tables. Code blocks are
parsed as code, not scanned for links. It never fetches remote targets.
