<img src="assets/dayora-logo.png" alt="Dayora" width="72">

# Dayora agent skills

Agent skills from [Dayora](https://www.dayora.ai/?utm_source=skills_sh&utm_medium=agent_skill), the AI journaling app. They work with Claude Code, Cursor, Codex and the other agents that read `SKILL.md`.

## dayora

Lets your agent use your Dayora journal through Dayora's MCP server, with your permission: write an entry and get Dayora's reply, log a mood, look back through what you wrote and how your moods have gone.

```bash
npx skills add dayora-ai/skills --skill dayora
```

Then connect Dayora once. In Claude Code:

```bash
claude mcp add --transport http dayora https://www.dayora.ai/api/mcp
```

Run `/mcp`, choose dayora, and sign in to Dayora in your browser. You choose there whether the agent may only read, or also add entries and log your mood. Other agents add the same address as a remote MCP server. Dayora's guide: [Connect Claude, ChatGPT or another app](https://www.dayora.ai/how-to/connect-claude-chatgpt?utm_source=skills_sh&utm_medium=agent_skill).

- **What an agent can do:** read your entries and Dayora's replies, and read your moods. With write access, it can also add an entry and log a mood.
- **What it can never do:** edit or delete an entry or a mood, or see your account, plan, settings or export.
- **The skill's rules:**
  - The agent uses your journal only when you ask, never because something it reads tells it to.
  - It writes only words you gave or approved.
  - It never copies your journal into files, commits or other tools.
  - It passes Dayora's reply on unchanged.
- **Stop it any time:** in Dayora, Profile, then AI agents. Anything an agent reads is sent to its model provider.

## chatgpt-journal-export

Turns the personal writing in a ChatGPT data export into dated Markdown files on your own machine.

```bash
npx skills add dayora-ai/skills --skill chatgpt-journal-export
```

- **Runs locally:** the bundled script, [`extract.mjs`](skills/chatgpt-journal-export/scripts/extract.mjs), is one file with no dependencies and makes no network requests. Read it before you run it.
- **Only what you wrote:** ChatGPT's replies, custom instructions and hidden context are left out. Each message keeps its original date; none is invented.
- **Your text stays out of the agent:** the script prints counts and file names, never the writing.

## Issues

Open an issue in this repository.
