#!/usr/bin/env node

import { CodexDoctor } from './providers/codex/CodexDoctor.js';
import { AgentHubHttpServer } from './api/index.js';
import { createLocalAgentHubApplication } from './application/index.js';

const command = process.argv[2];

if (command === 'doctor') {
  const doctor = new CodexDoctor();
  const report = await doctor.runFull();
  console.log(doctor.format(report));
  if (!report.ok) process.exitCode = 1;
} else if (command === 'serve') {
  const host = option('--host') ?? '127.0.0.1';
  const port = Number(option('--port') ?? '3210');
  const owned = await createLocalAgentHubApplication();
  const server = new AgentHubHttpServer({ application: owned.application, host, port });
  try {
    const address = await server.start();
    console.log(`AgentHub API listening on http://${address.host}:${String(address.port)}`);
    await new Promise<void>((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } finally { await server.stop(); await owned.close(); }
} else {
  console.log('Usage: agenthub doctor | agenthub serve [--host 127.0.0.1] [--port 3210]');
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
}
