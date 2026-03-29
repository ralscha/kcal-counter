import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { SyncService } from '../../core/services/sync.service';
import { KcalTemplateItem, KcalTemplateKind } from '../../core/models/kcal.model';
import { normalizeTemplateKcalAmount } from '../../core/services/sync-push.util';
import { generateUuid } from '../../shared/utils/uuid';
import { TemplatesDeleteModalComponent } from './components/templates-delete-modal';
import { TemplatesFormComponent } from './components/templates-form';
import { TemplatesKindTabsComponent } from './components/templates-kind-tabs';
import { TemplatesListComponent } from './components/templates-list';

@Component({
  selector: 'app-templates',
  imports: [
    ReactiveFormsModule,
    TemplatesKindTabsComponent,
    TemplatesFormComponent,
    TemplatesListComponent,
    TemplatesDeleteModalComponent,
  ],
  templateUrl: './templates.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesComponent {
  readonly #destroyRef = inject(DestroyRef);
  readonly #fb = inject(FormBuilder);
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);
  readonly #sync = inject(SyncService);

  readonly kind = input<string>('food');

  protected activeKind = signal<KcalTemplateKind>('food');
  protected showForm = signal(false);
  protected editingItem = signal<KcalTemplateItem | null>(null);
  protected pendingDeleteItem = signal<KcalTemplateItem | null>(null);
  protected formError = signal('');
  protected formLoading = signal(false);
  readonly #reviewTemplateId = signal<string | null>(null);
  readonly #handledReviewTemplateId = signal<string | null>(null);

  protected form = this.#fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(100)]],
    amount: ['100', Validators.required],
    unit: ['g', Validators.required],
    kcal_amount: [100, [Validators.required, Validators.min(1)]],
  });

  protected readonly items = computed(() =>
    this.#sync.templates().filter((t) => t.kind === this.activeKind()),
  );

  constructor() {
    this.#route.queryParamMap.pipe(takeUntilDestroyed(this.#destroyRef)).subscribe((params) => {
      this.#reviewTemplateId.set(params.get('review_template'));
    });

    effect(() => {
      this.activeKind.set(this.normalizeKind(this.kind()));
      this.cancelForm();
      this.cancelDelete();
      this.formError.set('');
    });

    effect(() => {
      const reviewTemplateId = this.#reviewTemplateId();
      if (!reviewTemplateId || this.#handledReviewTemplateId() === reviewTemplateId) {
        return;
      }

      const item = this.#sync.templates().find((template) => template.id === reviewTemplateId);
      if (!item) {
        return;
      }

      this.#handledReviewTemplateId.set(reviewTemplateId);
      this.activeKind.set(item.kind);
      this.openEdit(item);
      void this.#router.navigate([], {
        relativeTo: this.#route,
        queryParams: { review_template: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    });
  }

  protected setKind(kind: KcalTemplateKind): void {
    if (this.activeKind() === kind) {
      return;
    }

    this.activeKind.set(kind);
    this.cancelForm();
    void this.#router.navigate(kind === 'food' ? ['/templates'] : ['/templates', kind]);
  }

  protected openAdd(): void {
    this.editingItem.set(null);
    this.form.reset({ name: '', amount: '100', unit: 'g', kcal_amount: 100 });
    this.formError.set('');
    this.showForm.set(true);
  }

  protected openEdit(item: KcalTemplateItem): void {
    this.editingItem.set(item);
    this.form.reset({
      name: item.name,
      amount: item.amount,
      unit: item.unit,
      kcal_amount: item.kcal_amount,
    });
    this.formError.set('');
    this.showForm.set(true);
  }

  protected cancelForm(): void {
    this.showForm.set(false);
    this.editingItem.set(null);
  }

  protected requestDelete(item: KcalTemplateItem): void {
    this.pendingDeleteItem.set(item);
  }

  protected cancelDelete(): void {
    this.pendingDeleteItem.set(null);
  }

  protected async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.formLoading.set(true);
    this.formError.set('');
    try {
      const { name, amount, unit, kcal_amount } = this.form.getRawValue();
      const editing = this.editingItem();
      const item: KcalTemplateItem = {
        id: editing?.id ?? generateUuid(),
        kind: this.activeKind(),
        name,
        amount: String(amount).trim(),
        unit,
        kcal_amount: normalizeTemplateKcalAmount(kcal_amount),
      };
      this.#sync.upsertTemplate(item);
      this.showForm.set(false);
      this.editingItem.set(null);
    } catch (e) {
      if (e instanceof HttpErrorResponse) {
        const body = e.error as { error?: { message?: string } };
        this.formError.set(body?.error?.message ?? 'Failed to save.');
      } else {
        this.formError.set('Failed to save.');
      }
    } finally {
      this.formLoading.set(false);
    }
  }

  protected confirmDelete(): void {
    const item = this.pendingDeleteItem();
    if (!item) {
      return;
    }

    this.#sync.deleteTemplate(item.id);
    this.pendingDeleteItem.set(null);
  }

  private normalizeKind(kind: string | null | undefined): KcalTemplateKind {
    return kind === 'activity' ? 'activity' : 'food';
  }
}
