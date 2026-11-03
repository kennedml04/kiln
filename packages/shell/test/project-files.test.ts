// The Project view follows the Project's `.kiln` files: its Workflow's columns, live, and their errors.
import { test } from 'node:test';
import type { Page } from 'playwright';
import type { Project, Workflow } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { writeRepoFile } from '@kiln/testing/scratch';

const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

const BUGS: Workflow = {
  name: 'bugs',
  kinds: [
    {
      id: 'bug',
      name: 'Bug',
      stages: [
        { id: 'fix', name: 'Fix', role: 'fixer', agent: 'fake', model: 'fake-small', worktree: true, exit: ['branch_has_commits'], gate: true },
        { id: 'closed', name: 'Closed' },
      ],
    },
  ],
};

function commitWorkflow(kiln: TestKiln, workflow: unknown) {
  writeRepoFile(kiln.repo, '.kiln/workflow.json', `${JSON.stringify(workflow, null, 2)}\n`);
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Kiln Workflow');
}

test('editing the Workflow file updates the Project view live, and an invalid one shows its errors', async (t) => {
  const kiln = await startTestKiln(t);
  commitWorkflow(kiln, BUGS);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  await kiln.api('POST', `/api/projects/${project.id}/items`, { kind: 'bug', title: 'Crash on save' });
  const page = await openShell(t, kiln, `/projects/${project.id}`);

  await column(page, 'Bug Fix').getByRole('article', { name: 'Crash on save' }).waitFor();
  await column(page, 'Bug Closed').waitFor();

  // A new Stage between Fix and Closed shows as a column without a reload.
  const withVerify = structuredClone(BUGS);
  withVerify.kinds[0]!.stages.splice(1, 0, { id: 'verify', name: 'Verify' });
  commitWorkflow(kiln, withVerify);
  await column(page, 'Bug Verify').waitFor();

  // A broken file: the board keeps the last valid Workflow and says what is wrong, and where.
  const broken = structuredClone(withVerify);
  delete broken.kinds[0]!.stages[0]!.model;
  commitWorkflow(kiln, broken);
  const alert = page.getByRole('alert').filter({ hasText: 'kinds[0].stages[0].model' });
  await alert.getByText('.kiln/workflow.json').waitFor();
  await alert.getByText('Bug > Fix runs a Session, so it must name its model').waitFor();
  await column(page, 'Bug Verify').waitFor();

  // Fixed again: the errors go.
  commitWorkflow(kiln, withVerify);
  await alert.waitFor({ state: 'detached' });
});
