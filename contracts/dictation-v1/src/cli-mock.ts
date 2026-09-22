import { startMockDictateServer } from './mock-server.js';

const server = await startMockDictateServer({ transcript: 'the transcribed text' });
console.log(`MOCK_URL=${server.url}`);

process.on('SIGTERM', () => {
  void server.close().then(() => process.exit(0));
});

await new Promise<never>(() => {});
