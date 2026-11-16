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
| Get past sign-ins, CAPTCHAs and blocks | **Hand-over**: the agent stops and asks you to act in the window; it resumes when you click DONE. wCLAUDE never tries to get past these checks itself. |
| Work with YouTube reliably | **Official YouTube API**: uploads of any size (resumable), titles, descriptions, thumbnails, scheduling and analytics — no web page to drive. |

## Requirements

- macOS 13 or later, Apple silicon.
- An AI agent that supports MCP servers over stdio (Claude Code, Claude Desktop, Cursor, Codex CLI, Gemini CLI, VS Code, Windsurf, Zed…). No Node.js install is needed: the MCP server runs on the engine bundled in the app.

## Connect your agent

wCLAUDE talks to AI agents through the **Model Context Protocol (MCP)**. The MCP server ships inside the app: there is nothing to install, no Node.js, no API key. You only tell your agent where the server is, once.

### 1. Install and open wCLAUDE

Move `wCLAUDE.app` to `/Applications` (or any folder you like), open it once, and check that **wCLAUDE › Settings › Allow control by an AI agent** is on (it is by default).

### 2. Copy the configuration

Click **wCLAUDE › Settings › Copy MCP configuration**. It copies a ready-made block with the exact path of the server on your Mac, for example:

```json
{ "mcpServers": { "wclaude": { "command": "/Applications/wCLAUDE.app/Contents/Resources/app/app/bin/wclaude-mcp", "args": [] } } }
```

The server is the file `Contents/Resources/app/app/bin/wclaude-mcp` inside the app. If you move the app later, copy the configuration again.

### 3. Add it to your agent

In the examples below, replace the path with yours if the app is not in `/Applications`.

**Claude Code** (in a terminal, then restart Claude Code)

```bash
claude mcp add --scope user wclaude -- "/Applications/wCLAUDE.app/Contents/Resources/app/app/bin/wclaude-mcp"
```

**Claude Desktop**: **Settings › Developer › Edit Config** opens `~/Library/Application Support/Claude/claude_desktop_config.json`. Paste the copied block (merge it into `mcpServers` if the file already has one), save, then quit and reopen Claude Desktop.

**Cursor** (`~/.cursor/mcp.json`, or **Settings › MCP › Add new MCP server**), **Gemini CLI** (`~/.gemini/settings.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`): paste the same block.

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.wclaude]
command = "/Applications/wCLAUDE.app/Contents/Resources/app/app/bin/wclaude-mcp"
```

**VS Code** (`.vscode/mcp.json` in a project, or **MCP: Add Server** in the command palette)

```json
{ "servers": { "wclaude": { "type": "stdio", "command": "/Applications/wCLAUDE.app/Contents/Resources/app/app/bin/wclaude-mcp" } } }
```

### 4. Check that it works

Restart the agent, then:

- in Claude Code, type `/mcp`: **wclaude** is listed as connected, with its `browser_*`, `watch_*` and `youtube_*` tools;
- in any agent, ask: *"List my wCLAUDE tabs"*. The agent calls `browser_tabs` and **wCLAUDE › Settings** shows it as the last connected agent.

The server starts wCLAUDE in the background when needed (it never takes the focus) and reconnects if the app restarts. To keep wCLAUDE always ready, turn on **Settings › Open wCLAUDE at login, in the background**.

### If it does not connect

- *"Could not start wCLAUDE"*: open the app once, and check that **Allow control by an AI agent** is on (changing it takes effect at the next launch).
- The agent does not list the tools: the path is wrong (app moved or renamed). Copy the configuration again from Settings and restart the agent.
- New tools after a wCLAUDE update: restart the agent so it reloads the server.

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
| `browser_request_user` | Hand over to the user (sign-in, CAPTCHA, two-factor code, blocked access) and wait until they click DONE. |
| `watch_digest` | What changed in the watched sources since last read, grouped, with each source's note for the agent; then sources that need you or failed. |
| `watch_list` / `watch_add` | List the watched sources; add one (or update it): page, RSS/Atom feed or GitHub releases, detected automatically. |
| `watch_check` / `watch_history` / `watch_read` | Check now, read a source's past items, mark items read. |
| `youtube_status` / `youtube_connect` | YouTube API set-up state; connect the channel (consent in the user's usual browser). |
| `youtube_channel` / `youtube_list_videos` / `youtube_get_video` | Channel figures, videos with privacy, schedule and statistics, video details. |
| `youtube_upload_video` / `youtube_upload_status` | Upload a local video of any size in the background (private by default) and follow it. |
| `youtube_update_video` / `youtube_set_thumbnail` | Change title, description, tags, category, privacy, scheduled date; set a thumbnail. |
| `youtube_list_captions` / `youtube_upload_caption` | List a video's subtitle tracks; add or replace one from a local SRT, VTT, SBV, SCC or TTML file. |
| `youtube_analytics` | Views, watch time, average view duration, likes, subscribers gained… per day, video or country. |

## Guardrails that do not change

"No limits" means no *technical* limit of the tool, not the absence of these rules:

- **Passwords and bank details are never typed by the agent.** `browser_type` and `browser_press_key` refuse password and payment-card fields; sign-in goes through `browser_keychain_fill`, which needs your approval in a macOS dialog each time and never returns the password to the agent. While a password field is filled, `browser_evaluate` is disabled so a script cannot read it back.
- **CAPTCHAs and anti-bot checks are never bypassed or hidden from.** The agent hands over with `browser_request_user` and you deal with them in the wCLAUDE window.
- **Your consent comes first** before anything is published or posted, a message is sent, something is bought, terms are accepted or anything is deleted. The MCP server states this rule to every agent; the agent asks, you answer.
- **Control stays on this Mac.** The control port and the debugging port only listen on 127.0.0.1, the control API requires a token stored in a file only you can read (`control.json`, mode 600), and **Settings › Allow control by an AI agent** turns control off entirely. While control is on, any program running under your account could connect to the debugging port, as with any browser started with remote debugging.

## Hand-over to the user

Some steps belong to you: signing in without a saved Keychain entry, CAPTCHAs, two-factor codes, "unusual activity" blocks. When the agent meets one (wCLAUDE flags these pages in its answers), it calls `browser_request_user`: a bar appears under the toolbar with what to do, macOS shows a notification (wCLAUDE does not take the focus), and the agent waits. Click **DONE** when you are finished, or **Cancel**.

Some sites refuse to let you sign in from any browser an agent can control (Google shows "This browser or app may not be secure"). wCLAUDE does not try to hide from those checks. Instead, **File › Import Google Session from <browser>…** copies the Google session (and the one of the site currently open) from a Chromium browser where you are already signed in (Chrome, Brave, Edge, Vivaldi): you sign in there yourself, once, and wCLAUDE keeps the session in its persistent profile, so it stays signed in after a relaunch (Google Flow, Flow Music, Gemini, YouTube…). The agent never sees or types your password. When the session expires, import it again.

## Watch

wCLAUDE can keep an eye on pages, RSS/Atom feeds and GitHub releases while no agent is around, and hand the agent a digest when it comes back (`watch_digest`). Open it with the **Watch** button of the toolbar (address `wclaude://veille`) or from the menu bar icon, which shows a blue dot when there is something new.

