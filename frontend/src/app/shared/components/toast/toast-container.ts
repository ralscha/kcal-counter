import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService, type ToastMessage } from '../../../core/services/toast.service';

@Component({
  selector: 'app-toast-container',
  standalone: true,
  templateUrl: './toast-container.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastContainerComponent {
  protected readonly toastService = inject(ToastService);

  protected readonly alertClassByKind: Record<ToastMessage['kind'], string> = {
    success: 'alert-success',
    error: 'alert-error',
    info: 'alert-info',
    warning: 'alert-warning',
  };

  protected dismiss(id: number): void {
    this.toastService.dismiss(id);
  }
}
