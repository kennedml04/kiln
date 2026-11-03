// The Project Thread (ticket 13): a person talks about the whole Project with a Project Thread
// Session. It reads across the Project but changes nothing; what it proposes lands in Needs you.
import { useEffect, useState } from 'react';
import { projectThreadId, type ThreadEntry } from '@kiln/widget-sdk';
import { followLink, projectPath } from '../router.ts';
import { addThreadEntries, api, useStore } from '../store.ts';
import { MessageForm, ThreadLog } from './ItemView.tsx';

const NO_ENTRIES: ThreadEntry[] = [];

export function ProjectThreadView({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId]);
  const threadId = projectThreadId(projectId);
  const thread = useStore((s) => s.threads[threadId] ?? NO_ENTRIES);
  const [error, setError] = useState<string>();
  const base = `/api/projects/${encodeURIComponent(projectId)}`;

  useEffect(() => {
    let live = true;
    api<ThreadEntry[]>('GET', `${base}/thread`)
      .then((entries) => live && addThreadEntries(threadId, entries))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [base, threadId]);

  if (!project) return <p>Loading Project…</p>;
  return (
    <article className="item-view project-thread">
      <h2>{project.name} Project Thread</h2>
      <a href={projectPath(project.id)} onClick={followLink}>
        {project.name}
      </a>
      <p>
        Talk about the whole Project here. Its Sessions read every Item but change nothing: what they propose waits for you
        in Needs you.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <section className="thread">
        <h3>Thread</h3>
        <ThreadLog thread={thread} project={project} />
        <MessageForm messagesPath={`${base}/messages`} />
      </section>
    </article>
  );
}
