#!/usr/bin/env node
// Turns your own writing in a ChatGPT data export into dated Markdown files.
//
// Runs entirely on this machine: it imports nothing but Node's own fs, path
// and zlib, and makes no network requests. It prints counts and file names,
// never the text, so the writing does not pass through the agent that runs it.
//
// Usage: node extract.mjs <export.zip | conversations.json> [options]
// Run with --help for the options.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** JSON.parse on a string much larger than this runs out of memory at Node's default heap. */
const MAX_JSON_BYTES = 400 * 1024 * 1024
const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024
const DEFAULT_MIN_SCORE = 0.5
/** A timestamp more than a day ahead of this machine's clock is treated as missing, not trusted. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000

const USAGE = `Usage: node extract.mjs <export.zip | conversations.json> [options]

Writes the messages YOU wrote in a ChatGPT data export to dated Markdown.
ChatGPT's replies are left out. Nothing leaves this machine.

Options:
  --out <folder>      Where to write (default: ./chatgpt-journal)
  --split <mode>      none (one file, default), day, or month
  --journal-like      Keep only messages that read like journaling
                      (English-only heuristic; leaves out requests and code)
  --min-score <0-1>   How journal-like a message must be (default 0.5)
  --tz <Area/City>    Timezone for dates (default: this machine's)
  --dry-run           Count only; write nothing
  --force             Overwrite files left by an earlier run
  -h, --help          Show this help`

class ExportError extends Error {}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    input: null,
    out: 'chatgpt-journal',
    split: 'none',
    journalLike: false,
    minScore: DEFAULT_MIN_SCORE,
    tz: null,
    dryRun: false,
    force: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) fail(`${arg} needs a value.\n\n${USAGE}`, 2)
      return next
    }
    switch (arg) {
      case '--out': opts.out = value(); break
      case '--split': opts.split = value(); break
      case '--journal-like': opts.journalLike = true; break
      case '--min-score': opts.minScore = Number(value()); opts.journalLike = true; break
      case '--tz': opts.tz = value(); break
      case '--dry-run': opts.dryRun = true; break
      case '--force': opts.force = true; break
      case '-h':
      case '--help':
        process.stdout.write(`${USAGE}\n`)
        process.exit(0)
      default:
        if (arg.startsWith('-')) fail(`Unknown option ${arg}.\n\n${USAGE}`, 2)
        if (opts.input) fail(`Give one export file, not two.\n\n${USAGE}`, 2)
        opts.input = arg
    }
  }
  if (!opts.input) fail(USAGE, 2)
  if (!['none', 'day', 'month'].includes(opts.split)) fail('--split must be none, day or month.', 2)
  if (!Number.isFinite(opts.minScore) || opts.minScore < 0 || opts.minScore > 1) {
    fail('--min-score must be a number from 0 to 1.', 2)
  }
  opts.tz ||= Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: opts.tz })
  } catch {
    fail(`Unknown timezone "${opts.tz}". Use a name like Europe/Berlin or America/New_York.`, 2)
  }
  return opts
}

// ---------------------------------------------------------------------------
// Reading the export: conversations.json, or the .zip OpenAI emails.
// The zip is read by offset, so the images and audio in a large export are
// never loaded.
// ---------------------------------------------------------------------------

const DAMAGED = 'That zip looks damaged or incomplete. Download the export again, or unzip it and pass conversations.json instead.'
const TOO_LARGE = 'conversations.json in that export is too large to read in one go. Unzip it and pass the file with more memory: node --max-old-space-size=8192 extract.mjs conversations.json'

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const n = fs.readSync(fd, buffer, done, length - done, position + done)
    if (n === 0) break
    done += n
  }
  if (done !== length) throw new ExportError(DAMAGED)
  return buffer
}

function readConversationsFromZip(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const tailLength = Math.min(size, 65557)
    if (tailLength < 22) throw new ExportError(DAMAGED)
    const tailStart = size - tailLength
    const tail = readAt(fd, tailStart, tailLength)

    let end = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        end = i
        break
      }
    }
    if (end < 0) throw new ExportError(DAMAGED)

    let count = tail.readUInt16LE(end + 10)
    let directorySize = tail.readUInt32LE(end + 12)
    let directoryOffset = tail.readUInt32LE(end + 16)

    // ZIP64 (very large exports): the real values sit in a second end record,
    // found through the locator just before the classic one.
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locatorAt = tailStart + end - 20
      if (locatorAt < 0) throw new ExportError(DAMAGED)
      const locator = readAt(fd, locatorAt, 20)
      if (locator.readUInt32LE(0) !== 0x07064b50) throw new ExportError(DAMAGED)
      const recordAt = Number(locator.readBigUInt64LE(8))
      if (recordAt + 56 > size) throw new ExportError(DAMAGED)
      const record = readAt(fd, recordAt, 56)
      if (record.readUInt32LE(0) !== 0x06064b50) throw new ExportError(DAMAGED)
      count = Number(record.readBigUInt64LE(32))
      directorySize = Number(record.readBigUInt64LE(40))
      directoryOffset = Number(record.readBigUInt64LE(48))
    }
    if (directoryOffset + directorySize > size || directorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new ExportError(DAMAGED)
    }

    const directory = readAt(fd, directoryOffset, directorySize)
    let cursor = 0
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) {
        throw new ExportError(DAMAGED)
      }
      const flags = directory.readUInt16LE(cursor + 8)
      const method = directory.readUInt16LE(cursor + 10)
      let compressed = directory.readUInt32LE(cursor + 20)
      let plain = directory.readUInt32LE(cursor + 24)
      const nameLength = directory.readUInt16LE(cursor + 28)
      const extraLength = directory.readUInt16LE(cursor + 30)
      const commentLength = directory.readUInt16LE(cursor + 32)
      let localAt = directory.readUInt32LE(cursor + 42)
      if (cursor + 46 + nameLength + extraLength + commentLength > directory.length) {
        throw new ExportError(DAMAGED)
      }
      const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength)
      const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)
      cursor += 46 + nameLength + extraLength + commentLength

      if (!/(^|\/)conversations\.json$/i.test(name) || name.includes('__MACOSX/')) continue

      // ZIP64 sizes and offset live in extra field 0x0001, in this order,
      // for whichever of the three were too large for 32 bits.
      if (plain === 0xffffffff || compressed === 0xffffffff || localAt === 0xffffffff) {
        let at = 0
        while (at + 4 <= extra.length) {
          const id = extra.readUInt16LE(at)
          const length = extra.readUInt16LE(at + 2)
          if (id === 0x0001) {
            let field = at + 4
            const take = () => {
              if (field + 8 > at + 4 + length) throw new ExportError(DAMAGED)
              const v = Number(extra.readBigUInt64LE(field))
              field += 8
              return v
            }
            if (plain === 0xffffffff) plain = take()
            if (compressed === 0xffffffff) compressed = take()
            if (localAt === 0xffffffff) localAt = take()
            break
          }
          at += 4 + length
        }
      }

      if (flags & 1) throw new ExportError('That zip is password protected. Unzip it yourself and pass conversations.json.')
      if (plain > MAX_JSON_BYTES) throw new ExportError(TOO_LARGE)
      if (localAt + 30 > size) throw new ExportError(DAMAGED)
      const header = readAt(fd, localAt, 30)
      if (header.readUInt32LE(0) !== 0x04034b50) throw new ExportError(DAMAGED)
      const dataAt = localAt + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
      if (dataAt + compressed > size) throw new ExportError(DAMAGED)
      const data = readAt(fd, dataAt, compressed)

      let text
      if (method === 0) {
        text = data
      } else if (method === 8) {
        try {
          text = zlib.inflateRawSync(data, { maxOutputLength: MAX_JSON_BYTES })
        } catch (err) {
          throw new ExportError(err?.code === 'ERR_BUFFER_TOO_LARGE' ? TOO_LARGE : DAMAGED)
        }
      } else {
        throw new ExportError('That zip uses a compression method this script cannot read. Unzip it and pass conversations.json.')
      }
      if (text.length !== plain) throw new ExportError(DAMAGED)
      return text.toString('utf8')
    }
    throw new ExportError('That zip has no conversations.json, so it is probably not a ChatGPT data export.')
  } finally {
    fs.closeSync(fd)
  }
}

function readExport(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    throw new ExportError(`Cannot find ${file}.`)
  }
  if (!stat.isFile()) throw new ExportError(`${file} is not a file.`)

  const lower = file.toLowerCase()
  let text
  if (lower.endsWith('.zip')) {
    text = readConversationsFromZip(file)
  } else if (lower.endsWith('.json')) {
    if (stat.size > MAX_JSON_BYTES) throw new ExportError(TOO_LARGE)
    text = fs.readFileSync(file, 'utf8')
  } else {
    throw new ExportError('Pass the .zip that OpenAI emailed, or the conversations.json file from inside it.')
  }

  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new ExportError('conversations.json is not valid JSON. The export may be incomplete; download it again.')
  }
}

// ---------------------------------------------------------------------------
// Extraction: only what the person wrote, on the branch they ended on.
// ---------------------------------------------------------------------------

function conversationsOf(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object' && Array.isArray(raw.conversations)) return raw.conversations
  throw new ExportError('conversations.json does not have the shape of a ChatGPT export.')
}

/** Follows the branch the person ended on, so edited or regenerated turns are not doubled. */
function nodesOf(chat) {
  const mapping = chat?.mapping
  if (!mapping || typeof mapping !== 'object') return []
  if (typeof chat.current_node === 'string' && mapping[chat.current_node]) {
    const nodes = []
    const seen = new Set()
    let id = chat.current_node
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id)
      nodes.push(mapping[id])
      id = mapping[id].parent
    }
    return nodes.reverse()
  }
  return Object.values(mapping)
}

