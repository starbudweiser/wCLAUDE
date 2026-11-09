# wCLAUDE

A macOS browser that any MCP-compatible AI agent can fully drive — tabs, reading, clicks, typing, file uploads of any size, tidy downloads, a per-site iPhone mode and Keychain sign-in — while you watch it work in a real, visible window with your own signed-in sessions.

## About

- **Authors:** Starbudweiser & Claude Code (Anthropic)
- **License:** MIT. © 2026 Starbudweiser.
- **Disclaimer:** provided as is, without warranty. Built with Electron and Chromium, not affiliated with their authors.
- Version, credits and license are also shown in the app: **wCLAUDE menu › About wCLAUDE**.

## Why

General-purpose browser tools for agents hit the same walls: uploads capped at a few megabytes, browsers that screen control can only *read*, mobile-only site features (an Instagram profile link, for instance) that desktop emulation does not unlock, and downloads that land somewhere the agent cannot find. wCLAUDE removes those technical limits:

| Need | wCLAUDE |
| --- | --- |
| Upload a 241 MB video or a 54 MB archive | Local paths go straight to the browser engine (`DOM.setFileInputFiles`): no size limit, no copy. Works with file inputs, buttons that open the file picker, and drag-and-drop zones. |
| Use a site's mobile-only features | Per-site **iPhone mode**: iPhone user agent and platform, 390 px screen, touch events, no desktop client hints. Remembered per site. |
| Find downloaded files | Every download is saved under its real name in `~/Downloads/wCLAUDE`, listed by `browser_downloads`. |
| Stay signed in | A persistent profile: you sign in once per site, in the wCLAUDE window. |
| Sign in without exposing passwords | **Keychain fill**: wCLAUDE fills the form from your macOS Keychain after you approve in a macOS dialog. The agent never receives the password. |
| See what the agent does | The toolbar shows which agent is acting and what it is doing; the tab it works on comes to the front. |

## Requirements

- macOS 13 or later, Apple silicon.
- An AI agent that supports MCP servers over stdio (Claude Code, Claude Desktop, Cursor, Codex CLI, Gemini CLI, VS Code, Windsurf, Zed…). No Node.js install is needed: the MCP server runs on the engine bundled in the app.

## Connect your agent

The MCP server is a launcher inside the app. **wCLAUDE › Settings › Copy MCP configuration** copies the snippet below with the right path. With the app in `~/Applications/Applications Personnelles`:

```
~/Applications/Applications Personnelles/wCLAUDE.app/Contents/Resources/app/app/bin/wclaude-mcp
```

**Claude Code**

```bash
claude mcp add --scope user wclaude -- "$HOME/Applications/Applications Personnelles/wCLAUDE.app/Contents/Resources/app/app/bin/wclaude-mcp"
```

**Claude Desktop, Cursor (`~/.cursor/mcp.json`), Gemini CLI (`~/.gemini/settings.json`), Windsurf**

```json
{ "mcpServers": { "wclaude": { "command": "/Users/<you>/Applications/Applications Personnelles/wCLAUDE.app/Contents/Resources/app/app/bin/wclaude-mcp", "args": [] } } }
```

**Codex CLI (`~/.codex/config.toml`)**

```toml
[mcp_servers.wclaude]
command = "/Users/<you>/Applications/Applications Personnelles/wCLAUDE.app/Contents/Resources/app/app/bin/wclaude-mcp"
```

**VS Code (`.vscode/mcp.json`)**

```json
{ "servers": { "wclaude": { "type": "stdio", "command": "/Users/<you>/Applications/Applications Personnelles/wCLAUDE.app/Contents/Resources/app/app/bin/wclaude-mcp" } } }
```

The server starts wCLAUDE in the background when needed (it never takes the focus) and reconnects if the app restarts.

## Tools

