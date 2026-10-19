declare module "claude-code" {
  interface PluginState {
    "session-picker": {
      picker: {
        groups: {
          open: { id: string; title: string; mtimeMs: number }[];
          paused: { id: string; title: string; mtimeMs: number }[];
          closed: { id: string; title: string; mtimeMs: number }[];
        };
        error: string;
        actionError: string;
        loadedAt: number;
      };
      sessionGroup: "open" | "paused" | "closed";
      tab: "session" | "tool" | "mcp" | "flow" | "memory";
      tools: {
        tools: { name: string; description: string; mcp: boolean }[];
        error: string;
      };
      mcp: {
        servers: { name: string; connected: boolean; tools: number }[];
        pending: string[];
        error: string;
        actionError: string;
        notice: string;
      };
      memory: {
        files: { type: string; path: string; tokens: number }[];
        hasAutoMem: boolean;
        folder: string[];
        folderMore: number;
        folderError: string;
        error: string;
        viewing: { path: string; lines: string[]; omitted: number } | null;
        status: string;
        statusIsError: boolean;
      };
      plan: {
        files: { name: string; mtimeMs: number }[];
        selected: string;
        nodes: {
          id: string;
          name: string;
          agent: string;
          status: "done" | "problem" | "todo";
          skipped: boolean;
        }[];
        error: string;
      };
      copyBar: boolean;
      copyStatus: { key: string; text: string; isError: boolean };
      activity: {
        events: {
          id: string;
          kind: "tool" | "agent";
          turn: number;
          name: string;
          target: string;
          agentId?: string;
          parentAgentId?: string;
          model: string;
          startedAt: number;
          durationMs?: number;
          ok?: boolean;
        }[];
        turn: number;
        tools: number;
        mcp: number;
        agents: number;
      };
    };
  }
}
