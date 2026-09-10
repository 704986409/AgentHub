import { describe, expect, it } from 'vitest';

import { redactEventValue } from '../src/index.js';

describe('Event redaction precision', () => {
  it('preserves non-sensitive keys that contain auth or author text', () => {
    const value = {
      authority: 'ADMIN',
      author: 'Codex',
      authorId: 'author-1',
      authenticationMode: 'oauth',
    };

    expect(redactEventValue(value)).toEqual(value);
  });

  it('redacts exact sensitive keys and normalized separator variants', () => {
    const value = {
      auth: 'auth-value',
      authorization: 'authorization-value',
      apiKey: 'api-key-value',
      api_key: 'api-key-snake-value',
      'api-key': 'api-key-kebab-value',
      token: 'token-value',
      accessToken: 'access-token-value',
      access_token: 'access-token-snake-value',
      'access-token': 'access-token-kebab-value',
      refreshToken: 'refresh-token-value',
      refresh_token: 'refresh-token-snake-value',
      'refresh-token': 'refresh-token-kebab-value',
      secret: 'secret-value',
      password: 'password-value',
      cookie: 'cookie-value',
      credential: 'credential-value',
      credentials: 'credentials-value',
    };

    expect(redactEventValue(value)).toEqual(
      Object.fromEntries(Object.keys(value).map((key) => [key, '[REDACTED]'])),
    );
  });

  it('redacts sensitive values recursively in nested objects and arrays', () => {
    expect(
      redactEventValue({
        nested: { authority: 'ADMIN', token: 'nested-token' },
        items: [
          { author: 'Codex', password: 'array-password' },
          { authenticationMode: 'oauth', api_key: 'array-api-key' },
        ],
      }),
    ).toEqual({
      nested: { authority: 'ADMIN', token: '[REDACTED]' },
      items: [
        { author: 'Codex', password: '[REDACTED]' },
        { authenticationMode: 'oauth', api_key: '[REDACTED]' },
      ],
    });
  });

  it('redacts sensitive string assignments without altering normal assignments', () => {
    const sensitive = 'token=abc password: xyz authorization: Bearer bearer-secret';
    expect(redactEventValue(sensitive)).toBe(
      'token=[REDACTED] password=[REDACTED] authorization=[REDACTED]',
    );
    expect(redactEventValue('agent authority=ADMIN; author=Codex')).toBe(
      'agent authority=ADMIN; author=Codex',
    );
  });
});
