import { AppConfig } from './config/AppConfig';
import { createApplication } from './container';

const config = AppConfig.getInstance();
const app = await createApplication(config);
app.startBackgroundJobs();

const server = app.http.listen(config.settings.port, config.settings.host, () => {
  const { port, host, dataDir, appNodeCount, replicaLagMs } = config.settings;
  console.log(`
  Mini UPI Wallet is running

    App        http://localhost:${port}
    API        http://localhost:${port}/api/v1
    Health     http://localhost:${port}/health

    Data       ${dataDir === ':memory:' ? 'in memory' : `${dataDir}/primary.db (primary), ${dataDir}/replica.db (read replica, ${replicaLagMs} ms behind)`}
    App nodes  ${appNodeCount} behind a round-robin load balancer
    Demo PIN   1234 for every seeded user
    Listening  on ${host} only${host === '127.0.0.1' ? ' (set HOST=0.0.0.0 to share on your network)' : ''}
`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${config.settings.port} is already in use. Start with another one: PORT=3001 npm start`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      app.shutdown();
      process.exit(0);
    });
  });
}
