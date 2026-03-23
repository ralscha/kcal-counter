import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { SyncService } from '../../../core/services/sync.service';
import { ToastService } from '../../../core/services/toast.service';
import { toastErrorMessage } from '../../../shared/utils/toast-error';

@Component({
  selector: 'app-login',
  imports: [RouterLink],
  templateUrl: './login.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  readonly #auth = inject(AuthService);
  readonly #sync = inject(SyncService);
  readonly #router = inject(Router);
  readonly #toast = inject(ToastService);

  protected readonly error = signal('');
  protected readonly passkeyLoading = signal(false);

  protected async signInWithPasskey(): Promise<void> {
    this.passkeyLoading.set(true);
    this.error.set('');
    try {
      await this.#auth.loginWithPasskey();
      await this.#sync.pull();
      this.#toast.success('You are signed in with your passkey.', { title: 'Signed in' });
      await this.#router.navigate(['/dashboard']);
    } catch (error) {
      this.error.set(
        toastErrorMessage(this.#toast, error, {
          fallback: 'Passkey sign-in failed or was cancelled.',
          title: 'Passkey sign-in failed',
          notAllowedMessage: 'No passkey was available on this device for this account.',
        }),
      );
    } finally {
      this.passkeyLoading.set(false);
    }
  }
}
