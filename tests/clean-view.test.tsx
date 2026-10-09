import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cleanName } from '../hooks/clean-view'

const PLUGIN = 'clean-view'
const SURFACES = ['terminal', 'desktop'] as const
const PLAN = 'mcp__clean-view__plan_steps'
const REPORT = 'mcp__clean-view__report_progress'

const hint = {
  component: 'PromptHint' as const,
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
}

const band = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

// The engine's own parts, beneath the mod: drawing, storage, the clock, a
// Haiku that names every job, and tools that simply succeed.
const engine = (on: On) => {
  mock.store(on)
  mock.clock(on)
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Build my landing page', usage: {} } }) as never)
  on('tool.call', () => ({ result: {} }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({}))
}

const startJob = ($: Parameters<Parameters<typeof test>[1]>[0], text = 'Build my landing page with a pricing section') =>
  $.turn.start({ text, turnId: 'turn-1' })

describe('plain names', () => {
  test('code, paths and long names are cleaned up', async () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
    expect(cleanName('Update src/app/page.tsx so the header fits')).toBe('Update so the header fits')
    const long = cleanName('Rewrite every paragraph of the about page so it sounds warmer and more personal today')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long.endsWith('…')).toBe(true)
    expect(cleanName('`npm test`')).toBe('Trabalhando nisso')
  })
})

describe('checklist', () => {
  test('a to-do list and a 60% report draw done, current, next and later rows', async ($, on) => {
    engine(on)
    await startJob($)
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading your brand notes' },
        { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building the pricing section' },
        { content: 'Add the contact form', status: 'pending', activeForm: 'Adding the contact form' },
        { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing the footer' },
      ],
    } as never)
    await $.tool.call({ tool: REPORT, task: 'Build the pricing section', percent: 60 } as never)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band })
      expect(await ui.find({ text: /✓/ })).toBeDefined()
      expect(await ui.find({ text: /▶/ })).toBeDefined()
      expect(await ui.find({ text: /60%/ })).toBeDefined()
      expect(await ui.find({ text: /^Próximo$/ })).toBeDefined()
      expect(await ui.find({ text: /^Depois$/ })).toBeDefined()
      await ui.unmount()
      const corner = await $.ui.mount({ plugin: PLUGIN, surface, ...hint })
      expect((await corner.find({ key: 'clean-view-toggle' }))?.text).toMatch(/● clean view/)
      expect(await corner.find({ text: /\? for shortcuts/ })).toBeDefined()
      await corner.unmount()
    }
  })

  test('another mod\'s button on the hint row stays, with the switch after it', async ($, on) => {
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Box, Text, Button } = $.ui.resolve(e)
      return Box({ children: [Text({ children: '? for shortcuts' }), Button({ key: 'zen-toggle', label: '○ zen', onPress: () => {} })] })
    })
    engine(on)
    const corner = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint })
    expect(await corner.find({ key: 'zen-toggle' })).toBeDefined()
    expect(await corner.find({ key: 'clean-view-toggle' })).toBeDefined()
    expect(await corner.find({ text: /\? for shortcuts/ })).toBeDefined()
  })

  test('a permission prompt shows Precisa de você', async ($, on) => {
    engine(on)
    await startJob($)
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band })
    expect(await ui.find({ text: /Precisa de você/ })).toBeDefined()
    expect(await ui.find({ text: /precisa do seu OK para continuar/ })).toBeDefined()
  })

  test('/simple off hides the band, and the button turns it back on', async ($, on) => {
    engine(on)
    await startJob($)
    await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Build the page'] } as never)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band })
    const corner = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint })
    expect(await ui.find({ text: /Build the page/ })).toBeDefined()
    expect((await $.command.run({ command: 'simple', args: 'off' } as never)).text).toMatch(/desligado/)
    expect(await ui.find({ text: /Build the page/ })).toBeUndefined()
    expect((await corner.find({ key: 'clean-view-toggle' }))?.text).toMatch(/○ clean view/)
    await corner.press({ key: 'clean-view-toggle' })
    expect(await ui.find({ text: /Build the page/ })).toBeDefined()
  })

  test('plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
    engine(on)
    await startJob($)
    const planned = await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] } as never)
    expect(planned.result).toBe('Planned 3 steps. The first one has started.')
    const noted = await $.tool.call({ tool: REPORT, task: 'Read your brand notes', percent: 140 } as never)
    expect(noted.result).toBe('Progress noted: 100%.')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band })
    expect(await ui.find({ text: /^Feito$/ })).toBeDefined()
    expect(await ui.find({ text: /^Fazendo$/ })).toBeDefined()
    expect(await ui.find({ text: /^Próximo$/ })).toBeDefined()
  })

  test('any tool is refused before a plan and allowed after it', async ($, on) => {
    engine(on)
    await startJob($)
    const before = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(before.deny).toMatch(/plan_steps/)
    await $.tool.call({ tool: PLAN, steps: ['Look around the project'] } as never)
    const after = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(after.deny).toBeUndefined()
  })
  test('a finished job shows Tudo pronto with the time it took', async ($, on) => {
    engine(on)
    await startJob($)
    await $.tool.call({ tool: PLAN, steps: ['Answer your question'] } as never)
    await $.tool.call({ tool: REPORT, task: 'Answer your question', percent: 100 } as never)
    await $.turn.complete({ reason: 'answer', answer: 'Here it is.', durationMs: 1000, isAborted: false, turnId: 'turn-1' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band })
    expect(await ui.find({ text: /Tudo pronto/ })).toBeDefined()
    expect(await ui.find({ text: /levou/ })).toBeDefined()
  })
})
