import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SwUpdatePromptComponent } from './shared/components/sw-update-prompt/sw-update-prompt';
import { ToastContainerComponent } from './shared/components/toast/toast-container';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SwUpdatePromptComponent, ToastContainerComponent],
  template:
    '<router-outlet></router-outlet><app-sw-update-prompt></app-sw-update-prompt><app-toast-container></app-toast-container>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
