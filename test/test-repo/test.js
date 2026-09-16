// The fixture's verify command, and deliberately a no-op.
//
// `verify` is one list for the whole repo, and each task works on a branch cut
// from main carrying only its own change — so a check for one task's outcome
// fails on every other task's branch. What each task actually produced is
// asserted by test/e2e/happy-path.test.ts, off the PR branch.
console.log('ok');
