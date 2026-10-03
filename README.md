# claude_code_mod

A collection of plugins (mods) that extend the local Claude Code harness.

## Plugins

| Plugin | Purpose |
| --- | --- |
| [`prompt-optimizer`](plugins/prompt-optimizer) | Attaches a hidden "clarify or proceed" instruction to short or vague prompts: if a key decision is missing, Claude asks at most 3 questions first; otherwise it proceeds and states its assumptions on the first line of the reply |

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

## Development

```bash
claude plugin validate plugins/prompt-optimizer
claude plugin test plugins/prompt-optimizer
```
