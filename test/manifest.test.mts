// Generic manifest / translation / release-metadata checks for a Homey app.
// Run the translation-coverage recipe first: leave out assertions for real gaps (file them in TODO.md)
// and fix trivial ones (such as an unused extra locale key) as part of the setup.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url).pathname
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))

const LANGUAGES = readdirSync(join(root, 'locales')).filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, '')).sort()

const walk = (dir: string): string[] =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
    : []

const FLOW_TYPES = ['actions', 'conditions', 'triggers'] as const

const flowCardFiles = FLOW_TYPES.flatMap((type) =>
  walk(join('.homeycompose/flow', type))
    .filter((file) => file.endsWith('.json'))
    .map((path) => ({ type, path })))

// Device cards live in drivers/<id>/driver.flow.compose.json, grouped by type.
type FlowCard = { id: string, args?: unknown[], tokens?: unknown[] }
const driverFlowCards = walk('drivers')
  .filter((file) => file.endsWith('driver.flow.compose.json'))
  .flatMap((path) => FLOW_TYPES.flatMap((type) =>
    ((readJson(path)[type] ?? []) as FlowCard[]).map((card) => ({ type, path, card }))))

const composedCards = [
  ...flowCardFiles.map((entry) => ({ type: entry.type, path: entry.path, card: readJson(entry.path) as FlowCard })),
  ...driverFlowCards,
]

const translatedFiles = [
  ...walk('.homeycompose').filter((file) => file.endsWith('.json')),
  ...walk('drivers').filter((file) => /compose\.json$/.test(file)),
  ...walk('widgets').filter((file) => /compose\.json$/.test(file)),
]

/** Every object with a string `en` key is a translation; returns the ones missing a language. */
function missingTranslations(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => missingTranslations(item, `${path}[${index}]`))
  }
  if (value === null || typeof value !== 'object') {
    return []
  }
  const object = value as Record<string, unknown>
  if (typeof object.en === 'string') {
    return LANGUAGES.filter((language) => !object[language]).map((language) => `${path}.${language}`)
  }
  return Object.entries(object).flatMap(([key, child]) => missingTranslations(child, `${path}.${key}`))
}

describe('compose files', () => {
  it.each(translatedFiles)('%s is translated into every language', (path) => {
    expect(missingTranslations(readJson(path))).toEqual([])
  })

  it.each(composedCards.map((entry) => [`${entry.path} ${entry.card.id}`, entry.card] as const))('%s has no empty args/tokens arrays', (_name, card) => {
    // Empty arrays broke cards in standard (non-advanced) Flows.
    expect(card.args === undefined || card.args.length > 0).toBe(true)
    expect(card.tokens === undefined || card.tokens.length > 0).toBe(true)
  })

  it('app.json is regenerated from the compose files (same flow card ids)', () => {
    const manifest = readJson('app.json')
    for (const type of FLOW_TYPES) {
      const composed = composedCards.filter((entry) => entry.type === type).map((entry) => entry.card.id).sort()
      const generated = ((manifest.flow?.[type] ?? []) as { id: string }[]).map((card) => card.id).sort()
      expect(generated, `flow.${type}`).toEqual(composed)
    }
  })
})

describe('drivers', () => {
  const manifest = readJson('app.json')
  const customCapabilities = walk('.homeycompose/capabilities').map((file) => file.replace(/^.*\//, '').replace(/\.json$/, ''))
  // Homey system capabilities the drivers use; everything else must be a custom capability.
  const SYSTEM_CAPABILITIES = ['measure_temperature']

  it('every driver capability is a custom or known system capability', () => {
    for (const driver of manifest.drivers as { id: string, capabilities: string[] }[]) {
      for (const capability of driver.capabilities) {
        expect(customCapabilities.includes(capability) || SYSTEM_CAPABILITIES.includes(capability), `${driver.id}: ${capability}`).toBe(true)
      }
    }
  })

  it('the Sync Scale capabilities the device adds at runtime are defined', () => {
    for (const capability of ['yield_weight', 'shot_time', 'brew_ratio']) {
      expect(manifest.capabilities[capability], capability).toBeDefined()
    }
  })

  it('every image path in app.json exists', () => {
    const paths = [
      ...Object.values(manifest.images as Record<string, string>),
      ...(manifest.drivers as { images: Record<string, string> }[]).flatMap((driver) => Object.values(driver.images)),
    ]
    for (const path of paths) {
      expect(existsSync(join(root, path)), path).toBe(true)
    }
  })
})

describe('locales and READMEs', () => {
  const keys = (object: object, prefix = ''): string[] =>
    Object.entries(object).flatMap(([key, value]) =>
      typeof value === 'object' && value !== null ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`])

  const english = keys(readJson('locales/en.json')).sort()

  it.each(LANGUAGES.filter((language) => language !== 'en'))('locales/%s.json has the same keys as en.json', (language) => {
    expect(keys(readJson(`locales/${language}.json`)).sort()).toEqual(english)
  })

  it.each(LANGUAGES)('README.txt exists for %s', (language) => {
    const file = language === 'en' ? 'README.txt' : `README.${language}.txt`
    expect(readFileSync(join(root, file), 'utf8').trim()).not.toBe('')
  })
})

describe('release metadata', () => {
  const version = readJson('.homeycompose/app.json').version

  it('app.json and package.json match the .homeycompose version', () => {
    expect(readJson('app.json').version).toBe(version)
    expect(readJson('package.json').version).toBe(version)
  })

  it('.homeychangelog.json is valid JSON with an entry for the current version', () => {
    expect(readJson('.homeychangelog.json')[version]?.en).toBeTruthy()
  })
})
