import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { ThemeService } from '../../../core/services/theme.service';

@Component({
  selector: 'app-theme-toggle',
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './theme-toggle.html',
})
export class ThemeToggleComponent {
  protected readonly themeService = inject(ThemeService);
}
