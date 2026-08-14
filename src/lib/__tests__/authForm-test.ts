import {
  hasAuthErrors,
  validateForgotPasswordForm,
  validateLoginForm,
  validateRegisterForm,
} from '../authForm';

describe('authForm', () => {
  it('validates login fields', () => {
    expect(validateLoginForm({ email: '', password: '' })).toEqual({
      email: 'Email is required',
      password: 'Password is required',
    });
    expect(
      validateLoginForm({ email: 'bad', password: 'secret' }),
    ).toEqual({
      email: 'Enter a valid email',
    });
    expect(
      validateLoginForm({
        email: 'a@b.com',
        password: 'secret',
      }),
    ).toEqual({});
  });

  it('validates register fields', () => {
    const errors = validateRegisterForm({
      email: 'a@b.com',
      password: '123',
      displayName: 'A',
    });
    expect(errors.password).toBe(
      'Password must be at least 6 characters',
    );
    expect(errors.displayName).toBe(
      'Display name must be at least 2 characters',
    );
  });

  it('validates forgot password', () => {
    expect(validateForgotPasswordForm('')).toEqual({
      email: 'Email is required',
    });
    expect(validateForgotPasswordForm('ok@test.com')).toEqual({});
  });

  it('detects error objects', () => {
    expect(hasAuthErrors({})).toBe(false);
    expect(hasAuthErrors({ email: 'x' })).toBe(true);
  });
});

  it('requires display name on register', () => {
    const errors = validateRegisterForm({
      email: 'a@b.com',
      password: 'secret1',
      displayName: '   ',
    });
    expect(errors.displayName).toBe('Display name is required');
  });

  it('rejects invalid forgot-password emails', () => {
    expect(validateForgotPasswordForm('nope')).toEqual({
      email: 'Enter a valid email',
    });
  });
