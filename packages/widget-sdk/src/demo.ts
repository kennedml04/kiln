// The demo Project on a dev instance (demo-project spec, "Demo setup (core)").

/** How the demo runs: Replay (the fake Agent, no models) or Live (your Agents and role models). */
export type DemoMode = 'replay' | 'live';

/** `GET /api/demo` and `POST /api/demo/start` (Admin). */
export interface DemoState {
  /** False on a live instance: the demo is only offered on a dev instance. */
  available: boolean;
  /** The mode of the current demo run, once one has started. */
  mode?: DemoMode;
  /** The current demo Project, once one has started. */
  projectId?: string;
}

/** `POST /api/demo/start` body. */
export interface StartDemoRequest {
  mode: DemoMode;
}
