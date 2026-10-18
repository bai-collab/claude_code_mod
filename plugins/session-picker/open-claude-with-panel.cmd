@echo off
rem Start Claude Code in the repo root with the session-picker control panel loaded.
rem Double-click, or make a desktop shortcut that points here.
rem Loads this folder with --plugin-dir; usage-guard (CLAUDE_CODE_PLUGIN_DIRS), hooks and CLAUDE.md load as usual.
rem The key comes from the user-level ANTHROPIC_API_KEY variable; never put it here or echo it.
rem Extra arguments are passed through, e.g. open-claude-with-panel.cmd --resume
setlocal
set "PLUGIN_DIR=%~dp0."
rem Work folder: CLAUDE_WORKDIR (user env var) if set, else two levels up (local repo layout).
if not defined CLAUDE_WORKDIR (
  for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v CLAUDE_WORKDIR 2^>nul ^| findstr /i CLAUDE_WORKDIR') do set "CLAUDE_WORKDIR=%%B"
)
if not defined CLAUDE_WORKDIR set "CLAUDE_WORKDIR=%~dp0..\.."
cd /d "%CLAUDE_WORKDIR%" || (echo Cannot open work folder: %CLAUDE_WORKDIR% & pause & exit /b 1)
if not defined ANTHROPIC_API_KEY (
  for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v ANTHROPIC_API_KEY 2^>nul ^| findstr /i ANTHROPIC_API_KEY') do set "ANTHROPIC_API_KEY=%%B"
)
call claude.cmd auth status | findstr /c:"\"api_key\"" >nul
if errorlevel 1 (
  echo Not using an API key. Set ANTHROPIC_API_KEY at user level, then retry.
  call claude.cmd auth status
  pause
  exit /b 1
)
title Claude + control panel - %CD%
call claude.cmd --plugin-dir "%PLUGIN_DIR%" %*
if errorlevel 1 pause
endlocal
