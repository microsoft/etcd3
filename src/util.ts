
/**
 * Returns items with the smallest value as picked by the `prop` function.
 */
export function minBy<T>(items: T[], prop: (x: T) => number): T[] {
  let min = prop(items[0]);
  let output = [items[0]];
  for (let i = 1; i < items.length; i += 1) {
    const thisMin = prop(items[i]);
    if (thisMin < min) {
      min = thisMin;
      output = [items[i]];
    } else if (thisMin === min) {
      output.push(items[i]);
    }
  }

  return output;
}

/**
 * Returns a random element from the list of items.
 */
export function sample<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Returns a promise that resolves after a certain amount of time.
 */
export function delay(duration: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(() => resolve(), duration));
}
