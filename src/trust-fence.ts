/**
 * Browser-trust fence for this plugin's routes, behaviorally identical to the
 * /api gateway's fence in `@deepseek-ai/dsh-client-connection`
 * (src/api-request-trust.ts + src/loopback-hostname.ts, BSD-3-Clause) and to
 * `@omdsh-plugins/omdsh-sidepanel`'s restatement of it. Restated again here
 * because neither package exports the helpers and a plugin must not reach into
 * another package's internals.
 *
 * ## Two fences, not one
 *
 * The READ routes (catalog, installed, events) get the same fence `/api` gets:
 * a Host header naming us — loopback, or an authority this deployment was told
 * to serve — plus same-origin browser markers. They are exactly as reachable
 * as the settings panel that renders them, which is the right bar for reading
 * a list of package names.
 *
 * The WRITE routes get a stricter one: LOOPBACK ONLY, whatever
 * `--trusted-host` says. Installing a plugin runs that package's `prepare`
 * script on this machine, and "the deployment published /api to the LAN" is
 * not consent to that. Someone who genuinely wants to install over a published
 * `dsh web` still can — from a terminal, with `dsh plugin --profile <name>
 * add`, where the decision is visibly theirs.
 *
 * Neither fence is authentication. They are DNS-rebinding and cross-site
 * defenses: they answer "is this browser looking at our own page", not "who is
 * this person".
 * @module @omdsh-plugins/omdsh-plughub/trust-fence
 */

import type { IncomingHttpHeaders } from 'node:http'

/** The request facts the fence reads (structural subset of IncomingMessage). */
export interface TrustRequest {
  readonly headers: IncomingHttpHeaders
}

/** One header's value, when it was sent exactly once. */
function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a normalized hostname names the local loopback authority.
 * @param hostname - the URL-normalized hostname.
 * @returns true for localhost, [::1], and the whole 127.0.0.0/8 literal range.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact, or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** Whether the browser markers say this request came from our own origin. */
function isSameOrigin(request: TrustRequest, hostUrl: URL): boolean {
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Decide whether one request may READ from this plugin's routes.
 * @param request - node HTTP request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours and the browser markers are same-origin.
 */
export function isTrustedRequest(request: TrustRequest, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  return isSameOrigin(request, hostUrl)
}

/**
 * Decide whether one request may WRITE — install or remove a plugin. Same
 * same-origin requirement, and no `trustedHosts` escape: an install executes
 * code on this machine, so it is reachable only from this machine.
 * @param request - node HTTP request facts (headers).
 * @returns true when the Host is loopback and the browser markers are same-origin.
 */
export function isLoopbackRequest(request: TrustRequest): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  return isSameOrigin(request, hostUrl)
}
