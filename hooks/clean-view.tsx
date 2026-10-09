import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { Checklist, ChecklistTask, TaskStatus } from '../types'

const PLUGIN = 'clean-view'
const PLAN_TOOL = `mcp__${PLUGIN}__plan_steps`
const REPORT_TOOL = `mcp__${PLUGIN}__report_progress`

// Tools that run before a plan exists: planning, to-do lists and questions.
const ALWAYS_ALLOWED = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', PLAN_TOOL, REPORT_TOOL])

const PLACEHOLDER = 'placeholder-'
const METER = 10
// The widest row label: Próximo. Every label gets this width so the meters line up.
const LABEL = 7
// Right margin of the checklist rows, in cells.
const MARGIN = 4
const MAX_NAME = 40
const COLLAPSE_MS = 5000

const IDLE: Checklist = {
  title: '',
  phase: 'idle',
  tasks: [],
  needsYouReason: null,
  stuckReason: null,
  startedAt: null,
  finishedAt: null,
  isCollapsed: false,
}

const enabled = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklist = atom({ plugin: 'clean-view', key: 'checklist' } as const, IDLE)
const tick = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

const SYSTEM_SECTION = {
  id: `${PLUGIN}:plan`,
  scope: 'session' as const,
  text: [
    'Clean View is on: the person sees only your written replies and a checklist of steps above the prompt. Tool calls, diffs and command output are hidden from them. The person reads Brazilian Portuguese.',
    `- For every request, even a quick question, first call ${PLAN_TOOL} with every step of the job: 2 to 8 short names, in order. If it is deferred, load it with ToolSearch first. Other tools are refused until a plan exists.`,
    `- Call ${REPORT_TOOL} as real progress happens on the current step, and with percent 100 the moment a step finishes.`,
    '- Write every step name in plain Brazilian Portuguese a non-technical person understands, under 40 characters, starting with a verb in the infinitive, like "Criar a seção de preços".',
    '- Never put file paths, file names, commands, code or tool names in a step name.',
    '- If the session has TodoWrite or TaskCreate, you may use your to-do list as the plan instead.',
  ].join('\n'),
}

const NAME_PROMPT =
  'Dê um nome a este pedido em 2 a 6 palavras simples, em português do Brasil, que uma pessoa leiga entenda, começando com um verbo no infinitivo. ' +
  'Sem nomes de arquivo, código, aspas ou ponto final. Responda só com o nome.\n\nPedido:\n'

// Plain names ------------------------------------------------------------------

const CODE_FILE =
  /\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|json|ya?ml|toml|md|mdx|html?|css|scss|sql|lock|env|xml|vue|svelte|ipynb)\b/gi

