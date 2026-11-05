/**
 * Capitalizes the first letter of each word: `titleCase('hello world')` is `'Hello World'`.
 * @param {string} text
 * @returns {string}
 */
export function titleCase(text) {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
