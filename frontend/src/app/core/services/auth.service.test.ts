import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { of, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { SyncService } from './sync.service';
import { StorageService } from './storage.service';

const cachedUser = { user_id: '42', roles: ['user'] };
function setup(status: number) {
  const values = new Map<string, unknown>([['session_user', cachedUser]]);
  const accounts: (string | null)[] = [];
  const injector = Injector.create({
    providers: [
      {
        provide: HttpClient,
        useValue: {
          get: () =>
            status === 200
              ? of({ data: { user: cachedUser } })
              : throwError(() => new HttpErrorResponse({ status })),
          post: () => throwError(() => new HttpErrorResponse({ status })),
        },
      },
      {
        provide: SyncService,
        useValue: {
          setAccount: async (id: string | null) => {
            accounts.push(id);
          },
        },
      },
      {
        provide: StorageService,
        useValue: {
          get: (key: string) => values.get(key) ?? null,
          set: (key: string, value: unknown) => values.set(key, value),
          remove: (key: string) => values.delete(key),
        },
      },
      { provide: Router, useValue: { navigate: async () => true } },
    ],
  });
  const auth = runInInjectionContext(injector, () => new AuthService());
  return { auth, accounts, values };
}

describe('offline session handling', () => {
  it('restores the last account when the network is unavailable', async () => {
    const { auth, accounts } = setup(0);
    await auth.loadCurrentUser();
    expect(auth.currentUser()).toEqual(cachedUser);
    expect(accounts).toEqual(['42']);
  });

  it('does not restore a cached account when the server rejects the session', async () => {
    const { auth, accounts, values } = setup(401);
    await auth.loadCurrentUser();
    expect(auth.isAuthenticated()).toBe(false);
    expect(accounts).toEqual([null]);
    expect(values.has('session_user')).toBe(false);
  });

  it('rejects older cached sessions that have no account identity', async () => {
    const { auth, values } = setup(0);
    values.set('session_user', { roles: ['user'] });
    await auth.loadCurrentUser();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('allows sign-out when the server session has already expired', async () => {
    const { auth, accounts, values } = setup(401);
    await auth.logout();
    expect(accounts).toEqual([null]);
    expect(values.has('session_user')).toBe(false);
  });

  it('retains the cached session if server sign-out fails', async () => {
    const { auth, accounts, values } = setup(500);
    await expect(auth.logout()).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(accounts).toEqual([]);
    expect(values.get('session_user')).toEqual(cachedUser);
  });
});
