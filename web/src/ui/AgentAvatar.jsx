import { agentInfo } from '../lib/agents.js';

// size: 'sm' | 'md'
export function AgentAvatar({ agentId, size = 'md' }) {
  const { label, Icon, classes } = agentInfo(agentId);
  const dim = size === 'sm' ? 'h-6 w-6' : 'h-8 w-8';
  const px = size === 'sm' ? 12 : 16;
  return (
    <span
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${dim} ${classes.bg} ${classes.text}`}
    >
      <Icon size={px} aria-hidden="true" />
    </span>
  );
}
