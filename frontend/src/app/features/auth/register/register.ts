import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { SyncService } from '../../../core/services/sync.service';
import { ToastService } from '../../../core/services/toast.service';
import { toastErrorMessage } from '../../../shared/utils/toast-error';

@Component({
  selector: 'app-register',
  imports: [RouterLink],
  templateUrl: './register.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterComponent {
  readonly #auth = inject(AuthService);
  readonly #sync = inject(SyncService);
  readonly #router = inject(Router);
  readonly #toast = inject(ToastService);

  protected readonly error = signal('');
  protected readonly loading = signal(false);

  protected async submit(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      await this.#auth.registerPasskey();
      await this.#sync.pull();
      this.#toast.success('Your passkey is ready to use.', { title: 'Account created' });
      await this.#router.navigate(['/dashboard']);
    } catch (error) {
      this.error.set(
        toastErrorMessage(this.#toast, error, {
          fallback: 'Passkey setup failed or was cancelled.',
          title: 'Registration failed',
        }),
      );
    } finally {
      this.loading.set(false);
    }
  }
}
