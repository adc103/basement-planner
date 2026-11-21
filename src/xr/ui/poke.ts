import { PokeInteractable, type Entity } from '@iwsdk/core';

/**
 * Buttons accept poking with a finger, but only while hands are tracked.
 * With controllers, a controller near the menu would otherwise switch from the
 * ray to poke and the ray vanishes, forcing a full arm stretch to use the menu.
 */
const buttons = new Set<Entity>();
let enabled = true;

export function registerPokeButton(e: Entity): void {
  buttons.add(e);
  if (enabled) e.addComponent(PokeInteractable);
}

export function setPokeEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  for (const e of buttons) {
    if (!e.active) {
      buttons.delete(e);
      continue;
    }
    if (on && !e.hasComponent(PokeInteractable)) e.addComponent(PokeInteractable);
    else if (!on && e.hasComponent(PokeInteractable)) e.removeComponent(PokeInteractable);
  }
}
