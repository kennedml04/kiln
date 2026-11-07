// storyWhy: the one line of why a Story gives its Tickets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storyWhy } from '@kiln/widget-sdk';

test('storyWhy is the first sentence', () => {
  assert.equal(storyWhy('The person steers by Story. Tickets are a checklist.'), 'The person steers by Story.');
  assert.equal(storyWhy('No full stop here'), 'No full stop here');
  assert.equal(storyWhy('Is it v1.2 yet? Not yet.'), 'Is it v1.2 yet?');
});

test('storyWhy joins wrapped lines and gives nothing for an empty description', () => {
  assert.equal(storyWhy('One line\nwrapped over two. Next.'), 'One line wrapped over two.');
  assert.equal(storyWhy(undefined), undefined);
  assert.equal(storyWhy('  \n '), undefined);
});

test('storyWhy cuts at 140 characters with an ellipsis', () => {
  const long = `${'word '.repeat(60)}end.`;
  const why = storyWhy(long)!;
  assert.equal(why.length, 140);
  assert.ok(why.endsWith('…'));
  const exact = 'x'.repeat(139) + '.';
  assert.equal(storyWhy(exact), exact);
});
