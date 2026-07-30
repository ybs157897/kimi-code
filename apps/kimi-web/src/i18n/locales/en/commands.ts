export default {
  new: { desc: 'Create a new session' },
  clear: { desc: 'Clear and start a new session' },
  login: { desc: 'Sign in to Kimi in the browser' },
  plan: { desc: 'Toggle plan mode on/off' },
  swarm: { desc: 'Toggle swarm mode; /swarm <task> runs a task in swarm' },
  experts: {
    desc: 'Expert teams: /experts <plugin-id>, /experts off, /experts status',
  },
  goal: { desc: 'Create/control a goal: /goal <objective>, /goal pause|resume|cancel' },
  btw: { desc: 'Side chat: /btw <question> asks a forked side session' },
  yolo: { desc: 'Auto-approve tool actions; the agent may still ask questions' },
  auto: { desc: 'Fully autonomous — the agent never asks questions' },
  thinking: { desc: 'Set the thinking level' },
  compact: { desc: 'Compact the conversation history' },
  reload: { desc: 'Reload code extensions and their commands' },
  fork: { desc: 'Fork this session into a new one' },
  export: {
    desc: 'Download this session and troubleshooting logs as a ZIP',
    noSession: 'Open a session before exporting it.',
  },
  status: { desc: 'View session status' },
  undo: { desc: 'Undo the last message' },
} as const;
