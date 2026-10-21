---
description: Review a GitHub pull request without changing the repository
argument-hint: "<link to GitHub pull request>"
---
PR link: $1

Prompt templates cannot run slash commands, so start your reply with one line that asks the user to rename this session. In Pi the command is `/name "Pull Request $1"`. In Claude Code the command is `/rename "Pull Request $1"`.

Review the pull request linked above. Follow these steps:

1. Fetch the pull request details, diff, and any related issue or discussion. Use `gh`, `curl`, `git`, or other available tools as needed. If `gh` is available, prefer `gh pr view` and `gh pr diff`.
2. Read the relevant source files in the repository to understand the context of the changes.
3. Analyze the changes for correctness, security, performance, maintainability, test coverage, and clarity.

Do **not** take any action that modifies the repository or creates new state. Do not create branches, commits, pull requests, code changes, or file edits. Do not use file edit or write tools, and do not run any shell command that modifies files.

Write your findings in this chat. Structure the review with:
- Summary
- Detailed comments (with file paths and line numbers when applicable)
- Overall verdict and any recommendations
