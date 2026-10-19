# How MCP skills load

This extension implements the host side of the MCP Skills extension (`io.modelcontextprotocol/skills`, SEP-2640) for Pi.

## Connections

The extension reads servers from the same sources and in the same order as Pi's built-in MCP support: the global `mcp.json`, a trusted project's `.pi/mcp.json`, and servers other extensions register. Disabled servers and servers with `hidden` exposure are left out. The configuration is read again before each prompt, and servers reconnect only when it changed.

It opens its own connection to each server and declares the skills extension. Pi's own MCP connections are not changed, so a server that serves skills runs twice: once for Pi's tools and once for skills. A server that does not declare the extension is closed again right away; one that failed or needed sign-in is tried again before a prompt, at most once a minute.

OAuth sign-in settings in `oauth` are ignored, not validated: this extension does not perform sign-in. A server can therefore be accepted here even if Pi rejects its `oauth` block. Transport validation, project trust, and provider-credential restrictions still apply.

Servers are authenticated the way Pi authenticates them. Servers with `auth.provider` get the provider's current token from Pi. For OAuth servers the extension sends the token Pi stores after `/mcp` sign-in and never refreshes it itself; Pi refreshes it when it uses one of the server's tools, or `/mcp` asks you to sign in again.

Connecting only lists skills. No skill file is fetched until a skill is loaded.

## Loading

Each skill appears in Pi's skill list as `<server>:<name>`, with its server in the description. When a server lists a name twice, or the name is already taken, the name ends in `-` and hex digits from the skill's URI. Its location is a `SKILL.md` path in a folder for that version of the skill: `~/.pi/agent/mcp-skills/<server>/<revision>/<scheme>/<path>`. Nothing is there until the skill is loaded, so a skill that changes on its server gets a new path.

A `read` of that path loads the skill, through whichever extension provides `read`, as does `/skill:<server>:<name>` or a `$` mention. Loading asks for approval with the skill's server, URI, file count, size, and any scripts. This is the skill's only approval: allowing it also lets the commands it asks for run without further prompts, as the MCP Skills extension requires per-skill approval before skill content causes code execution. _Allow until Pi exits_ lasts for this Pi process; _Always allow this version_ is remembered in `~/.pi/agent/data/mcp-skills/approvals.json`. Both end when any file of the skill changes. Without an interactive UI, only earlier approvals load.

An approved skill is fetched whole: every file it lists is checked against its listing, by byte size, SHA-256 digest, and for `SKILL.md` its frontmatter field by field, then written to its folder, which is moved into place in one step and not changed after. A stored copy is checked again every time the skill loads. If anything fails a check, nothing is used and the extension asks the server for the skill's current entry; a changed skill is offered at its new path and must be approved again. Errors fetching or writing files are reported as they are. Dynamically generated skills cannot be checked and are not offered, and skills a server does not list cannot be loaded.

The skill's other files are ordinary files from then on: the model reads them with `read`, lists them, and runs its scripts. Reading any other `SKILL.md` in the folder, such as an older version or a skill nested in another one, is blocked, since it was not approved there.

The `read` that loads a skill, and the `/skill:` block, start with the skill's server, its URI, and its folder, and say that its content is untrusted.

## While a skill is in use

A skill is in use while the message that loaded it is on the session branch, including after a resume. While skills from one server are in use, `read_mcp_resource` asks first when it reads from another server, and so does loading a skill from another server, even one approved before; without an interactive UI those are blocked. Frontmatter fields such as `allowed-tools` grant nothing.

## Stored files

Loaded skills stay in `~/.pi/agent/mcp-skills/` until `/mcp-skills forget`, which also drops every approval. They are not checked when commands run them.
