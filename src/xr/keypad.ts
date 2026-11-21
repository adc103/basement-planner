import type { Entity, World } from '@iwsdk/core';
import { formatLength, parseLength } from '../core/units.js';
import { ButtonPanel, type ButtonSpec } from './panel.js';

/**
 * Poke-able feet/inches keypad. A bare number means inches; use ' for feet,
 * e.g. 10'4 1/2. The title shows how the entry will be read.
 */
export class Keypad {
  readonly panel: ButtonPanel;
  private entry = '';
  private title = '';
  private onOk: ((inches: number) => void) | null = null;

  constructor(world: World, parent?: Entity) {
    const key = (k: string, label = k): ButtonSpec => ({ id: `k${label}`, label, onClick: () => this.type(k) });
    this.panel = new ButtonPanel(
      world,
      {
        title: ' ',
        columns: 4,
        columnWidth: 0.05,
        buttonHeight: 0.04,
        rows: [
          [key('7'), key('8'), key('9'), key("'", "ft '")],
          [key('4'), key('5'), key('6'), key('"', 'in "')],
          [key('1'), key('2'), key('3'), key('/')],
          [key('0'), key(' ', 'space'), { id: 'kback', label: 'Del', onClick: () => this.back() }, { id: 'kclr', label: 'Clear', onClick: () => this.set('') }],
          [
            { id: 'kcancel', label: 'Cancel', span: 2, tone: 'danger', onClick: () => this.close() },
            { id: 'kok', label: 'OK', span: 2, tone: 'primary', onClick: () => this.ok(), enabled: () => parseLength(this.entry) !== null },
          ],
        ],
      },
      parent,
    );
    this.panel.setVisible(false);
  }

  get open(): boolean {
    return this.panel.visible;
  }

  show(title: string, initial: number | null, onOk: (inches: number) => void): void {
    this.title = title;
    this.onOk = onOk;
    this.set(initial !== null ? formatLength(initial, 8).replace(/"$/, '') : '');
    this.panel.setVisible(true);
  }

  close(): void {
    this.onOk = null;
    this.panel.setVisible(false);
  }

  private type(k: string): void {
    if (this.entry.length > 18) return;
    this.set(this.entry + k);
  }

  private back(): void {
    this.set(this.entry.slice(0, -1));
  }

  private set(text: string): void {
    this.entry = text;
    const v = parseLength(text);
    const shown = text.trim() ? text : '_';
    this.panel.setTitle(`${this.title}: ${shown}${v !== null ? `  =  ${formatLength(v)}` : text.trim() ? '  (?)' : ''}`);
    this.panel.refresh();
  }

  private ok(): void {
    const v = parseLength(this.entry);
    if (v === null || v <= 0) return;
    const cb = this.onOk;
    this.close();
    cb?.(v);
  }
}
