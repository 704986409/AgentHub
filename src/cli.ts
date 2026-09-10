#!/usr/bin/env node

import { CodexDoctor } from './providers/codex/CodexDoctor.js';

const command = process.argv[2];

if (command === 'doctor') {
  const doctor = new CodexDoctor();
  const report = await doctor.runFull();
  console.log(doctor.format(report));
  if (!report.ok) process.exitCode = 1;
} else {
  console.log('Usage: agenthub doctor');
}
