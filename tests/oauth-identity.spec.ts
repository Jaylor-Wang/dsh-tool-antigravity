/**
 * Account-address extraction from the token response.
 *
 * Google does not return `email` on the token response body; it carries it in the
 * `id_token` claims. Reading only the top-level field silently produced accounts with no
 * identity, so every login appended a duplicate instead of refreshing the known account.
 */

import { describe, expect, it, vi } from 'vitest'
import { ANTIGRAVITY_CLIENT_ID } from '@cortexkit/antigravity-auth-core'
import { createGoogleTokenExchanger } from '../src/oauth-flow.ts'

const CLOCK = { now: () => 1_000, setTimeout, clearTimeout }

/** Build an unsigned JWT whose payload carries the given claims. */
function idTokenWith(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.signature-not-verified-here`
}

function respondWith(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
}

function validTokenResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'access-token-value',
    refresh_token: 'refresh-token-value',
    expires_in: 3_600,
    token_type: 'Bearer',
    ...extra,
  }
}

describe('Google token exchange account identity', () => {
  it('reads the address from the id_token claims', async () => {
    const fetchImpl = respondWith(validTokenResponse({
      id_token: idTokenWith({ email: 'alice@example.com', email_verified: true, sub: '123' }),
    }))
    const exchange = createGoogleTokenExchanger(fetchImpl, CLOCK)

    const result = await exchange({ code: 'code', verifier: 'verifier', signal: new AbortController().signal })
    expect(result.email).toBe('alice@example.com')
  })

  it('prefers a top-level email when the response carries one', async () => {
    const fetchImpl = respondWith(validTokenResponse({
      email: 'top-level@example.com',
      id_token: idTokenWith({ email: 'claim@example.com' }),
    }))
    const exchange = createGoogleTokenExchanger(fetchImpl, CLOCK)

    const result = await exchange({ code: 'code', verifier: 'verifier', signal: new AbortController().signal })
    expect(result.email).toBe('top-level@example.com')
  })

  it('omits the address when no id_token is present', async () => {
    const fetchImpl = respondWith(validTokenResponse())
    const exchange = createGoogleTokenExchanger(fetchImpl, CLOCK)

    const result = await exchange({ code: 'code', verifier: 'verifier', signal: new AbortController().signal })
    // The field must be absent, not an explicit undefined.
    expect('email' in result).toBe(false)
  })

  it('omits the address when the id_token claims carry none', async () => {
    const fetchImpl = respondWith(validTokenResponse({ id_token: idTokenWith({ sub: '123' }) }))
    const exchange = createGoogleTokenExchanger(fetchImpl, CLOCK)

    const result = await exchange({ code: 'code', verifier: 'verifier', signal: new AbortController().signal })
    expect('email' in result).toBe(false)
  })

  it('survives a malformed id_token instead of failing the login', async () => {
    // A bad token must not turn a valid credential into a failed sign-in.
    for (const malformed of ['not-a-jwt', 'a.b', 'a.!!!not-base64!!!.c', `${'x'.repeat(40)}.${'y'.repeat(20_000)}.z`]) {
      const fetchImpl = respondWith(validTokenResponse({ id_token: malformed }))
      const exchange = createGoogleTokenExchanger(fetchImpl, CLOCK)
      const result = await exchange({ code: 'code', verifier: 'verifier', signal: new AbortController().signal })
      expect(result.accessToken).toBe('access-token-value')
      expect('email' in result).toBe(false)
    }
  })

  it('rejects a non-JSON claims payload without throwing', async () => {
    const encoded = Buffer.from('this is not json').toString('base64url')
    const fetchImpl = respondWith(validTokenResponse({ id_token: `header.${encoded}.sig` }))
    const exchange = createGoogleTokenExchanger(fetchImpl, CLOCK)

    const result = await exchange({ code: 'code', verifier: 'verifier', signal: new AbortController().signal })
    expect('email' in result).toBe(false)
  })

  it('ignores a non-string email claim', async () => {
    const fetchImpl = respondWith(validTokenResponse({ id_token: idTokenWith({ email: 42 }) }))
    const exchange = createGoogleTokenExchanger(fetchImpl, CLOCK)

    const result = await exchange({ code: 'code', verifier: 'verifier', signal: new AbortController().signal })
    expect('email' in result).toBe(false)
  })

  it('still sends the client id to the token endpoint', async () => {
    const fetchImpl = respondWith(validTokenResponse({ id_token: idTokenWith({ email: 'alice@example.com' }) }))
    const exchange = createGoogleTokenExchanger(fetchImpl, CLOCK)

    await exchange({ code: 'code', verifier: 'verifier', signal: new AbortController().signal })
    const call = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(call?.[0]).toBe('https://oauth2.googleapis.com/token')
    expect(String(call?.[1].body)).toContain(ANTIGRAVITY_CLIENT_ID)
  })
})
