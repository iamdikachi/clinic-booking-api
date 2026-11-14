import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const validEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/clinic',
    API_KEY: 'secret-key',
  };

  it('accepts valid DATABASE_URL and API_KEY with default PORT', () => {
    const result = validateEnv(validEnv);
    expect(result.PORT).toBe(3000);
    expect(result.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(result.API_KEY).toBe('secret-key');
  });

  it('accepts a custom PORT and trims whitespace', () => {
    const result = validateEnv({
      DATABASE_URL: '  postgres://user:pass@localhost:5432/clinic  ',
      API_KEY: '  my-key  ',
      PORT: '8080',
    });
    expect(result.PORT).toBe(8080);
    expect(result.DATABASE_URL).toBe(
      'postgres://user:pass@localhost:5432/clinic',
    );
    expect(result.API_KEY).toBe('my-key');
  });

  it('throws when DATABASE_URL is missing or invalid', () => {
    expect(() => validateEnv({ API_KEY: 'k' })).toThrow('DATABASE_URL');
    expect(() =>
      validateEnv({ DATABASE_URL: 'mysql://localhost/db', API_KEY: 'k' }),
    ).toThrow('Postgres');
  });

  it('throws when API_KEY is missing or blank', () => {
    expect(() => validateEnv({ DATABASE_URL: validEnv.DATABASE_URL })).toThrow(
      'API_KEY',
    );
    expect(() =>
      validateEnv({ DATABASE_URL: validEnv.DATABASE_URL, API_KEY: '   ' }),
    ).toThrow('API_KEY');
  });

  it('throws when PORT is out of range or non-integer', () => {
    expect(() => validateEnv({ ...validEnv, PORT: '0' })).toThrow('PORT');
    expect(() => validateEnv({ ...validEnv, PORT: '70000' })).toThrow('PORT');
    expect(() => validateEnv({ ...validEnv, PORT: 'abc' })).toThrow('PORT');
    expect(() => validateEnv({ ...validEnv, PORT: {} })).toThrow('PORT');
  });

  it('uses default PORT when PORT is blank string', () => {
    const result = validateEnv({ ...validEnv, PORT: '   ' });
    expect(result.PORT).toBe(3000);
  });
});
