// @vitest-environment jsdom
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SyncService } from '../../core/services/sync.service';
import { LocalDateService } from '../../core/services/local-date.service';
import { TrendsComponent } from './trends';

class TestTrends extends TrendsComponent {
  readonly periodAvailable = this.activeStarted;
  readonly chartRange = this.range;
  readonly currentSelection = this.selectedPeriod;
  readonly viewActive = () => this.viewPeriod('active');
}

describe('period chart selection', () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
  afterEach(() => TestBed.resetTestingModule());
  afterAll(() => TestBed.resetTestEnvironment());

  it('offers an active-period chart only after its start date and clears obsolete selection', () => {
    const preferences = signal({ kcalLimit: 2200, cycleStartDate: '2026-10-25' });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SyncService,
          useValue: { preferences, entries: signal([]), targets: signal([]), periods: signal([]) },
        },
        { provide: LocalDateService, useValue: { today: signal('2026-10-22') } },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new TestTrends());
    component.viewActive();
    TestBed.tick();
    expect(component.periodAvailable()).toBe(false);
    expect(component.currentSelection()).toBeNull();
    preferences.set({ kcalLimit: 2200, cycleStartDate: '2026-10-01' });
    TestBed.tick();
    component.viewActive();
    expect(component.chartRange()).toEqual({
      start: '2026-10-01',
      end: '2026-10-22',
      label: 'Current period',
    });
  });
});
