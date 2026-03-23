import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { KcalTemplateItem, KcalEntry } from '../models/kcal.model';

interface TemplatesResponse {
  data: { templates: KcalTemplateItem[] };
}

interface EntriesResponse {
  data: { entries: KcalEntry[] };
}

interface TotalResponse {
  data: { total_kcal: number };
}

@Injectable({ providedIn: 'root' })
export class KcalService {
  readonly #http = inject(HttpClient);

  async getTemplates(kind: 'food' | 'activity'): Promise<KcalTemplateItem[]> {
    const res = await firstValueFrom(
      this.#http.get<TemplatesResponse>(`/api/v1/kcal/templates/${kind}`, {
        withCredentials: true,
      }),
    );
    return res.data.templates;
  }

  async getEntries(from: string, to: string): Promise<KcalEntry[]> {
    const res = await firstValueFrom(
      this.#http.get<EntriesResponse>('/api/v1/kcal/entries', {
        params: { from, to },
        withCredentials: true,
      }),
    );
    return res.data.entries;
  }

  async getTotal(from: string, to: string): Promise<number> {
    const res = await firstValueFrom(
      this.#http.get<TotalResponse>('/api/v1/kcal/total', {
        params: { from, to },
        withCredentials: true,
      }),
    );
    return res.data.total_kcal;
  }
}
