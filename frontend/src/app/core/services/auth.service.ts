import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SessionPrincipal } from '../models/user.model';
import {
  prepareAssertionOptions,
  prepareCreationOptions,
  serializeAssertionCredential,
  serializeAttestationCredential,
  supportsImmediateMediation,
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

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly #http = inject(HttpClient);
  readonly #router = inject(Router);
  readonly #currentUser = signal<SessionPrincipal | null>(null);
  readonly currentUser = this.#currentUser.asReadonly();
  readonly isAuthenticated = computed(() => this.#currentUser() !== null);

  async loadCurrentUser(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.#http.get<UserEnvelope>('/api/v1/auth/me', { withCredentials: true }),
      );
      this.#currentUser.set(res.data.user);
    } catch {
      this.#currentUser.set(null);
    }
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.#http.post('/api/v1/auth/logout', {}, { withCredentials: true }));
    this.#currentUser.set(null);
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
    this.#currentUser.set(finishRes.data.user);
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
    const useImmediate = await supportsImmediateMediation();
    const assertion = await navigator.credentials.get({
      publicKey: requestOptions,
      ...(useImmediate ? { mediation: 'immediate' as CredentialMediationRequirement } : {}),
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
    this.#currentUser.set(res.data.user);
  }
}