// Every name on the checklist passes through here.
export function cleanName(raw: string): string {
  let name = raw.replace(/`[^`]*`/g, ' ').replace(/`/g, ' ')
  name = name
    .split(/\s+/)
    .filter(word => !word.includes('/') && !word.includes('\\'))
    .join(' ')
  name = name.replace(CODE_FILE, ' ').replace(/\s+/g, ' ').trim()
  if (name === '') return 'Trabalhando nisso'
  name = name.charAt(0).toUpperCase() + name.slice(1)
  if (name.length <= MAX_NAME) return name
  const cut = name.slice(0, MAX_NAME - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`
}

// The checklist's arithmetic ---------------------------------------------------

const isPlaceholder = (t: ChecklistTask) => t.id.startsWith(PLACEHOLDER)

export const hasPlan = (c: Checklist) => c.tasks.some(t => !isPlaceholder(t))

const isOpen = (c: Checklist) => c.phase !== 'idle' && c.finishedAt === null

const newTask = (id: string, name: string, status: TaskStatus): ChecklistTask => ({
  id,
  name: cleanName(name),
  status,
  percent: status === 'done' ? 100 : 0,
  hasReported: false,
})

export function placeholders(): ChecklistTask[] {
  return [newTask(`${PLACEHOLDER}0`, 'Entender seu pedido', 'active'), newTask(`${PLACEHOLDER}1`, 'Planejar as etapas', 'upcoming')]
}

export function planSteps(c: Checklist, steps: readonly string[]): Checklist {
  const tasks = steps
    .slice(0, 8)
    .map((step, i) => newTask(`plan-${i}`, step, i === 0 ? 'active' : 'upcoming'))
  return { ...c, tasks }
}

// Progress on one step: the steps before it are checked off, and at 100 the
// next one starts. A name the plan lacks becomes a new step before the upcoming ones.
export function reportProgress(c: Checklist, rawName: string, rawPercent: number): Checklist {
  const percent = Math.max(0, Math.min(100, Math.round(Number.isFinite(rawPercent) ? rawPercent : 0)))
  const name = cleanName(rawName)
  let tasks = c.tasks.filter(t => !isPlaceholder(t))
  let at = tasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase())
  if (at < 0) {
    const firstUpcoming = tasks.findIndex(t => t.status === 'upcoming')
    at = firstUpcoming < 0 ? tasks.length : firstUpcoming
    tasks = [...tasks.slice(0, at), newTask(`step-${tasks.length}`, name, 'upcoming'), ...tasks.slice(at)]
  }
  const isFinished = percent >= 100
  let startsNext = isFinished
  tasks = tasks.map((t, i): ChecklistTask => {
    if (i < at) return { ...t, status: 'done', percent: 100 }
    if (i === at) return isFinished ? { ...t, status: 'done', percent: 100, hasReported: true } : { ...t, status: 'active', percent, hasReported: true }
    if (t.status === 'done') return t
    if (startsNext) {
      startsNext = false
      return { ...t, status: 'active', percent: 0, hasReported: false }
    }
    return { ...t, status: 'upcoming', percent: 0, hasReported: false }
  })
  return { ...c, tasks }
}

type Todo = { content?: unknown; status?: unknown }

export function fromTodos(c: Checklist, todos: readonly Todo[]): Checklist {
  const tasks = todos.map((todo, i) => {
    const status: TaskStatus = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'
    return newTask(`todo-${i}`, typeof todo.content === 'string' ? todo.content : '', status)
  })
  return { ...c, tasks }
}

// One calm sentence for an API error.
export function apiErrorSentence(kind: string, details: string): string {
  const s = `${kind} ${details}`.toLowerCase()
  if (/rate_limit|rate limit|usage limit|\b429\b/.test(s)) return 'você atingiu seu limite de uso, tente de novo daqui a pouco'
  if (/overloaded|\b529\b/.test(s)) return 'os servidores do Claude estão ocupados, tente de novo em um minuto'
  if (/too long|context|prompt_too_long/.test(s)) return 'digite /compact e tente de novo'
  if (/auth|oauth|login|credential|\b401\b|\b403\b/.test(s)) return 'digite /login'
  if (/network|connection|econn|enotfound|etimedout|socket|fetch failed|offline/.test(s)) return 'a conexão com a internet caiu'
  return 'algo deu errado no caminho, tente de novo'
}

const REJECTED = /doesn.t want to proceed|does not want to proceed|user (rejected|denied|declined)|rejected by the user/i

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// The engine's hint can come in more than one line; here it is one.
function oneLine(hint: string) {
  return hint
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .join(' · ')
}

// Moving parts -----------------------------------------------------------------

// The animation clock runs only while a job works or waits on the person.
let ticker: Timer | undefined
// Which job a background name belongs to.
let jobSeq = 0
// Failed tool calls in a row, and whether the person refused a step.
let failures = 0
let saidNo = false
let apiError: string | null = null

async function syncTicker($: EngineInterface) {
  const { phase } = await read($, checklist)
  const animate = phase === 'working' || phase === 'needs-you'
  if (animate && ticker === undefined) {
    ticker = $.clock.every(250, () => {
      void update($, tick, n => n + 1)
    })
  } else if (!animate && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
}

async function change($: EngineInterface, fn: (c: Checklist) => Checklist) {
  const updated = await update($, checklist, fn)
  await syncTicker($)
  return updated
}

const running = (c: Checklist): Checklist => ({
  ...c,
  phase: c.stuckReason !== null ? 'stuck' : 'working',
  needsYouReason: null,
})

async function needsYou($: EngineInterface, reason: string) {
  await change($, c => (isOpen(c) ? { ...c, phase: 'needs-you', needsYouReason: reason } : c))
}

async function clearNeedsYou($: EngineInterface) {
  if ((await read($, checklist)).phase === 'needs-you') await change($, running)
}

async function stuck($: EngineInterface, reason: string) {
  await change($, c => (isOpen(c) ? { ...c, phase: 'stuck', stuckReason: reason, needsYouReason: null } : c))
}

async function unstick($: EngineInterface) {
  await change($, c => (c.stuckReason === null ? c : { ...c, stuckReason: null, phase: c.phase === 'stuck' ? 'working' : c.phase }))
}

async function startJob($: EngineInterface, text: string) {
  jobSeq += 1
  failures = 0
  saidNo = false
  apiError = null
  const seq = jobSeq
  await change($, () => ({
    ...IDLE,
    title: cleanName(text.split('\n')[0] ?? ''),
    phase: 'working',
    tasks: placeholders(),
    startedAt: Date.now(),
  }))
  if (await read($, enabled)) void nameJob($, seq, text)
}

// Asks Haiku for a short name; an answer for an older job is dropped.
async function nameJob($: EngineInterface, seq: number, text: string) {
  try {
    const reply = await $.model.complete({ model: 'haiku', effort: 'low', maxTokens: 40, prompt: NAME_PROMPT + text.slice(0, 1000) })
    if (!reply.isAnswered || seq !== jobSeq) return
    const name = cleanName((reply.text.split('\n')[0] ?? '').replace(/["“”.]/g, ''))
    await update($, checklist, c => (isOpen(c) ? { ...c, title: name } : c))
  } catch {}
}

async function finishTurn($: EngineInterface, reason: string, answer: string) {
  const c = await read($, checklist)
  if (!isOpen(c)) return
  const now = Date.now()
  if (reason === 'error') {
    await change($, x => ({ ...x, phase: 'stuck', stuckReason: apiError ?? apiErrorSentence('', answer), needsYouReason: null, finishedAt: now }))
  } else if (reason === 'refusal') {
    await change($, x => ({ ...x, phase: 'stuck', stuckReason: 'o Claude não conseguiu ajudar com esse pedido', needsYouReason: null, finishedAt: now }))
  } else if (saidNo) {
    // The refusal keeps its Stuck header; the person's reply resumes the job.
  } else if (reason === 'aborted') {
    await change($, x => ({ ...x, phase: 'stopped', needsYouReason: null, finishedAt: now }))
  } else if (c.tasks.some(t => !isPlaceholder(t) && t.status !== 'done')) {
    await change($, x => ({ ...x, phase: 'needs-you', needsYouReason: 'o Claude está esperando sua resposta', stuckReason: null }))
  } else {
    const tasks = c.tasks.map(t => ({ ...t, status: 'done' as const, percent: 100 }))
    await change($, x => ({ ...x, tasks, phase: 'done', needsYouReason: null, stuckReason: null, finishedAt: now }))
    $.clock.after(COLLAPSE_MS, () => {
      void update($, checklist, x => (x.phase === 'done' && x.finishedAt === now ? { ...x, isCollapsed: true } : x))
    })
  }
}

async function setEnabled($: EngineInterface, isOn: boolean) {
  await update($, enabled, () => isOn)
  await $.store.set('cleanViewEnabled', isOn)
}

// Drawing ------------------------------------------------------------------------

function meter(t: ChecklistTask, frame: number) {
  if (t.status === 'done') return { filled: METER, sweep: null }
  if (t.status === 'upcoming') return { filled: 0, sweep: null }
  if (t.hasReported) return { filled: Math.round(t.percent / 10), sweep: null }
  return { filled: 0, sweep: frame % METER }
}

// Hooks --------------------------------------------------------------------------

export function registerCleanView(on: On) {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const saved = await $.store.get('cleanViewEnabled')
    await update($, enabled, () => saved !== false)
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lays out every step of the job before you start: 2 to 8 short names in plain Brazilian Portuguese, in order, each starting with a verb. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Reports progress on the current step of the plan, by its name, from 0 to 100. Send 100 the moment a step finishes; the next step then starts.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' }, percent: { type: 'number', minimum: 0, maximum: 100 } },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'simple', description: 'Liga ou desliga o Clean View', argumentHint: 'on|off' })
    await syncTicker($)
    return started
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') return { text: 'Use /simple on, /simple off ou só /simple para alternar.' }
    const isOn = arg === '' ? !(await read($, enabled)) : arg === 'on'
    await setEnabled($, isOn)
    return { text: isOn ? 'Clean View ligado.' : 'Clean View desligado. As linhas técnicas voltaram.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, enabled))) return composed
    return { sections: [...composed.sections, SYSTEM_SECTION] }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    const c = await read($, checklist)
    if (isOpen(c)) {
      saidNo = false
      await change($, x => ({ ...running(x), stuckReason: null, phase: 'working' }))
    } else if (text !== '' && !text.startsWith('/')) {
      await startJob($, text)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const input = e as unknown as Record<string, unknown>

    if (e.tool === PLAN_TOOL) {
      const steps = (Array.isArray(input.steps) ? input.steps : []).filter((s): s is string => typeof s === 'string')
      if (steps.length === 0) return { deny: 'plan_steps needs 2 to 8 step names.' }
      const c = await read($, checklist)
      if (!isOpen(c)) {
        jobSeq += 1
        await change($, () => ({ ...IDLE, title: cleanName(steps[0] ?? ''), phase: 'working', startedAt: Date.now() }))
      }
      const planned = await change($, x => planSteps(x, steps))
      return { result: `Planned ${planned.tasks.length} steps. The first one has started.` }
    }

    if (e.tool === REPORT_TOOL) {
      const percent = Math.max(0, Math.min(100, Math.round(Number(input.percent) || 0)))
      await change($, x => reportProgress(x, typeof input.task === 'string' ? input.task : '', percent))
      return { result: `Progress noted: ${percent}%.` }
    }

    if (isMain && !ALWAYS_ALLOWED.has(e.tool) && (await read($, enabled)) && !hasPlan(await read($, checklist))) {
      return { deny: `Clean View: call ${PLAN_TOOL} first with the steps of this job, then try again.` }
    }

    if (isMain) await clearNeedsYou($)
    const asks = e.tool === 'AskUserQuestion'
    if (asks) await needsYou($, 'o Claude tem uma pergunta para você')
    const ran = await next(e)
    if (asks) await clearNeedsYou($)
    if (!isMain) return ran

    if (ran.deny === undefined && ran.isError !== true) {
      if (e.tool === 'TodoWrite' && Array.isArray(input.todos)) {
        await change($, x => fromTodos(x, input.todos as Todo[]))
      } else if (e.tool === 'TaskCreate') {
        const id = (ran.result as { task?: { id?: unknown } } | undefined)?.task?.id
        if (typeof id === 'string') {
          const task = newTask(id, typeof input.subject === 'string' ? input.subject : '', 'upcoming')
          await change($, x => ({ ...x, tasks: [...x.tasks.filter(t => !isPlaceholder(t) && t.id !== id), task] }))
        }
      } else if (e.tool === 'TaskUpdate') {
        await change($, x => {
          if (input.status === 'deleted') return { ...x, tasks: x.tasks.filter(t => t.id !== input.taskId) }
          const tasks = x.tasks.map((t): ChecklistTask => {
            if (t.id !== input.taskId) return t
            const name = typeof input.subject === 'string' ? cleanName(input.subject) : t.name
            if (input.status === 'completed') return { ...t, name, status: 'done', percent: 100 }
            if (input.status === 'in_progress') return { ...t, name, status: 'active' }
            if (input.status === 'pending') return { ...t, name, status: 'upcoming', percent: 0 }
            return { ...t, name }
          })
          return { ...x, tasks }
        })
      }
    }

    // Failures and refusals feed the Stuck header; a success clears it.
    const said = `${ran.deny ?? ''} ${ran.isError === true ? (ran.text ?? '') : ''}`
    if (REJECTED.test(said)) {
      saidNo = true
      await stuck($, 'você recusou uma etapa, então o Claude parou')
    } else if (ran.isError === true) {
      failures += 1
      if (failures >= 3) await stuck($, 'uma etapa continua falhando, o Claude está tentando outro caminho')
    } else if (ran.deny === undefined) {
      failures = 0
      saidNo = false
      await unstick($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    if (/permission/i.test(`${e.notification_type} ${e.message}`)) await needsYou($, 'o Claude precisa do seu OK para continuar')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id === undefined) {
      apiError = apiErrorSentence(e.error, e.error_details ?? '')
      await change($, c => (c.phase === 'stuck' && c.finishedAt !== null ? { ...c, stuckReason: apiError } : c))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await finishTurn($, e.reason, e.answer)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The technical rows, hidden while Clean View is on.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) =>
    (await read($, enabled)) ? $.ui.resolve(e).Box({ display: 'none' }) : next(e),
  )
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) =>
    (await read($, enabled)) ? $.ui.resolve(e).Box({ display: 'none' }) : next(e),
  )
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) =>
    (await read($, enabled)) ? $.ui.resolve(e).Box({ display: 'none' }) : next(e),
  )
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await read($, enabled)) ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e),
  )

  // The switch, at the right of the hint row under the prompt. Another mod's row
  // (the Zen button) stays, with this switch after it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const isOn = await read($, enabled)
    const below = await next(e)
    const row =
      below.type === 'engine' ? (
        <Text dimColor wrap="truncate">
          {oneLine(e.props.hint)}
        </Text>
      ) : (
        <Box flexGrow={1} flexShrink={1}>
          {below}
        </Box>
      )
    return (
      <Box justifyContent="space-between" flexGrow={1} gap={1}>
        {row}
        <Button
          key="clean-view-toggle"
          plain
          dimColor={!isOn}
          label={isOn ? '● clean view' : '○ clean view'}
          onPress={async () => {
            const isNowOn = !(await read($, enabled))
            await setEnabled($, isNowOn)
            $.ui.toast(isNowOn ? 'Clean View ligado' : 'Clean View desligado: as linhas técnicas voltaram')
          }}
        />
      </Box>
    )
  })

  // The checklist above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const isOn = await read($, enabled)
    const c = await read($, checklist)
    if (!isOn || c.phase === 'idle') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const frame = await read($, tick)

    const now = Date.now()
    const took = duration((c.finishedAt ?? now) - (c.startedAt ?? now))
    const title = c.title || 'Trabalhando nisso'

    if (c.phase === 'done' && c.isCollapsed) {
      return (
        <Text wrap="wrap">
          <Text color="success">✓ Tudo pronto</Text>
          <Text dimColor>{` · ${title} · levou ${took}`}</Text>
        </Text>
      )
    }

    const header =
      c.phase === 'needs-you' ? (
        <Text wrap="wrap">
          <Text inverse bold color="warning">
            {' Precisa de você '}
          </Text>
          <Text>{` ${c.needsYouReason ?? ''}`}</Text>
        </Text>
      ) : c.phase === 'stuck' ? (
        <Text wrap="wrap" color="warning">{`⚠ Travado: ${c.stuckReason ?? ''}`}</Text>
      ) : c.phase === 'stopped' ? (
        <Text wrap="wrap">{`■ Parado · ${title} · você apertou Esc`}</Text>
      ) : c.phase === 'done' ? (
        <Text wrap="wrap">
          <Text color="success" bold>
            ✓ Tudo pronto
          </Text>
          <Text>{` · ${title} · levou ${took}`}</Text>
        </Text>
      ) : (
        <Text wrap="wrap">
          <Text bold>{title}</Text>
          <Text dimColor>{` · ${took}`}</Text>
        </Text>
      )

    // The name takes what is left of the row and wraps instead of being cut. The row
    // keeps a right margin: the desktop app draws its padding inside the width the
    // engine reports, and without it the label runs off the edge.
    let upcomingSeen = 0
    const rows = c.tasks.map(t => {
      const { filled, sweep } = meter(t, frame)
      const cells = Array.from({ length: METER }, (_, i) => (sweep === null ? i < filled : i >= sweep && i < sweep + 3))
      const isActive = t.status === 'active'
      const icon = t.status === 'done' ? '✓' : isActive ? (c.phase === 'needs-you' ? '‖' : '▶') : '○'
      const label =
        t.status === 'done' ? 'Feito' : isActive ? (t.hasReported ? `${t.percent}%` : 'Fazendo') : upcomingSeen++ === 0 ? 'Próximo' : 'Depois'
      return (
        <Box key={`task-${t.id}`} gap={1} paddingRight={MARGIN}>
          <Text color={t.status === 'done' ? 'success' : isActive ? 'claude' : undefined} dimColor={t.status === 'upcoming'}>
            {icon}
          </Text>
          <Box flexGrow={1} flexShrink={1} minWidth={8}>
            <Text wrap="wrap" bold={isActive} dimColor={!isActive}>
              {t.name}
            </Text>
          </Box>
          <Box flexShrink={0}>
          <Text>
            {cells.map((isFilled, i) =>
              isFilled ? (
                <Text key={`cell-${i}`} color={t.status === 'done' ? 'success' : 'claude'}>
                  █
                </Text>
              ) : (
                <Text key={`cell-${i}`} dimColor>
                  █
                </Text>
              ),
            )}
          </Text>
          </Box>
          <Box width={LABEL} flexShrink={0}>
            <Text dimColor={!isActive}>{label}</Text>
          </Box>
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        <Box key="header">{header}</Box>
        {rows}
      </Box>
    )
  })
}
