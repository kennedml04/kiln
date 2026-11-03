import { test } from 'node:test';
import type { Item, Project } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

test('Needs you shows the spec at a Story\'s Spec Gate and its Ticket list at the Tickets Gate', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: {
      griller: [
        { do: 'write', path: '.scratch/home-board/grill.md', content: '# Grill\n\nOne board.\n' },
        { do: 'commit', message: 'Grill record' },
      ],
      'spec-writer': [
        { do: 'write', path: '.scratch/home-board/spec.md', content: '# Spec: Home board\n\nOne board shows every Project.\n' },
        { do: 'commit', message: 'Spec' },
      ],
      'ticket-writer': [{ do: 'kiln_tool', name: 'create_child_item', input: { title: 'Draw the columns', description: 'One column per run state.' } }],
    },
  });
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const story = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'story', title: 'Home board' });
  const page = await openShell(t, kiln, '/needs-you');

  await kiln.api('POST', `/api/items/${encodeURIComponent(story.id)}/start`);
  const spec = page.getByRole('article', { name: /^Approve Home board/ });
  await spec.waitFor({ timeout: 30_000 });
  await spec.getByRole('region', { name: 'Spec' }).getByText(/One board shows every Project/).waitFor();
  await spec.getByRole('radio', { name: 'Approve' }).check();
  await spec.getByRole('button', { name: 'Answer' }).click();
  await spec.waitFor({ state: 'detached' });

  const tickets = page.getByRole('article', { name: /^Approve Home board/ });
  await tickets.getByRole('region', { name: 'Tickets' }).getByText(/Draw the columns: One column per run state/).waitFor({ timeout: 30_000 });
});
