import { EventEmitter } from 'node:events'
import type net from 'node:net'
import { describe, expect, it } from 'vitest'
import { isGrinderAnnouncement, lookupFirst, probeHost } from '../lib/presence.mjs'

/** A socket stand-in that emits one outcome on the next tick. */
function fakeConnect(outcome: 'connect' | 'timeout' | { code: string }) {
  const calls: { host: string, port: number, timeout: number }[] = []
  const connect = (options: { host: string, port: number, timeout: number }) => {
    calls.push(options)
    const socket = Object.assign(new EventEmitter(), { destroy: () => undefined })
    setImmediate(() => {
      if (outcome === 'connect' || outcome === 'timeout') socket.emit(outcome)
      else socket.emit('error', Object.assign(new Error(outcome.code), { code: outcome.code }))
    })
    return socket as unknown as net.Socket
  }
  return { connect, calls }
}

describe('probeHost', () => {
  it('counts an accepted connection as online (the grinder)', async () => {
    const { connect, calls } = fakeConnect('connect')
    expect(await probeHost('192.168.1.155', 80, 3000, connect)).toBe(true)
    expect(calls).toEqual([{ host: '192.168.1.155', port: 80, timeout: 3000 }])
  })

  it('counts a refused connection as online (the scale answers but has no open port)', async () => {
    expect(await probeHost('192.168.1.35', 80, 3000, fakeConnect({ code: 'ECONNREFUSED' }).connect)).toBe(true)
  })

  it('counts no answer as offline', async () => {
    expect(await probeHost('192.168.1.250', 80, 3000, fakeConnect('timeout').connect)).toBe(false)
    expect(await probeHost('192.168.1.250', 80, 3000, fakeConnect({ code: 'EHOSTUNREACH' }).connect)).toBe(false)
  })
})

describe('lookupFirst', () => {
  it('returns the address of the first name that resolves', async () => {
    const asked: string[] = []
    const lookup = async (name: string) => {
      asked.push(name)
      if (name === 'SyncScale.localdomain') return { address: '192.168.1.35' }
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
    }

    expect(await lookupFirst(['SyncScale', 'SyncScale.localdomain'], lookup)).toBe('192.168.1.35')
    expect(asked).toEqual(['SyncScale', 'SyncScale.localdomain'])
  })

  it('returns null when no name resolves', async () => {
    expect(await lookupFirst(['SyncScale'], async () => { throw new Error('not found') })).toBeNull()
  })
})

describe('isGrinderAnnouncement', () => {
  it('matches "hemrohsg" + the device id in the name, host or full name, ignoring case', () => {
    expect(isGrinderAnnouncement({ name: 'hemrohsgGRINDER-1 [00:00:00:00:00:00]' }, 'GRINDER-1')).toBe(true)
    expect(isGrinderAnnouncement({ host: 'HEMROHSGgrinder-1.local' }, 'GRINDER-1')).toBe(true)
    expect(isGrinderAnnouncement({ fullname: 'hemrohsgGRINDER-1._workstation._tcp.local' }, 'GRINDER-1')).toBe(true)
    expect(isGrinderAnnouncement({ name: 'hemrohsgGRINDER-2' }, 'GRINDER-1')).toBe(false)
    expect(isGrinderAnnouncement({ name: 'hemrohsgGRINDER-10 [00:00:00:00:00:00]' }, 'GRINDER-1')).toBe(false)
    expect(isGrinderAnnouncement({ name: 'hemrohsgGRINDER-1' }, 'GRINDER-1')).toBe(true)
    expect(isGrinderAnnouncement({}, 'GRINDER-1')).toBe(false)
  })
})
