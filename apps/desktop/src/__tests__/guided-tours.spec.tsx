// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Config } from 'driver.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const driven: Config[] = []

vi.mock('driver.js', () => ({
  driver: (config: Config) => {
    driven.push(config)
    return {
      drive: () => undefined,
      destroy: () => {
        config.onDestroyed?.(undefined, {}, { config, state: {}, driver: undefined } as never)
      },
    }
  },
}))

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`) }),
}))

import { HelpSection, type HelpTourGroup } from '@bitsentry-ce/components/tutorial/HelpSection'
import { isTourCompleted, resetTourProgress, startTourDefinition } from '@bitsentry-ce/components/tutorial/useTour'
import type { TourDefinition } from '@bitsentry-ce/components/tutorial/tour-definitions'

function anchor(name: string): HTMLElement {
  const element = document.createElement('div')
  element.dataset.tour = name
  document.body.append(element)
  return element
}

const realPageTour: TourDefinition = {
  id: 'diagnosis',
  label: 'Diagnosis tour',
  description: 'Find problems',
  skipMissingTargets: true,
  steps: [
    { popover: { title: 'Intro' } },
    { element: '[data-tour="present"]', popover: { title: 'Present' } },
    { element: () => document.querySelector('[data-tour="missing"]') ?? document.body, popover: { title: 'Missing' } },
  ],
}

beforeEach(() => {
  vi.useFakeTimers()
  driven.length = 0
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  // End any tour a test left running so the next one starts clean.
  for (const config of driven) config.onDestroyed?.(undefined, {}, { config, state: {}, driver: undefined } as never)
  document.body.innerHTML = ''
  vi.useRealTimers()
})

/** Closes the tour without finishing it, as the close button or Escape does. */
function dismiss(config: Config) {
  config.onDestroyed?.(undefined, {}, { config, state: {}, driver: undefined } as never)
}

/** Clicks the popover's next button: Done on the last step, which ends the tour. */
function clickNext(config: Config, hasNextStep: boolean) {
  const instance = {
    hasNextStep: () => hasNextStep,
    moveNext: () => {
      if (!hasNextStep) dismiss(config)
    },
  }
  config.onNextClick?.(undefined, {}, { config, state: {}, driver: instance } as never)
}

async function run(tour: TourDefinition, opts?: Parameters<typeof startTourDefinition>[1]) {
  const started = startTourDefinition(tour, opts)
  await vi.advanceTimersByTimeAsync(4000)
  await started
}

describe('guided tour runner', () => {
  it('leaves out steps whose target is not on the page', async () => {
    anchor('present')
    await run(realPageTour, { force: true })
    expect(driven).toHaveLength(1)
    expect(driven[0].steps?.map((step) => step.popover?.title)).toEqual(['Intro', 'Present'])
  })

  it('keeps every step of a preview tour, which does not ask to skip', async () => {
    anchor('present')
    await run({ ...realPageTour, skipMissingTargets: false }, { force: true })
    expect(driven[0].steps).toHaveLength(3)
  })

  it('does not start a tour left with no steps', async () => {
    await run({ ...realPageTour, steps: [{ element: '[data-tour="missing"]', popover: { title: 'Missing' } }] }, { force: true })
    expect(driven).toHaveLength(0)
  })

  it('prepares the page after navigating and before the first step', async () => {
    const calls: string[] = []
    const navigate = (path: string) => calls.push(`navigate ${path}`)
    await run(
      {
        ...realPageTour,
        route: '/runbooks',
        prepare: async (nav) => {
          calls.push('prepare')
          nav?.('/runbooks?id=1')
          anchor('present')
        },
      },
      { force: true, navigate },
    )
    expect(calls).toEqual(['navigate /runbooks', 'prepare', 'navigate /runbooks?id=1'])
    expect(driven[0].steps?.map((step) => step.popover?.title)).toEqual(['Intro', 'Present'])
  })

  it('stays on the real page when the tour is finished and records it as done', async () => {
    anchor('present')
    const navigate = vi.fn()
    await run({ ...realPageTour, route: '/diagnosis' }, { force: true, navigate })
    navigate.mockClear()
    clickNext(driven[0], false)
    expect(navigate).not.toHaveBeenCalled()
    expect(isTourCompleted('diagnosis')).toBe(true)
  })

  it('does not record a tour closed before its last step as done', async () => {
    anchor('present')
    await run(realPageTour, { force: true })
    clickNext(driven[0], true)
    expect(isTourCompleted('diagnosis')).toBe(false)
    dismiss(driven[0])
    expect(isTourCompleted('diagnosis')).toBe(false)
  })

  it('leaves a preview page for the real page when the tour ends', async () => {
    anchor('present')
    const navigate = vi.fn()
    await run({ ...realPageTour, route: '/tour/results' }, { force: true, navigate })
    navigate.mockClear()
    driven[0].onDestroyed?.(undefined, {}, { config: driven[0], state: {}, driver: undefined } as never)
    expect(navigate).toHaveBeenCalledWith('/results')
  })

  it('never interrupts a running tour with an automatic start', async () => {
    anchor('present')
    await run(realPageTour, { force: true })
    await run({ ...realPageTour, id: 'main' })
    expect(driven).toHaveLength(1)
  })

  it('does not start a finished tour unless forced', async () => {
    anchor('present')
    await run(realPageTour, { force: true })
    clickNext(driven[0], false)
    await run(realPageTour)
    expect(driven).toHaveLength(1)
    resetTourProgress('diagnosis')
    expect(isTourCompleted('diagnosis')).toBe(false)
  })
})

describe('Help section', () => {
  const groups: HelpTourGroup[] = [
    { id: 'start', title: 'Getting started', tours: [realPageTour] },
    { id: 'empty', title: 'Nothing here', tours: [] },
  ]

  it('lists tours by group without a step count, and hides empty groups', () => {
    render(<HelpSection groups={groups} />)
    expect(screen.getByRole('heading', { name: 'Getting started' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Nothing here' })).toBeNull()
    expect(screen.getByText('Diagnosis tour')).toBeTruthy()
    // Steps whose target is missing are skipped at run time, so a count here could be wrong.
    expect(screen.queryByText(/stepCount/)).toBeNull()
    expect(screen.getByRole('button', { name: 'common.helpSection.start: Diagnosis tour' })).toBeTruthy()
  })

  it('shows a finished tour as done with a replay button, and updates when a tour ends', async () => {
    render(<HelpSection groups={groups} />)
    expect(screen.queryByText('common.helpSection.done')).toBeNull()
    anchor('present')
    fireEvent.click(screen.getByRole('button', { name: 'common.helpSection.start: Diagnosis tour' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    act(() => {
      clickNext(driven[0], false)
    })
    expect(screen.getByText('common.helpSection.done')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'common.helpSection.replay: Diagnosis tour' })).toBeTruthy()
  })

  it('groups the Desktop tours by task', () => {
    render(<HelpSection />)
    expect(
      screen.getAllByRole('heading').map((heading) => heading.textContent),
    ).toEqual([
      'common.helpSection.gettingStarted',
      'common.helpSection.investigate',
      'common.helpSection.automate',
    ])
  })
})
