# claude_code_mod

A collection of plugins (mods) that extend the local Claude Code harness.

## Plugins

| Plugin | Purpose |
| --- | --- |
| [`prompt-optimizer`](plugins/prompt-optimizer) | Attaches a hidden "clarify or proceed" instruction to short or vague prompts: if a key decision is missing, Claude asks at most 3 questions first; otherwise it proceeds and states its assumptions on the first line of the reply |
| [`session-picker`](plugins/session-picker) | Control panel (Traditional Chinese UI): a button band above the prompt and a docked pane with **Session** (10 most recent unfinished sessions, click to `/resume`), **Tool**, **MCP** (enable/disable), **流程** (plan progress + live tool/agent/MCP activity, secrets masked) and **記憶** (loaded memory files: view or copy path) tabs, plus copy buttons for paths/URLs under each reply |

## Launchers

| Launcher | Purpose |
| --- | --- |
| [`start-claude`](launchers/start-claude) | Windows double-click launcher: choose billing before Claude Code starts — `1` subscription (OAuth; clears the API key for that window only and requires `authMethod` `claude.ai`) or `2` API key (`--bare`, re-loads `CLAUDE.md` with `--add-dir`). Set the user environment variable `CLAUDE_WORKDIR` to your work folder. Details (Traditional Chinese): [`launchers/start-claude/README.md`](launchers/start-claude/README.md) |

## Installation

These plugins use Claude Code's **function hooks** (`hooks/register.ts`), which is an early access API.

```bash
git clone https://github.com/bai-collab/claude_code_mod
claude --plugin-dir ./claude_code_mod/plugins/prompt-optimizer
```

You can also try the marketplace route (not yet verified for function-hook plugins):

```text
/plugin marketplace add bai-collab/claude_code_mod
/plugin install prompt-optimizer@claude-code-mod
```

## prompt-optimizer

| Usage | Effect |
| --- | --- |
| Type a prompt as usual | In `short-only` mode, prompts under 80 characters get the guidance |
| Start the prompt with `* ` (asterisk + space) | Skips the guidance for that one prompt. The `* ` is removed only when the guidance would otherwise apply |
| `/prompt-optimizer` | Pauses or resumes the plugin for the current session |
| `/config` | Change `mode` (`short-only` / `always` / `off`) and `minLength` |

- Only prompts you typed (in the terminal or through Remote Control) are affected. Background notifications, scheduled tasks and messages from other sessions are not.
- The guidance is added as `context` that the model reads but you never see, so your prompt text is not rewritten.
- While the plugin is active, the status line shows `PO: on`.

## session-picker

Details (Traditional Chinese): [`plugins/session-picker/README.md`](plugins/session-picker/README.md).

```bash
cd <your work folder>          # the Session tab lists this folder's sessions
claude --plugin-dir <clone>/plugins/session-picker
```

On Windows you can double-click `plugins/session-picker/open-claude-with-panel.cmd`. After a fresh clone, first set the user environment variable `CLAUDE_WORKDIR` to your work folder (otherwise it uses the folder two levels above the plugin). The launcher also expects `ANTHROPIC_API_KEY` at user level.

| Entry | Effect |
| --- | --- |
| Band buttons `Session Tool MCP 流程 記憶` | Open the panel on that tab (mouse clicks need the fullscreen layout) |
| `/sessions`, `/panel` | Open the panel |
| `/panel auto on\|off` | Auto-open the panel on session start |
| `/panel copybar on\|off` | Show/hide copy buttons under replies |

- Reads only: session transcripts (titles), `planned/*.md`, memory files, and `~/.claude.json` (only the disabled-MCP name lists). Writes nothing; runs only its own read-only Node script and `/resume`, `/mcp enable|disable` when you press those buttons.
- `.claude-plugin/types/` is generated locally by `/plugin-types` and is not committed.

## Development

```bash
claude plugin validate plugins/prompt-optimizer
claude plugin test plugins/prompt-optimizer
```
