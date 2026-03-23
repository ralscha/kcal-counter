import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { AuthService } from '../../core/services/auth.service';
import { SyncService } from '../../core/services/sync.service';

interface NavigationItem {
  route: string;
  label: string;
  iconPath: string;
}

@Component({
  selector: 'app-main-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgOptimizedImage],
  templateUrl: './main-layout.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onEscapeKey()',
  },
})
export class MainLayoutComponent implements OnInit {
  protected readonly auth = inject(AuthService);
  protected readonly currentUser = this.auth.currentUser;
  protected readonly sync = inject(SyncService);
  readonly #router = inject(Router);

  protected showMobileNav = signal(false);
  protected readonly navigationItems: NavigationItem[] = [
    {
      route: '/dashboard',
      label: 'Dashboard',
      iconPath:
        'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    },
    {
      route: '/history',
      label: 'History',
      iconPath: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
    },
    {
      route: '/templates',
      label: 'Lists',
      iconPath: 'M4 6h16M4 12h16M4 18h10',
    },
    {
      route: '/profile',
      label: 'Profile',
      iconPath:
        'M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    },
  ];

  ngOnInit(): void {
    this.#router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => {
      this.showMobileNav.set(false);
    });
  }

  protected signOut(): void {
    void this.auth.logout();
  }

  protected toggleMobileNav(): void {
    this.showMobileNav.update((isOpen) => !isOpen);
  }

  protected closeMobileNav(): void {
    this.showMobileNav.set(false);
  }

  protected onEscapeKey(): void {
    if (this.showMobileNav()) {
      this.closeMobileNav();
    }
  }
}
