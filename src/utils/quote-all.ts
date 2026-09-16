/**
 * A list of names as `"a", "b"`. Quoted rather than bare so a message naming
 * several of them stays readable when one carries a space.
 */
export function quoteAll(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(', ');
}
