import { AUTH_TOKEN } from './config.mjs';
import { Agent } from './agent.mjs';
import { ChannelHub } from './channels.mjs';
import { Scheduler } from './scheduler.mjs';
import { startServer } from './server.mjs';

export async function boot(port = Number(process.env.NOCTURN_PORT) || 18790, host = process.env.NOCTURN_HOST || '127.0.0.1') {
  const agent = new Agent();
  const channels = new ChannelHub(agent);
  const scheduler = new Scheduler(agent, channels);
  agent.channels = channels;
  agent.scheduler = scheduler;
  const server = await startServer({ agent, channels, scheduler, port, host });
  channels.restart();
  scheduler.start();
  return { agent, channels, scheduler, server, port: server.address().port };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  const { port } = await boot();
  console.log(`\n  Nocturn is running. Open this private link:\n\n  http://127.0.0.1:${port}/panel.html#token=${AUTH_TOKEN}\n`);
}
