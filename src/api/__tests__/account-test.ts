const mockCallable = jest.fn();

jest.mock('firebase/functions', () => ({
  httpsCallable: jest.fn(() => mockCallable),
}));

const mockLogout = jest.fn();

jest.mock('../auth', () => ({
  logout: (...args: unknown[]) => mockLogout(...args),
}));

import {
  httpsCallable,
} from 'firebase/functions';

import {
  deleteAccount,
  getDeleteAccountErrorMessage,
} from '../account';

import {
  functions,
} from '../../firebase/config';

describe('api/account', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (httpsCallable as jest.Mock).mockReturnValue(mockCallable);
  });

  it('calls deleteAccount and logs out', async () => {
    mockCallable.mockResolvedValue({
      data: { ok: true, membershipsRemoved: 2 },
    });
    mockLogout.mockResolvedValue(undefined);

    const result = await deleteAccount();

    expect(httpsCallable).toHaveBeenCalledWith(
      functions,
      'deleteAccount',
    );
    expect(mockCallable).toHaveBeenCalled();
    expect(mockLogout).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, membershipsRemoved: 2 });
  });

  it('still returns result if local logout fails', async () => {
    mockCallable.mockResolvedValue({
      data: { ok: true, membershipsRemoved: 0 },
    });
    mockLogout.mockRejectedValue(new Error('already gone'));

    await expect(deleteAccount()).resolves.toEqual({
      ok: true,
      membershipsRemoved: 0,
    });
  });

  it('maps callable error codes', () => {
    expect(
      getDeleteAccountErrorMessage({ code: 'functions/not-found' }),
    ).toMatch(/not available yet/i);
    expect(
      getDeleteAccountErrorMessage({ code: 'functions/unavailable' }),
    ).toMatch(/not available yet/i);
    expect(
      getDeleteAccountErrorMessage({ code: 'functions/unauthenticated' }),
    ).toMatch(/signed in/i);
    expect(getDeleteAccountErrorMessage(new Error('nope'))).toBe('nope');
    expect(getDeleteAccountErrorMessage('x')).toMatch(/Could not delete/);
  });
});
