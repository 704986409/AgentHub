#!/usr/bin/env node

import { CodexDoctor } from './providers/codex/CodexDoctor.js';

const command = process.argv[2];

if (command === 'doctor') {
  console.log(new CodexDoctor().format());
} else {
  console.log('Usage: agenthub doctor');
}
