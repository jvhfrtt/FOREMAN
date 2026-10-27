/** Host half of the Foreman bundle; the board itself is the Client module. */
import { Foreman } from './src/host/foreman.mjs';

export const inject = ['tools', 'commands', 'systemPrompt', 'webServer', 'subprocess', 'agents'];

export function apply(ctx, config) {
  const foreman = new Foreman(ctx, config || {});
  ctx.effect(() => foreman.register(), 'foreman: registration');
  void foreman.bootstrap();
}
