import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Choices made in AI Chat's provider menus (privacy floor, sort order, ...) persist across sessions and restarts
// in ~/<provider dir>/settings.json. The value "default" means "no choice": the environment variable or built-in default applies.
export class SettingsStore {
  constructor(provider) {
    this.file = path.join(os.homedir(), provider.credentialsDir, 'settings.json');
    this.menus = provider.settings ?? [];
    try { this.values = JSON.parse(fs.readFileSync(this.file, 'utf8')).values ?? {}; } catch { this.values = {}; }
  }

  get(id) {
    const menu = this.menus.find((m) => m.id === id);
    const v = this.values[id];
    return menu?.options.some((o) => o.value === v) ? v : 'default';
  }

  /** Returns false for an id or value the provider doesn't define. */
  set(id, value) {
    const menu = this.menus.find((m) => m.id === id);
    if (!menu || !menu.options.some((o) => o.value === value)) return false;
    this.values[id] = value;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ values: this.values }, null, 2));
    } catch { /* keep the in-memory choice even if the disk write fails */ }
    return true;
  }

  /** Only the menus the user actually chose a value for: { id: value }. */
  resolved() {
    const out = {};
    for (const m of this.menus) {
      const v = this.get(m.id);
      if (v !== 'default') out[m.id] = v;
    }
    return out;
  }
}
