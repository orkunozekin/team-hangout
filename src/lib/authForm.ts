export interface AuthFormFields {
  email: string;
  password: string;
  displayName?: string;
}

export interface AuthFormErrors {
  email?: string;
  password?: string;
  displayName?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLoginForm(
  fields: Pick<AuthFormFields, 'email' | 'password'>,
): AuthFormErrors {
  const errors: AuthFormErrors = {};

  const email = fields.email.trim();
  if (!email) {
    errors.email = 'Email is required';
  } else if (!EMAIL_RE.test(email)) {
    errors.email = 'Enter a valid email';
  }

  if (!fields.password) {
    errors.password = 'Password is required';
  }

  return errors;
}

export function validateRegisterForm(
  fields: AuthFormFields,
): AuthFormErrors {
  const errors = validateLoginForm(fields);

  const displayName = (fields.displayName ?? '').trim();
  if (!displayName) {
    errors.displayName = 'Display name is required';
  } else if (displayName.length < 2) {
    errors.displayName = 'Display name must be at least 2 characters';
  }

  if (fields.password && fields.password.length < 6) {
    errors.password = 'Password must be at least 6 characters';
  }

  return errors;
}

export function validateForgotPasswordForm(
  email: string,
): AuthFormErrors {
  const errors: AuthFormErrors = {};
  const trimmed = email.trim();

  if (!trimmed) {
    errors.email = 'Email is required';
  } else if (!EMAIL_RE.test(trimmed)) {
    errors.email = 'Enter a valid email';
  }

  return errors;
}

export function hasAuthErrors(errors: AuthFormErrors): boolean {
  return Object.keys(errors).length > 0;
}
