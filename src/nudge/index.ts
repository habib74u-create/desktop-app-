// Example: how you'd write a real agent
import type { Agent } from '../core/agent-manager';

export const nudgeAgent: Agent = {
  name: 'nudge',
  description: 'Emits contextual nudges based on frontmost app',
  init(ctx) {
    ctx.log.info('nudge agent ready');
    ctx.core.on('state:changed', ({ to }) => {
      if (to === 'idle') {
        ctx.nudge('idle-tip', { tip: 'Try push-to-talk with Fn' });
      }
    });
  },
  dispose() {
    // remove listeners here if you added any with .off()
  },
};
