#!/usr/bin/env node
/** Entry point for the `StopFailure` hook (step 19). See `runHookEntry`. */
import { runHookEntry } from '../hooks/entry.js';
import { runStopFailureHook } from '../hooks/stop-failure.js';

await runHookEntry(runStopFailureHook);
