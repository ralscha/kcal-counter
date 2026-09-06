import { computed, inject, Service, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SessionPrincipal } from '../models/user.model';
import { StorageService } from './storage.service';
import { SyncService } from './sync.service';
import {
  prepareAssertionOptions,
  prepareCreationOptions,
  serializeAssertionCredential,
  serializeAttestationCredential,
} from '../../shared/utils/passkey.util';

interface UserEnvelope {
  data: {
    user: SessionPrincipal;
  };
}

interface PasskeyRegisterEnvelope {
  data: {
    options: {
      publicKey: PublicKeyCredentialCreationOptionsJSON;
    };
  };
}

@Service()
export class AuthService {
  readonly #http = inject(HttpClient);
  readonly #router = inject(Router);
  readonly #storage = inject(StorageService);
  readonly #sync = inject(SyncService);
  readonly #currentUser = signal<SessionPrincipal | null>(null);
  readonly currentUser = this.#currentUser.asReadonly();
  readonly isAuthenticated = computed(() => this.#currentUser() !== null);

  async loadCurrentUser(): Promise<void> {
    let user: SessionPrincipal | null = null;
    try {
      const res = await firstValueFrom(
        this.#http.get<UserEnvelope>('/api/v1/auth/me', { withCredentials: true, timeout: 5_000 }),
      );
      user = res.data.user;
    } catch (error) {
      if (error instanceof HttpErrorResponse && (error.status === 0 || error.status >= 500)) {
        user = this.#storage.get<SessionPrincipal>('session_user');
      }
    }
    await this.#setCurrentUser(user);
  }

  async #setCurrentUser(user: SessionPrincipal | null): Promise<void> {
    // Older cached sessions have no account ID and cannot safely own local data.
    const principal = user?.user_id ? user : null;
    await this.#sync.setAccount(principal?.user_id ?? null);
    this.#currentUser.set(principal);
    if (principal) {
      this.#storage.set('session_user', principal);
    } else {
      this.#storage.remove('session_user');
    }
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(
        this.#http.post('/api/v1/auth/logout', {}, { withCredentials: true, timeout: 5_000 }),
      );
    } catch (error) {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        throw error;
      }
    }
    await this.#setCurrentUser(null);
    await this.#router.navigate(['/auth/login']);
  }

  async registerPasskey(): Promise<void> {
    const startRes = await firstValueFrom(
      this.#http.post<PasskeyRegisterEnvelope>(
        '/api/v1/auth/passkeys/register',
        {},
        { withCredentials: true },
      ),
    );

    const creationOptions = prepareCreationOptions(startRes.data.options.publicKey);
    const credential = await navigator.credentials.create({ publicKey: creationOptions });
    if (!credential) {
      throw new Error('No credential returned.');
    }

    const finishRes = await firstValueFrom(
      this.#http.post<UserEnvelope>(
        '/api/v1/auth/passkeys/register/finish',
        { credential: serializeAttestationCredential(credential as PublicKeyCredential) },
        { withCredentials: true },
      ),
    );
    await this.#setCurrentUser(finishRes.data.user);
  }

  async loginWithPasskey(): Promise<void> {
    const startRes = await firstValueFrom(
      this.#http.post<{ data: { options: { publicKey: PublicKeyCredentialRequestOptionsJSON } } }>(
        '/api/v1/auth/passkeys/login/start',
        {},
        { withCredentials: true },
      ),
    );

    const requestOptions = prepareAssertionOptions(startRes.data.options.publicKey);
    const assertion = await navigator.credentials.get({
      publicKey: requestOptions,
    });
    if (!assertion) {
      throw new Error('No assertion returned.');
    }

    const res = await firstValueFrom(
      this.#http.post<UserEnvelope>(
        '/api/v1/auth/passkeys/login/finish',
        { credential: serializeAssertionCredential(assertion as PublicKeyCredential) },
        { withCredentials: true },
      ),
    );
    await this.#setCurrentUser(res.data.user);
  }
}