function isOwnMessage(message) {
  if (!message || message.author?.role !== 'user') return false
  // Custom instructions and hidden context arrive as user messages nobody typed.
  if (message.author?.metadata?.is_user_system_message === true) return false
  if (message.metadata?.is_user_system_message === true) return false
  if (message.metadata?.is_visually_hidden_from_conversation === true) return false
  if (message.content?.content_type === 'user_editable_context') return false
  return true
}

function textOf(message) {
  const content = message.content
  if (!content) return ''
  if (typeof content.text === 'string' && !Array.isArray(content.parts)) return content.text.trim()
  if (!Array.isArray(content.parts)) return ''
  const pieces = []
  for (const part of content.parts) {
    if (typeof part === 'string') pieces.push(part)
    // Mixed messages wrap text beside image pointers; keep only the text.
    else if (part && typeof part === 'object' && typeof part.text === 'string') pieces.push(part.text)
  }
  return pieces.join('\n').trim()
}

function dateOf(message, chat, now) {
  for (const seconds of [message.create_time, chat.create_time]) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue
    const ms = seconds * 1000
    if (ms > now + FUTURE_TOLERANCE_MS) continue
    return new Date(ms)
  }
  return null
}

// ---------------------------------------------------------------------------
// Journal-likeness: a small, explainable English-only heuristic. Favours
// first-person writing that names feelings or reflects; leaves out requests
// to ChatGPT, code and links.
// ---------------------------------------------------------------------------