| Tool | What it does |
| --- | --- |
| `browser_tabs` | List, open, select, close tabs; also reports the downloads folder and the sites in iPhone mode. |
| `browser_navigate` | Open an address, or go back / forward / reload. |
| `browser_snapshot` | Accessibility snapshot with element refs (`ref=e12`) used by the other tools. |
| `browser_page_text` | Visible text of the page or of one element. |
| `browser_screenshot` | Screenshot of the viewport, the full page or one element (optionally saved to a file). |
| `browser_click` / `browser_tap` | Click (mouse) or tap (touch) an element or a point. |
| `browser_type` / `browser_press_key` | Type into fields, press keys and shortcuts. |
| `browser_hover` / `browser_select_option` / `browser_scroll` | Hover, choose in lists, scroll. |
| `browser_upload_files` | Upload local files of any size (file input, file picker button, or drop zone). |
| `browser_wait_for` | Wait for a text to appear or disappear, an element, or a delay. |
| `browser_downloads` | List downloads and wait for one to finish. |
| `browser_mobile_mode` | Switch a site to its iPhone version, or back to desktop. |
| `browser_keychain_fill` | Fill the page's sign-in form from the macOS Keychain, after the user's approval. |
| `browser_evaluate` | Run JavaScript in the page. |
| `browser_handle_dialog` / `browser_console` | Answer JavaScript dialogs; read console messages. |

## Guardrails that do not change

"No limits" means no *technical* limit of the tool, not the absence of these rules:

- **Passwords and bank details are never typed by the agent.** `browser_type` and `browser_press_key` refuse password and payment-card fields; sign-in goes through `browser_keychain_fill`, which needs your approval in a macOS dialog each time and never returns the password to the agent. While a password field is filled, `browser_evaluate` is disabled so a script cannot read it back.
- **CAPTCHAs are never bypassed.** The agent asks you to solve them in the wCLAUDE window.
- **Your consent comes first** before anything is published or posted, a message is sent, something is bought, terms are accepted or anything is deleted. The MCP server states this rule to every agent; the agent asks, you answer.
- **Control stays on this Mac.** The control port and the debugging port only listen on 127.0.0.1, the control API requires a token stored in a file only you can read (`control.json`, mode 600), and **Settings › Allow control by an AI agent** turns control off entirely. While control is on, any program running under your account could connect to the debugging port, as with any browser started with remote debugging.

## Keychain sign-in

wCLAUDE reads the **Internet passwords of your login keychain**. Passwords saved by Safari and the Passwords app live in the iCloud Keychain, which Apple reserves for its own apps, so they cannot be read by any third-party app. Add a sign-in once with **File › Add a Sign-in to the Keychain…** (you type it in a wCLAUDE window; it goes straight into your Keychain). Then either click **Keychain** in the toolbar, or let the agent call `browser_keychain_fill`. Each fill asks for your approval with Touch ID, Apple Watch or your login password.

## Files

| What | Where |
| --- | --- |
| Profile (cookies, sessions), settings, control file | `~/Library/Application Support/wCLAUDE` |
| Downloads | `~/Downloads/wCLAUDE` |

`WCLAUDE_SUPPORT_DIR`, `WCLAUDE_DOWNLOADS_DIR` and `WCLAUDE_CDP_PORT` run a separate edition (tests) without touching your data.

## Updates

wCLAUDE checks GitHub releases once a day, shows the notes of every newer version, then downloads, verifies (SHA-256, bundle identifier, version, code signature, Developer ID team) and installs it, and relaunches. It never installs while an agent is acting. **Settings › Install updates automatically** installs at quit; **wCLAUDE › Check for Updates…** checks now.

## Build

```bash
npm ci
npm test              # translations, domains
scripts/build.sh      # Keychain helper (Swift), package, signature, install
node test/e2e.mjs <big-file> [launcher]   # end-to-end: an MCP client drives the app on local test pages
```

`release.sh` builds, notarizes, zips and publishes a GitHub release with its `.sha256`.

## Languages

French, English, Spanish and Italian, chosen from the system's preferred language (English otherwise).
