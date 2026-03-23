import { Injectable, inject, signal } from '@angular/core';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { ToastService } from './toast.service';

@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  readonly #swUpdate = inject(SwUpdate);
  readonly #toastService = inject(ToastService);
  readonly #updateAvailable = signal(false);
  readonly #isActivating = signal(false);

  readonly updateAvailable = this.#updateAvailable.asReadonly();
  readonly isActivating = this.#isActivating.asReadonly();

  constructor() {
    if (!this.#swUpdate.isEnabled) {
      return;
    }

    this.#swUpdate.versionUpdates.subscribe((event) => {
      this.#handleVersionEvent(event);
    });
  }

  async activateUpdate(): Promise<void> {
    if (!this.#swUpdate.isEnabled || this.#isActivating()) {
      return;
    }

    this.#isActivating.set(true);

    try {
      await this.#swUpdate.activateUpdate();
      document.location.reload();
    } catch {
      this.#isActivating.set(false);
      this.#toastService.error(
        'Could not apply the latest version. Refresh the page and try again.',
        {
          title: 'Update failed',
        },
      );
    }
  }

  #handleVersionEvent(event: VersionEvent): void {
    switch (event.type) {
      case 'VERSION_DETECTED':
        console.info(`Downloading new app version: ${event.version.hash}`);
        break;
      case 'VERSION_READY':
        console.info(`Current app version: ${event.currentVersion.hash}`);
        console.info(`New app version ready for use: ${event.latestVersion.hash}`);
        this.#updateAvailable.set(true);
        break;
      case 'VERSION_INSTALLATION_FAILED':
        console.error(`Failed to install app version '${event.version.hash}': ${event.error}`);
        this.#toastService.error('A new version could not be installed automatically.', {
          title: 'Update failed',
        });
        break;
      case 'NO_NEW_VERSION_DETECTED':
        console.info('No new app version detected');
        break;
    }
  }
}
