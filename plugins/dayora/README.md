<img src="assets/logo.png" alt="Dayora" width="72">

# Dayora plugin

Your [Dayora](https://www.dayora.ai/?utm_source=plugin_directory&utm_medium=directory&utm_campaign=plugin_bundle) journal in Claude, with your permission. Dayora is an AI journaling app: you write entries, Dayora replies to each one, and you can log a mood for each day.

This plugin bundles two things:

- **Dayora's MCP server** (`https://www.dayora.ai/api/mcp`). The first time it is used, you sign in on Dayora's own page and choose whether Claude may only read, or also add entries and log your mood.
- **The `dayora` skill**, which tells Claude how to treat a private journal: use it only when you ask, write only words you gave or approved, never copy your journal into files or other tools, and pass Dayora's reply on unchanged.

## Install

In Claude Code:

```
/plugin install dayora --marketplace Dayora-ai/skills
```

## What it can do

- List your entries, newest first, and find the ones that mention certain words.
- Read a whole entry together with the reply Dayora wrote to it.
- Read your day moods (rough, low, okay, good, great) for up to 400 days.
- If you allow it when you connect: save a new entry in your words, and Dayora replies to it just as it does in the app; log a mood for today or a past day.

It cannot change or delete an entry or a mood, or see or change your account, plan, settings or export.

## Where your data goes

The plugin talks only to dayora.ai. It holds no code of its own and stores nothing: everything it reads or writes goes between Claude and your Dayora account, under Dayora's [privacy policy](https://www.dayora.ai/privacy). What Claude reads from your journal is part of your conversation with Claude. Dayora is a journal, not therapy or a medical service. You need a Dayora account and must be at least 13.

## Stop it any time

In Dayora, Profile, then AI agents, then Disconnect. It stops at once.

## Help

Guide: [Connect Claude, ChatGPT or another app](https://www.dayora.ai/how-to/connect-claude-chatgpt?utm_source=plugin_directory&utm_medium=directory&utm_campaign=plugin_bundle). Support: human@dayora.ai. Licence: MIT.
