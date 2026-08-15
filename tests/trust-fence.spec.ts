/**
 * The two fences.
 *
 * The read fence must behave exactly like `/api`'s — a route that were LOOSER
 * would leak a plugin list to a cross-site page, and one that were TIGHTER
 * would break the panel on a legitimately published `dsh web`. The write fence
 * must be strictly narrower, because an install runs a package's build script
 * on the Host.
 */

import { describe, expect, it } from 'vitest'
import { isLoopbackHostname, isLoopbackRequest, isTrustedRequest } from '../src/trust-fence.ts'

/** One request, spelled as headers. */
function request(headers: Record<string, string | undefined>): { headers: Record<string, string | undefined> } {
  return { headers }
}

describe('isLoopbackHostname', () => {
  it('accepts every spelling of this machine', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    // The whole 127.0.0.0/8 range is loopback, not just .0.1.
    expect(isLoopbackHostname('127.4.5.6')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(isLoopbackHostname('192.168.1.10')).toBe(false)
    expect(isLoopbackHostname('127.0.0.256')).toBe(false)
    expect(isLoopbackHostname('127.0.0')).toBe(false)
    expect(isLoopbackHostname('evil.test')).toBe(false)
  })
})

describe('isTrustedRequest', () => {
  it('accepts a same-origin loopback request', () => {
    expect(isTrustedRequest(request({ host: 'localhost:3000' }), [])).toBe(true)
    expect(isTrustedRequest(request({
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'same-origin',
    }), [])).toBe(true)
  })

  it('accepts an authority this deployment was told to serve', () => {
    expect(isTrustedRequest(request({ host: '192.168.1.10:3000' }), ['192.168.1.10:3000'])).toBe(true)
    // A port-less trusted entry matches on hostname alone.
    expect(isTrustedRequest(request({ host: '192.168.1.10:3000' }), ['192.168.1.10'])).toBe(true)
  })

  it('refuses an authority nobody vouched for', () => {
    // The DNS-rebinding case: a name that resolves here but was never named.
    expect(isTrustedRequest(request({ host: 'evil.test' }), ['192.168.1.10'])).toBe(false)
    expect(isTrustedRequest(request({}), [])).toBe(false)
  })

  it('refuses a cross-site request', () => {
    expect(isTrustedRequest(request({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }), [])).toBe(false)
    expect(isTrustedRequest(request({ host: 'localhost:3000', origin: 'https://evil.test' }), [])).toBe(false)
  })

  it('refuses an unparsable origin rather than ignoring it', () => {
    expect(isTrustedRequest(request({ host: 'localhost:3000', origin: 'not a url' }), [])).toBe(false)
  })
})

describe('isLoopbackRequest', () => {
  it('accepts the same same-origin loopback requests the read fence does', () => {
    expect(isLoopbackRequest(request({ host: 'localhost:3000' }))).toBe(true)
    expect(isLoopbackRequest(request({
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
    }))).toBe(true)
  })

  it('refuses a trusted host that is not loopback', () => {
    // The whole point of the second fence: "the deployment published /api to
    // the LAN" is not consent to run a package's build script here.
    expect(isTrustedRequest(request({ host: '192.168.1.10:3000' }), ['192.168.1.10:3000'])).toBe(true)
    expect(isLoopbackRequest(request({ host: '192.168.1.10:3000' }))).toBe(false)
  })

  it('still refuses a cross-site loopback request', () => {
    expect(isLoopbackRequest(request({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isLoopbackRequest(request({ host: 'localhost:3000', origin: 'http://localhost:9999' }))).toBe(false)
  })
})