const FIRST_PERSON = /\b(i|i'm|im|i've|i'd|i'll|me|my|myself|mine)\b/gi
const FEELING_WORDS = /\b(anxious|anxiety|angry|afraid|scared|ashamed|sad|lonely|exhausted|tired|drained|overwhelmed|numb|guilty|grief|grieving|hurt|frustrated|resentful|jealous|hopeless|stuck|burnt ?out|stressed|worried|nervous|happy|grateful|proud|relieved|calm|content|excited|hopeful|peaceful|joy|love|loved)\b/gi
const TEMPORAL_MARKERS = /\b(today|yesterday|tonight|this morning|this afternoon|this evening|last night|this week|last week|this weekend|lately|recently|these days|right now|all day)\b/gi
const REFLECTION_MARKERS = /\b(i (feel|felt|think|thought|keep|kept|can't|cannot|couldn't|want|wanted|need|needed|noticed|realised|realized|hate|love|miss|wish|know|don't know|guess|suppose|worry|struggle|struggled|tried|keep trying))\b/gi
const RELATIONSHIP_MARKERS = /\b(my (mum|mom|mother|dad|father|partner|husband|wife|boyfriend|girlfriend|son|daughter|kid|kids|brother|sister|friend|boss|manager|therapist|team)|(he|she|they) (said|told me|asked me)|we (talked|argued|fought))\b/gi
const REQUEST_MARKERS = /\b(can you|could you|would you|please (write|make|give|do|help|create|fix|explain)|give me (a|an|some|the)|write (me|a|an)|draft (me|a|an)|generate (a|an|some)|rewrite (this|that|it)|summari[sz]e (this|that|it|the)|translate (this|that|it)|act as|you are a|your task|in bullet points|step by step|what's the best way to|how do i|what is the difference between|explain (this|that|it|how|why))\b/gi
const REQUEST_OPENERS = /^\s*(write|draft|generate|create|make|build|fix|debug|explain|summari[sz]e|translate|rewrite|refactor|convert|list|compare|give|show|tell me how|help me (write|make|build|fix|code|draft))\b/i
// Keywords count only in code-shaped positions: journaling says "let go",
// "my yoga class" and "the export deadline" all the time.
const CODE_MARKERS = new RegExp([
  '```',
  '<\\/[a-z][\\w-]*>',
  '<[a-z][\\w-]*\\s+[a-z-]+=',
  '\\b(?:const|let|var)\\s+[\\w$]+\\s*=',
  '\\bfunction\\s*[\\w$]*\\s*\\([^)]*\\)\\s*\\{',
  '\\bimport\\s+[\\w$*{][^\\n]*\\sfrom\\s+[\'"]',
  '^\\s*import\\s+[\\w.]+(?:\\s+as\\s+\\w+)?\\s*$',
  '^\\s*from\\s+[\\w.]+\\s+import\\s+\\w',
  '\\bexport\\s+(?:default|const|function|class|let|var)\\b',
  '\\bclass\\s+[A-Z][\\w$]*\\s*(?:extends\\b|[({:])',
  '\\bdef\\s+\\w+\\s*\\(',
  '\\bpublic static\\b',
  '\\bSELECT\\s.*\\sFROM\\s',
  '\\bINSERT INTO\\b',
  '\\b(?:npm|pip) install\\b',
  '\\bgit commit\\b',
  '=>\\s*\\{',
  '\\}\\s*;\\s*$',
  '#!\\/',
].join('|'), 'm')
const URL_PATTERN = /https?:\/\/\S+/g

function countMatches(text, pattern) {
  pattern.lastIndex = 0
  return (text.match(pattern) || []).length
}

function journalScore(raw) {
  const text = raw.trim()
  if (!text || CODE_MARKERS.test(text)) return 0
  const words = text.split(/\s+/).filter(Boolean).length
  let score = 0.3

  const firstPerson = countMatches(text, FIRST_PERSON) / Math.max(words, 1)
  if (firstPerson >= 0.08) score += 0.25
  else if (firstPerson >= 0.04) score += 0.15
  else if (firstPerson >= 0.015) score += 0.05
  else score -= 0.25

  if (text.length >= 400) score += 0.2
  else if (text.length >= 180) score += 0.14
  else if (text.length >= 90) score += 0.06
  else if (text.length < 60) score -= 0.3

  const feelings = countMatches(text, FEELING_WORDS)
  if (feelings >= 2) score += 0.18
  else if (feelings === 1) score += 0.12

  if (countMatches(text, TEMPORAL_MARKERS) > 0) score += 0.1
  if (countMatches(text, REFLECTION_MARKERS) > 0) score += 0.15
  if (countMatches(text, RELATIONSHIP_MARKERS) > 0) score += 0.08
  if (REQUEST_OPENERS.test(text)) score -= 0.4
  const requests = countMatches(text, REQUEST_MARKERS)
  if (requests > 0) score -= Math.min(0.5, requests * 0.25)

  const urls = text.match(URL_PATTERN) || []
  if (urls.length >= 2 || urls.join('').length > text.length * 0.2) score -= 0.3
  if (text.endsWith('?') && firstPerson < 0.04) score -= 0.2

  return Math.max(0, Math.min(1, Number(score.toFixed(3))))
}

// ---------------------------------------------------------------------------
// Writing Markdown
// ---------------------------------------------------------------------------

function stampOf(date, timeZone) {
  const parts = {}
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)) {
    parts[part.type] = part.value
  }
  const day = `${parts.year}-${parts.month}-${parts.day}`
  return { day, month: day.slice(0, 7), time: `${parts.hour}:${parts.minute}` }
}

function heading(when, title) {
  return title ? `## ${when} · ${title.replace(/\s+/g, ' ').trim()}` : `## ${when}`
}

function buildFiles(entries, undated, split, timeZone) {
  const intro = `Only my own messages from a ChatGPT data export; ChatGPT's replies are left out. Times are in ${timeZone}.`
  const files = new Map()
  const add = (name, title, block) => {
    if (!files.has(name)) files.set(name, [`# ${title}`, '', intro, ''])
    files.get(name).push(block, '')
  }

  for (const entry of entries) {
    const { day, month, time } = stampOf(entry.date, timeZone)
    if (split === 'day') add(`${day}.md`, day, `${heading(time, entry.title)}\n\n${entry.text}`)
    else if (split === 'month') add(`${month}.md`, month, `${heading(`${day} ${time}`, entry.title)}\n\n${entry.text}`)
    else add('chatgpt-journal.md', 'My writing from ChatGPT', `${heading(`${day} ${time}`, entry.title)}\n\n${entry.text}`)
  }
  for (const entry of undated) {
    const name = split === 'none' ? 'chatgpt-journal.md' : 'undated.md'
    const title = split === 'none' ? 'My writing from ChatGPT' : 'Undated'
    add(name, title, `${heading('Undated', entry.title)}\n\n${entry.text}`)
  }
  return files
}

// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2))
  let raw
  try {
    raw = readExport(opts.input)
  } catch (err) {
    if (err instanceof ExportError) fail(err.message)
    throw err
  }

  let chats
  try {
    chats = conversationsOf(raw)
  } catch (err) {
    fail(err.message)
  }

  const now = Date.now()
  const seenIds = new Set()
  const entries = []
  const undated = []
  let ownMessages = 0
  let filteredOut = 0

  for (const chat of chats) {
    const title = typeof chat?.title === 'string' ? chat.title : ''
    for (const node of nodesOf(chat)) {
      const message = node?.message
      if (!isOwnMessage(message)) continue
      const text = textOf(message)
      if (!text) continue
      if (typeof message.id === 'string') {
        if (seenIds.has(message.id)) continue
        seenIds.add(message.id)
      }
      ownMessages++
      if (opts.journalLike && journalScore(text) < opts.minScore) {
        filteredOut++
        continue
      }
      const date = dateOf(message, chat, now)
      if (date) entries.push({ date, title, text })
      else undated.push({ title, text })
    }
  }
  entries.sort((a, b) => a.date - b.date)

  const files = buildFiles(entries, undated, opts.split, opts.tz)
  const outDir = path.resolve(opts.out)
  const names = [...files.keys()].sort()

  const lines = [
    `Read ${chats.length} chat${chats.length === 1 ? '' : 's'} holding ${ownMessages} message${ownMessages === 1 ? '' : 's'} you wrote. ChatGPT's replies were left out.`,
  ]
  if (opts.journalLike) {
    lines.push(`Left out ${filteredOut} that did not read like journaling (min score ${opts.minScore}).`)
  }
  lines.push(`Kept ${entries.length} dated and ${undated.length} undated.`)
  if (entries.length) {
    const first = stampOf(entries[0].date, opts.tz).day
    const last = stampOf(entries[entries.length - 1].date, opts.tz).day
    lines.push(`Dates run from ${first} to ${last} (${opts.tz}).`)
  }

  if (names.length === 0) {
    lines.push('Nothing to write.')
    process.stdout.write(`${lines.join('\n')}\n`)
    return
  }

  const shown = names.length > 8 ? [...names.slice(0, 3), `... ${names.length - 6} more ...`, ...names.slice(-3)] : names
  const fileWord = `${names.length} file${names.length === 1 ? '' : 's'}`

  if (opts.dryRun) {
    lines.push(`Dry run: nothing written. Would write ${fileWord} to ${outDir}:`, ...shown.map((n) => `  ${n}`))
    process.stdout.write(`${lines.join('\n')}\n`)
    return
  }

  const existing = names.filter((name) => fs.existsSync(path.join(outDir, name)))
  if (existing.length && !opts.force) {
    fail(`${existing.length} of these files already exist in ${outDir}. Choose another --out, or pass --force to overwrite them.`)
  }

  // Private by default: a folder and files only this user can read.
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
  for (const name of names) {
    const target = path.join(outDir, name)
    fs.writeFileSync(target, files.get(name).join('\n').replace(/\n+$/, '\n'), { mode: 0o600 })
    fs.chmodSync(target, 0o600)
  }

  lines.push(`Wrote ${fileWord} to ${outDir}:`, ...shown.map((n) => `  ${n}`))
  process.stdout.write(`${lines.join('\n')}\n`)
}

main()
