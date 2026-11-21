import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, AnsiDoc, Meter } from '../types'

const activity = atom(
  { plugin: 'skynet-panel', key: 'activity' } as const,
  { agents: 0, frame: 0 } as Activity,
  { shape: 'activity-1' },
)

// The one animation/poll interval; replaced on every session.start.
let ticker: { cancel: () => void } | null = null

const SCAN_WIDTH = 5
// Dot position bounces 0..4..0 (period 8).
function dotPos(frame: number): number {
  const p = ((frame % (2 * (SCAN_WIDTH - 1))) + 2 * (SCAN_WIDTH - 1)) % (2 * (SCAN_WIDTH - 1))
  return p < SCAN_WIDTH ? p : 2 * (SCAN_WIDTH - 1) - p
}

const meter = atom(
  { plugin: 'skynet-panel', key: 'meter' } as const,
  { limits: [], contextPercent: null } as Meter,
  { shape: 'meter-1' },
)

const LABELS: Record<string, string> = {
  five_hour: '5h limit',
  seven_day: '7d limit',
  spend_limit: 'Spend',
}

const GREY = 'rgb(135,135,140)'
const RED_EMPTY = 'rgb(62,26,32)'

// Thin line: a filled stretch and an empty stretch, drawn in two colors.
function bar(percent: number, width: number): { full: string; rest: string } {
  const n = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return { full: '━'.repeat(n), rest: '─'.repeat(width - n) }
}

// Only dim shades of red; the fill deepens a little as usage grows.
function redShade(percent: number): string {
  const t = Math.max(0, Math.min(1, percent / 100))
  return rgb(Math.round(125 + 70 * t), Math.round(34 + 8 * t), Math.round(44 + 6 * t))
}

// Bar colors by usage: < 70 green, < 90 yellow, otherwise red (unchanged).
function barColors(percent: number): { fill: string; empty: string } {
  if (percent < 70) return { fill: rgb(60, 140, 80), empty: rgb(24, 50, 32) }
  if (percent < 90) return { fill: rgb(190, 160, 50), empty: rgb(58, 50, 22) }
  return { fill: redShade(percent), empty: RED_EMPTY }
}

