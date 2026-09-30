/**
 * Player names for the global board: shared by the page (to check as you type) and the server (which is the
 * one that decides). Short, printable, no links, and a small list of words that will not be shown.
 */
export const NAME_MAX = 16;
export const NAME_MIN = 2;

// Substrings refused anywhere, and words refused on their own (so "Hancock" and "Dickens" stay fine).
const ANYWHERE = ['fuck', 'cunt', 'nigg', 'fagg', 'hitler', 'whore', 'fitte', 'neger', 'kkk'];
const WORDS = ['shit', 'dick', 'cock', 'pussy', 'slut', 'rape', 'nazi', 'kuk', 'hore', 'faen', 'fag', 'admin', 'moderator'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

/** The cleaned name, or null with nothing to show. `{ name, error }` explains a refusal. */
export function checkName(input) {
  if (typeof input !== 'string') return { name: null, error: 'Type a name' };
  const name = input
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, '') // control, format (zero-width, bidi), private use, unassigned
    .replace(/\s+/gu, ' ')
    .trim();
  const length = [...name].length;
  if (length < NAME_MIN) return { name: null, error: `At least ${NAME_MIN} characters` };
  if (length > NAME_MAX) return { name: null, error: `At most ${NAME_MAX} characters` };
  if (!/^[\p{L}\p{M}\p{N} ._'-]+$/u.test(name)) return { name: null, error: 'Letters, numbers, spaces and . _ - only' };
  if (!/[\p{L}\p{N}]/u.test(name)) return { name: null, error: 'Needs a letter or a number' };
  if (/(^|[^\p{L}])(www|https?)([^\p{L}]|$)|\.(com|net|org|no|io|xyz|ru|se|dk|app|gg|me|co)\b/iu.test(name)) {
    return { name: null, error: 'No links' };
  }
  const plain = name.toLowerCase().replace(/[013457@$]/g, (c) => LEET[c]);
  const squashed = plain.replace(/[^\p{L}]/gu, '');
  if (ANYWHERE.some((w) => squashed.includes(w))) return { name: null, error: 'Pick another name' };
  const words = plain.split(/[^\p{L}]+/u);
  if (words.some((w) => WORDS.includes(w)) || WORDS.includes(squashed)) return { name: null, error: 'Pick another name' };
  return { name, error: null };
}
