// Stand-in for the `homey` module, which only exists inside the Homey runtime.
// Aliased in vitest.config.mjs. Only the parts the app, driver and device use are implemented.

class App {
  homey: unknown

  constructor(homey: unknown) {
    this.homey = homey
  }

  log(...args: unknown[]) {}

  error(...args: unknown[]) {}
}

class Device {
  homey: unknown
  capabilities: string[]
  capabilityValues = new Map<string, unknown>()
  settings: Record<string, unknown>
  data: Record<string, unknown>
  store: Record<string, unknown>
  available = true
  unavailableMessage: string | undefined
  errors: unknown[][] = []

  constructor(homey: unknown, options: {
    settings?: Record<string, unknown>,
    data?: Record<string, unknown>,
    store?: Record<string, unknown>,
    capabilities?: string[],
  } = {}) {
    this.homey = homey
    this.settings = { ...options.settings }
    this.data = { id: 'GRINDER-1', ...options.data }
    this.store = structuredClone(options.store ?? {})
    this.capabilities = [...(options.capabilities ?? [])]
  }

  // Like Homey: a capability that was never set reads as null.
  getCapabilityValue(id: string) {
    return this.capabilityValues.has(id) ? this.capabilityValues.get(id) : null
  }

  async setCapabilityValue(id: string, value: unknown) {
    if (!this.capabilities.includes(id)) {
      throw new Error(`Device has no capability ${id}`)
    }
    this.capabilityValues.set(id, value)
  }

  hasCapability(id: string) {
    return this.capabilities.includes(id)
  }

  async addCapability(id: string) {
    if (!this.capabilities.includes(id)) {
      this.capabilities.push(id)
    }
  }

  async setAvailable() {
    this.available = true
    this.unavailableMessage = undefined
  }

  async setUnavailable(message?: string) {
    this.available = false
    this.unavailableMessage = message
  }

  getAvailable() {
    return this.available
  }

  async setSettings(settings: Record<string, unknown>) {
    Object.assign(this.settings, settings)
  }

  getSetting(key: string) {
    return this.settings[key]
  }

  getSettings() {
    return this.settings
  }

  getData() {
    return this.data
  }

  // Like Homey: the store holds JSON, so values come back as copies.
  getStoreValue(key: string) {
    return key in this.store ? structuredClone(this.store[key]) : null
  }

  async setStoreValue(key: string, value: unknown) {
    this.store[key] = structuredClone(value)
  }

  log(...args: unknown[]) {}

  error(...args: unknown[]) {
    this.errors.push(args)
  }
}

class Driver {
  homey: unknown

  constructor(homey: unknown) {
    this.homey = homey
  }

  log(...args: unknown[]) {}

  error(...args: unknown[]) {}
}

export default { App, Device, Driver }