function until(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h`
  if (mins >= 60) return `${Math.floor(mins / 60)}h${mins % 60}m`
  return `${mins}m`
}

const PANE = 'skynet-panel'
const LOGO = 'skynet-logo-2.ansi.txt'
const doc = atom({ plugin: 'skynet-panel', key: 'doc' } as const, null as AnsiDoc | null, {
  shape: 'doc-1',
})

type Style = {
  color?: string
  backgroundColor?: string
  bold?: boolean
  dimColor?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
  strikethrough?: boolean
}
type Span = { text: string; style: Style }

const BASIC = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
  [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
  [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
]

const rgb = (r: number, g: number, b: number) => `rgb(${r},${g},${b})`

function color256(n: number): string {
  if (n < 16) {
    const [r = 0, g = 0, b = 0] = BASIC[n] ?? []
    return rgb(r, g, b)
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return rgb(v, v, v)
  }
  const i = n - 16
  const lv = (x: number) => (x === 0 ? 0 : 55 + x * 40)
  return rgb(lv(Math.floor(i / 36)), lv(Math.floor(i / 6) % 6), lv(i % 6))
}

function applySgr(style: Style, params: number[]): Style {
  let s = { ...style }
  if (params.length === 0) params = [0]
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0
    if (p === 0) s = {}
    else if (p === 1) s.bold = true
    else if (p === 2) s.dimColor = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 7) s.inverse = true
    else if (p === 9) s.strikethrough = true
    else if (p === 22) { s.bold = false; s.dimColor = false }
    else if (p === 23) s.italic = false
    else if (p === 24) s.underline = false
    else if (p === 27) s.inverse = false
    else if (p === 29) s.strikethrough = false
    else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
      s.color = color256(p >= 90 ? p - 90 + 8 : p - 30)
    } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
      s.backgroundColor = color256(p >= 100 ? p - 100 + 8 : p - 40)
    } else if (p === 39) delete s.color
    else if (p === 49) delete s.backgroundColor
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'color' : 'backgroundColor'
      const [, mode, a = 0, b = 0, c = 0] = params.slice(i, i + 5)
      if (mode === 5) {
        s[key] = color256(a)
        i += 2
      } else if (mode === 2) {
        s[key] = rgb(a, b, c)
        i += 4
      }
    }
  }
  return s
}

// Carries the style across lines so a color opened on one line continues.
function parseLines(lines: string[]): Span[][] {
  let style: Style = {}
  const re = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b[^[]|[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g
  return lines.map(line => {
    const spans: Span[] = []
    let last = 0
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(line))) {
      if (m.index > last) spans.push({ text: line.slice(last, m.index), style })
      last = m.index + m[0].length
      if (m[2] === 'm') {
        style = applySgr(style, (m[1] ?? '').split(/[;:]/).filter(x => x !== '').map(Number))
      }
    }
    if (last < line.length) spans.push({ text: line.slice(last), style })
    return spans
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ansi',
      description: 'Skynet panel: /ansi <file> shows an ANSI file, /ansi +N or -N scrolls',
    })
    // Show the bundled logo in the pane at the start of every session.
    try {
      const text = await $.fs.read(`${$.plugin.root}/${LOGO}`)
      const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
      await update($, doc, () => ({ path: LOGO, lines, top: 0 }))
    } catch {
      // No logo: the pane still shows the usage block.
    }
    void $.ui.open({ id: PANE, title: 'Skynet', columns: 30, placement: 'widget' })

    // One interval: counts active agents and animates the idle scanner.
    ticker?.cancel()
    ticker = $.clock.every(350, async () => {
      let n = 0
      try {
        n = (await $.agent.list()).filter(a => a.status === 'running' || a.status === 'pending').length
      } catch {
        n = 0
      }
      try {
        await update($, activity, a => ({ agents: n, frame: (a.frame + 1) % 8 }))
      } catch {
        // Skip this tick; the next one retries.
      }
    })
    return next(e)
  })

  on('session.end', async (_$, e, next) => {
    ticker?.cancel()
    ticker = null
    return next(e)
  })

  on('command.run', { command: 'ansi' }, async ($, e) => {
    const arg = e.args.trim()
    const scroll = /^([+-])(\d+)$/.exec(arg)

    if (scroll) {
      const delta = Number(scroll[2] ?? 0) * (scroll[1] === '-' ? -1 : 1)
      await update($, doc, d =>
        d ? { ...d, top: Math.max(0, Math.min(d.lines.length - 1, d.top + delta)) } : d,
      )
      return { text: `Scrolled ${arg}.` }
    }

    if (arg) {
      const path = arg.replace(/^["']|["']$/g, '')
      let text: string
      try {
        text = await $.fs.read(path)
      } catch (err) {
        return { text: `Cannot read ${path}: ${(err as Error).message}` }
      }
      const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
      await update($, doc, () => ({ path, lines, top: 0 }))
    }

    await $.ui.open({ id: PANE, title: 'Skynet', columns: 30, placement: 'widget' })
    return { text: arg ? `Showing ${arg}.` : 'Skynet pane opened. Use /ansi <file> to load another file.' }
  })

  on('session.measure', async ($, e, next) => {
    await update($, meter, () => ({
      limits: e.rateLimits.map(l => ({
        kind: l.kind,
        percentUsed: l.percentUsed,
        ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}),
      })),
      contextPercent: e.context.percent ?? null,
    }))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = await read($, doc)
    const m = await read($, meter)
    const act = await read($, activity)
    const pos = dotPos(act.frame)
    const scan = ' '.repeat(pos) + '.' + ' '.repeat(SCAN_WIDTH - 1 - pos)
    const now = await $.clock.now()
    let model = ''
    try {
      model = (await $.session.model()) || ''
    } catch {
      // No model line if it cannot be resolved.
    }

    const usage = (
      <Box flexDirection="column" marginTop={1}>
        {model !== '' && (
          <Box marginBottom={1}>
            <Text color={GREY} wrap="truncate-end">
              {model} <Text color={redShade(100)}>armed</Text>
            </Text>
          </Box>
        )}
        <Text color={GREY}>Usage limits</Text>
        {m.limits.length === 0 && <Text color={GREY}>No limit data yet</Text>}
        {m.limits.map(l => {
          const b = bar(l.percentUsed, 28)
          const c = barColors(l.percentUsed)
          return (
            <Box flexDirection="column">
              <Text color={GREY} wrap="truncate-end">
                {LABELS[l.kind] ?? l.kind} {l.percentUsed}% {until(l.resetsAt, now) && `· ${until(l.resetsAt, now)}`}
              </Text>
              <Text>
                <Text color={c.fill}>{b.full}</Text>
                <Text color={c.empty}>{b.rest}</Text>
              </Text>
            </Box>
          )
        })}
        {m.contextPercent !== null && (
          <Box flexDirection="column">
            <Text color={GREY}>Context {m.contextPercent}%</Text>
            <Text>
              <Text color={barColors(m.contextPercent).fill}>{bar(m.contextPercent, 28).full}</Text>
              <Text color={barColors(m.contextPercent).empty}>{bar(m.contextPercent, 28).rest}</Text>
            </Text>
          </Box>
        )}
        <Box marginTop={1}>
          {act.agents > 0 ? (
            <Text color={GREY} wrap="truncate-end">{`${act.agents} terminators active ${' '.repeat(pos)}`}<Text color={redShade(100)}>⌖</Text>{' '.repeat(SCAN_WIDTH - 1 - pos)}</Text>
          ) : (
            <Text color={GREY} wrap="truncate-end">{`searching for targets ${scan}`}</Text>
          )}
        </Box>
      </Box>
    )

    if (!d) {
      return (
        <Box flexDirection="column">
          <Text color={GREY}>No file loaded. Use /ansi {'<file>'}.</Text>
          {usage}
        </Box>
      )
    }

    // Rows left for the graphic after the usage block.
    const usageRows = 1 + 1 + Math.max(1, m.limits.length) * 2 + (m.contextPercent !== null ? 2 : 0) + (model !== '' ? 2 : 0) + 2
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 5 - usageRows)
    const shown = parseLines(d.lines.slice(0, d.top + room)).slice(d.top)

    return (
      <Box flexDirection="column">
        {shown.map(spans => (
          <Text wrap="truncate-end">
            {spans.length === 0
              ? ' '
              : spans.map(s => <Text {...s.style}>{s.text}</Text>)}
          </Text>
        ))}
        {usage}
      </Box>
    )
  })
}
