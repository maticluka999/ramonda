#!/usr/bin/env node
/** Entry point for the `Stop` hook (step 18). See `runHookEntry`. */
import { runHookEntry } from '../hooks/entry.js';
import { runStopHook } from '../hooks/stop.js';

await runHookEntry(runStopHook);
