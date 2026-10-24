// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { provideRouter } from '@angular/router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DashboardSummaryComponent } from './dashboard-summary';

describe('dashboard summary rendering', () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(async () => {
    // Resolve the external template before TestBed inspects the standalone component.
    await TestBed.overrideTemplate(
      DashboardSummaryComponent,
      readFileSync('src/app/features/dashboard/components/dashboard-summary.html', 'utf8'),
    ).compileComponents();
    TestBed.configureTestingModule({
      imports: [DashboardSummaryComponent],
      providers: [provideRouter([])],
    });
  });

  afterEach(() => TestBed.resetTestingModule());
  afterAll(() => TestBed.resetTestEnvironment());

  function renderSummary(daily: number | null, cycle: number | null) {
    const fixture = TestBed.createComponent(DashboardSummaryComponent);
    const dailyDifference = signal(daily);
    const cycleDifference = signal(cycle);
    // Standalone Vitest uses JIT, so provide signal inputs without the AOT input transform.
    Object.assign(fixture.componentInstance, {
      selectedDateLabel: signal('Thursday, October 22'),
      totalKcal: signal(2000),
      dailyLimitDifference: dailyDifference,
      cycleDifference,
    });
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    return { fixture, element, dailyDifference, cycleDifference };
  }

  it('shows both zero differences with neutral styling', () => {
    const { element } = renderSummary(0, 0);
    const differences = element.querySelectorAll('.rounded-full');

    expect(Array.from(differences, (item) => item.textContent.trim())).toEqual([
      '0 kcal',
      '0 kcal',
    ]);
    expect(Array.from(differences, (item) => item.classList.contains('bg-base-300'))).toEqual([
      true,
      true,
    ]);
    expect(element.textContent).toContain('Difference to daily limit');
  });

  it('hides differences when no limit is configured', () => {
    const { element } = renderSummary(null, null);

    expect(element.querySelectorAll('.rounded-full')).toHaveLength(0);
    expect(element.textContent).not.toContain('Difference to daily limit');
    expect(element.textContent).toContain('+2000 kcal');
  });

  it('preserves signs and colors for nonzero differences', () => {
    const { element } = renderSummary(-100, 200);

    expect(element.querySelector('.bg-success')?.textContent.trim()).toBe('-100 kcal');
    expect(element.querySelector('.bg-error')?.textContent.trim()).toBe('+200 kcal');
  });

  it('keeps the differences visible when they change to zero', () => {
    const { fixture, element, dailyDifference, cycleDifference } = renderSummary(-100, 200);
    dailyDifference.set(0);
    cycleDifference.set(0);
    fixture.detectChanges();

    expect(
      Array.from(element.querySelectorAll('.rounded-full'), (item) => item.textContent.trim()),
    ).toEqual(['0 kcal', '0 kcal']);

    dailyDifference.set(null);
    fixture.detectChanges();
    expect(element.querySelectorAll('.rounded-full')).toHaveLength(1);
    expect(element.textContent).not.toContain('Difference to daily limit');
  });
});
