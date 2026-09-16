/**
 * Stands in for a title that slugs to nothing at all. A branch of `<issue>-` is
 * a legal ref and the issue number keeps it unique, so nothing breaks — it just
 * reads as a mistake in every branch list, worktree path and log filename it
 * appears in.
 */
const EMPTY_SLUG_FALLBACK = 'task';

/** Lowercase, hyphen-joined, safe for a branch name or a directory name. */
export function slugify(input: string, max = 50): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // A title carrying no ASCII alphanumerics — CJK, emoji, punctuation alone.
  if (slug === '') {
    return EMPTY_SLUG_FALLBACK;
  }

  if (slug.length > max) {
    return slug.slice(0, max).replace(/-+$/g, '');
  }

  return slug;
}