- Each source is an address plus a **note for the agent** (what matters, what to ignore); a group can carry a shared brief.
- **No AI in the app**: detection is deterministic. Pages are read in a hidden wCLAUDE view, with your sessions; feeds and GitHub releases with a plain request. The first reading is the reference and raises no alert. After that: added lines of the page (or of a chosen **page area**), new feed entries, new releases, or a higher version number. **Keywords** limit alerts to additions that mention them. Click **Test** before adding to see what wCLAUDE reads.
- One silent, grouped notification per pass (it can be turned off in Settings › Watch). Data: `watch.json` in the profile folder.

Limits: the watch only runs while wCLAUDE is open (the menu bar mode, the default, keeps it running; **Settings › Open wCLAUDE at login** makes it permanent). A page that changes all the time gives false alerts: use the page area, keywords and Test. Sign-in walls, CAPTCHAs and anti-bot checks are never bypassed: the source is marked as needing you, and the agent can hand over with `browser_request_user`. Discord and social networks are not supported.

## YouTube API

The `youtube_*` tools use the official YouTube Data API v3 and YouTube Analytics API. One-time set-up, with your Google account:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick one).
2. **APIs & Services › Library**: enable **YouTube Data API v3** and **YouTube Analytics API**.
3. **Google Auth Platform › Branding / Audience**: create the consent screen (External, Testing) and add your Google account as a **test user**.
4. **Clients › Create client › Desktop app**, then download the JSON file.
5. In wCLAUDE: **Settings › YouTube › Choose the OAuth key file…**, then **Connect YouTube** and approve in your usual browser.

The key and tokens are stored in your Keychain and never shared with the agent. Uploads are private unless you approve otherwise. The default quota (10,000 units a day) allows about six uploads a day; a subtitle track costs 400 units.

Connected with version 1.0.0? Subtitles need one more permission: click **Settings › YouTube › Reconnect YouTube** once.

## Keychain sign-in

wCLAUDE reads the **Internet passwords of your login keychain**. Passwords saved by Safari and the Passwords app live in the iCloud Keychain, which Apple reserves for its own apps, so they cannot be read by any third-party app. Add a sign-in once with **File › Add a Sign-in to the Keychain…** (you type it in a wCLAUDE window; it goes straight into your Keychain). Then either click **Keychain** in the toolbar, or let the agent call `browser_keychain_fill`. Each fill asks for your approval with Touch ID, Apple Watch or your login password.

## Files

| What | Where |
| --- | --- |
| Profile (cookies, sessions), settings, control file, watch (`watch.json`) | `~/Library/Application Support/wCLAUDE` |
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
