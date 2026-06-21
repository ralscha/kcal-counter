import { Component, inject } from '@angular/core';
import { AppUpdateService } from '../../../core/services/app-update.service';

@Component({
  selector: 'app-sw-update-prompt',
  standalone: true,
  templateUrl: './sw-update-prompt.html',
})
export class SwUpdatePromptComponent {
  protected readonly appUpdate = inject(AppUpdateService);
}
