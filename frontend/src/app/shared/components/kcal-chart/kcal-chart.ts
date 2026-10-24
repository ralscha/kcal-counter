import { Component, computed, input } from '@angular/core';

export interface ChartSeries {
  name: string;
  values: (number | null)[];
  color: string;
  dashed?: boolean;
}

@Component({
  selector: 'app-kcal-chart',
  template: `
    <svg viewBox="0 0 720 250" role="img" [attr.aria-label]="label()" class="w-full min-w-64">
      <title>{{ label() }}</title>
      @for (tick of ticks(); track $index) {
        <line
          x1="62"
          x2="704"
          [attr.y1]="tick.y"
          [attr.y2]="tick.y"
          stroke="currentColor"
          opacity="0.12"
        />
        <text x="54" [attr.y]="tick.y + 4" text-anchor="end" fill="currentColor" font-size="12">
          {{ tick.value }}
        </text>
      }
      @if (dates().length) {
        <line
          [attr.x1]="x(selectedIndex())"
          [attr.x2]="x(selectedIndex())"
          y1="16"
          y2="214"
          stroke="currentColor"
          stroke-dasharray="3 4"
          opacity="0.35"
        />
      }
      @for (line of paths(); track line.name) {
        <path
          [attr.d]="line.path"
          fill="none"
          [attr.stroke]="line.color"
          stroke-width="2.5"
          [attr.stroke-dasharray]="line.dashed ? '6 5' : null"
        />
        @if (line.selected !== null) {
          <circle
            [attr.cx]="x(selectedIndex())"
            [attr.cy]="y(line.selected)"
            r="4"
            [attr.fill]="line.color"
          />
        }
      }
      <text x="62" y="240" fill="currentColor" font-size="12">{{ dates()[0] }}</text>
      <text x="704" y="240" text-anchor="end" fill="currentColor" font-size="12">
        {{ dates()[dates().length - 1] }}
      </text>
    </svg>
    <ul class="flex flex-wrap gap-x-5 gap-y-2 text-xs" aria-label="Chart legend">
      @for (line of series(); track line.name) {
        <li class="flex items-center gap-2">
          <span class="inline-block h-1 w-6" [style.background]="line.color"></span>{{ line.name }}
        </li>
      }
    </ul>
  `,
})
export class KcalChartComponent {
  readonly label = input.required<string>();
  readonly dates = input.required<string[]>();
  readonly series = input.required<ChartSeries[]>();
  readonly selectedIndex = input(0);

  protected readonly bounds = computed(() => {
    const values = this.series().flatMap((line) =>
      line.values.filter((value): value is number => value !== null),
    );
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const padding = Math.max((max - min) * 0.08, 1);
    return { min: min - padding, max: max + padding };
  });
  protected readonly ticks = computed(() => {
    const { min, max } = this.bounds();
    return Array.from({ length: 5 }, (_, index) => {
      const value = Math.round(min + ((max - min) * index) / 4);
      return { value, y: this.y(value) };
    });
  });
  protected readonly paths = computed(() =>
    this.series().map((line) => {
      let connected = false;
      let path = '';
      line.values.forEach((value, index) => {
        if (value === null) {
          connected = false;
          return;
        }
        path += `${connected ? 'L' : 'M'}${this.x(index).toFixed(2)},${this.y(value).toFixed(2)} `;
        connected = true;
      });
      return { ...line, path, selected: line.values[this.selectedIndex()] ?? null };
    }),
  );

  protected x(index: number): number {
    return this.dates().length <= 1 ? 383 : 62 + (642 * index) / (this.dates().length - 1);
  }
  protected y(value: number): number {
    const { min, max } = this.bounds();
    return 214 - (198 * (value - min)) / (max - min);
  }
}
