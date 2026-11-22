package formal

import "testing"

type runState string

const (
	stateWaiting       runState = "waiting"
	stateQueued        runState = "queued"
	stateClaimed       runState = "claimed"
	stateRunning       runState = "running"
	stateNeedsApproval runState = "needs_approval"
	stateDone          runState = "done"
	stateFailed        runState = "failed"
	stateCancelled     runState = "cancelled"
)

const (
	numRuns     = 3
	numWorkdirs = 2
)

func isValidState(s runState) bool {
	switch s {
	case stateWaiting, stateQueued, stateClaimed, stateRunning, stateNeedsApproval, stateDone, stateFailed, stateCancelled:
		return true
	default:
		return false
	}
}

func isActive(s runState) bool {
	return s == stateClaimed || s == stateRunning || s == stateNeedsApproval
}

func isTerminal(s runState) bool {
	return s == stateDone || s == stateFailed || s == stateCancelled
}

// sysState mirrors evals/formal/RunLifecycle.tla for 3 run slots (2 initial + 1 spare retry slot)
// and 2 workdirs. Because TLC/Java is absent in this environment, this exhaustive BFS verifies every
// reachable state and transition, Slice 1 invariants, and Slice 2 DAG/schedule/retry invariants.
type sysState struct {
	Exists       [numRuns]bool
	Status       [numRuns]runState
	RunWorkdir   [numRuns]int8  // -1 = unassigned, 0 = w0, 1 = w1
	WorkdirOwner [numWorkdirs]int8 // -1 = none, 0..2 = run index
	Lease        [numRuns]bool
	Expired      [numRuns]bool
	Deps         [numRuns]uint8 // bitmask of upstream run indices
	Scheduled    [numRuns]bool
	RetryOf      [numRuns]int8 // -1 = none, 0..2 = retried run index
}

func (s sysState) depsReady(r int) bool {
	mask := s.Deps[r]
	for d := 0; d < numRuns; d++ {
		if mask&(1<<d) != 0 {
			if !s.Exists[d] || s.Status[d] != stateDone {
				return false
			}
		}
	}
	return true
}

func checkInvariants(t *testing.T, s sysState) {
	t.Helper()

	// TypeInvariant
	for r := 0; r < numRuns; r++ {
		if !isValidState(s.Status[r]) {
			t.Fatalf("TypeInvariant violated: invalid status %q for run%d", s.Status[r], r)
		}
		if s.Deps[r]&(1<<r) != 0 {
			t.Fatalf("TypeInvariant violated: self-dependency on run%d: %+v", r, s)
		}
	}

	// WorkdirMutexInvariant & TerminalReleasesWorkdir
	for w := 0; w < numWorkdirs; w++ {
		owner := s.WorkdirOwner[w]
		if owner != -1 {
			if owner < 0 || owner >= numRuns || !s.Exists[owner] || !isActive(s.Status[owner]) {
				t.Fatalf("TerminalReleasesWorkdir violated: w%d locked by run%d (%+v)", w, owner, s)
			}
		}
		activeOnW := 0
		for r := 0; r < numRuns; r++ {
			if s.Exists[r] && isActive(s.Status[r]) && s.RunWorkdir[r] == int8(w) && s.WorkdirOwner[w] == int8(r) {
				activeOnW++
			}
		}
		if activeOnW > 1 {
			t.Fatalf("WorkdirMutexInvariant violated on w%d: %+v", w, s)
		}
	}

	// NoActiveWithoutLease
	for r := 0; r < numRuns; r++ {
		if s.Exists[r] && isActive(s.Status[r]) && !s.Lease[r] {
			t.Fatalf("NoActiveWithoutLease violated for run%d: %+v", r, s)
		}
	}

	// WaitingNeverHoldsWorkdir
	for r := 0; r < numRuns; r++ {
		if s.Status[r] == stateWaiting {
			if s.Lease[r] {
				t.Fatalf("WaitingNeverHoldsWorkdir violated: waiting run%d holds lease: %+v", r, s)
			}
			for w := 0; w < numWorkdirs; w++ {
				if s.WorkdirOwner[w] == int8(r) {
					t.Fatalf("WaitingNeverHoldsWorkdir violated: waiting run%d locks w%d: %+v", r, w, s)
				}
			}
		}
	}

	// NoClaimBeforeDepsDone
	for r := 0; r < numRuns; r++ {
		if !s.Exists[r] {
			continue
		}
		st := s.Status[r]
		if st == stateQueued || isActive(st) || st == stateDone {
			if s.Scheduled[r] {
				t.Fatalf("NoClaimBeforeDepsDone violated: run%d in %s while scheduled=true: %+v", r, st, s)
			}
			if !s.depsReady(r) {
				t.Fatalf("NoClaimBeforeDepsDone violated: run%d in %s before deps done: %+v", r, st, s)
			}
		}
	}

	// RetryTargetRemainsTerminal
	for r := 0; r < numRuns; r++ {
		if s.Exists[r] && s.RetryOf[r] != -1 {
			target := int(s.RetryOf[r])
			if target == r || target < 0 || target >= numRuns || !s.Exists[target] {
				t.Fatalf("RetryTargetRemainsTerminal violated: invalid retryOf on run%d: %+v", r, s)
			}
			if s.Status[target] != stateFailed && s.Status[target] != stateCancelled {
				t.Fatalf("RetryTargetRemainsTerminal violated: retryOf target run%d is %s: %+v", target, s.Status[target], s)
			}
		}
	}
}

func TestRunLifecycleExhaustiveModelCheck(t *testing.T) {
	visited := make(map[sysState]bool, 8192)
	var queue []sysState

	// Seed initial states isomorphic to RunLifecycle.tla Init:
	// 2 active initial runs + 1 spare slot (exists=false), all acyclic dep graphs, all scheduled booleans.
	const spare = 2
	depConfigs := [][2]uint8{
		{0, 0},      // independent
		{0, 1 << 0}, // run1 depends on run0
		{1 << 1, 0}, // run0 depends on run1
	}
	for _, dc := range depConfigs {
		for s0 := 0; s0 < 2; s0++ {
			for s1 := 0; s1 < 2; s1++ {
				init := sysState{
					Exists:       [numRuns]bool{true, true, false},
					RunWorkdir:   [numRuns]int8{-1, -1, -1},
					WorkdirOwner: [numWorkdirs]int8{-1, -1},
					Deps:         [numRuns]uint8{dc[0], dc[1], 0},
					Scheduled:    [numRuns]bool{s0 == 1, s1 == 1, false},
					RetryOf:      [numRuns]int8{-1, -1, -1},
				}
				init.Status[spare] = stateWaiting
				for r := 0; r < 2; r++ {
					if init.Deps[r] != 0 || init.Scheduled[r] {
						init.Status[r] = stateWaiting
					} else {
						init.Status[r] = stateQueued
					}
				}
				if !visited[init] {
					visited[init] = true
					queue = append(queue, init)
				}
			}
		}
	}

	transitions := 0
	var (
		sawWaiting        int
		sawScheduleDue    int
		sawWakeWaiting    int
		sawCancelWaiting  int
		sawCascadeCancel  int
		sawRetry          int
		sawRetryRebind    int
		sawWakeAfterRetry int
	)

	type step struct {
		state   sysState
		action  string
		rebound bool
		wokeRet bool
	}

	for head := 0; head < len(queue); head++ {
		cur := queue[head]
		checkInvariants(t, cur)

		for r := 0; r < numRuns; r++ {
			if cur.Status[r] == stateWaiting && cur.Exists[r] {
				sawWaiting++
				break
			}
		}

		var nexts []step
		for r := 0; r < numRuns; r++ {
			if !cur.Exists[r] {
				continue
			}
			st := cur.Status[r]
			switch st {
			case stateWaiting:
				// ScheduleDue(r)
				if cur.Scheduled[r] {
					n := cur
					n.Scheduled[r] = false
					nexts = append(nexts, step{state: n, action: "ScheduleDue"})
				}
				// WakeWaiting(r)
				if !cur.Scheduled[r] && cur.depsReady(r) {
					n := cur
					n.Status[r] = stateQueued
					wokeAfterRetry := false
					for d := 0; d < numRuns; d++ {
						if cur.Deps[r]&(1<<d) != 0 && cur.RetryOf[d] != -1 {
							wokeAfterRetry = true
						}
					}
					nexts = append(nexts, step{state: n, action: "WakeWaiting", wokeRet: wokeAfterRetry})
				}
				// CancelWaiting(r)
				nCancel := cur
				nCancel.Status[r] = stateCancelled
				nexts = append(nexts, step{state: nCancel, action: "CancelWaiting"})

			case stateQueued:
				// Claim(r, w)
				for w := 0; w < numWorkdirs; w++ {
					if cur.WorkdirOwner[w] == -1 {
						n := cur
						n.Status[r] = stateClaimed
						n.WorkdirOwner[w] = int8(r)
						n.RunWorkdir[r] = int8(w)
						n.Lease[r] = true
						n.Expired[r] = false
						nexts = append(nexts, step{state: n, action: "Claim"})
					}
				}
				// CancelQueued(r)
				n := cur
				n.Status[r] = stateCancelled
				nexts = append(nexts, step{state: n, action: "CancelQueued"})

			case stateClaimed:
				w := int(cur.RunWorkdir[r])
				nRun := cur
				nRun.Status[r] = stateRunning
				nexts = append(nexts, step{state: nRun, action: "StartExecution"})

				for _, fin := range []runState{stateDone, stateFailed, stateCancelled} {
					nFin := cur
					nFin.Status[r] = fin
					nFin.WorkdirOwner[w] = -1
					nFin.Lease[r] = false
					nexts = append(nexts, step{state: nFin, action: "Complete"})
				}
				// LeaseExpireAndReap(r, w)
				nReap := cur
				nReap.Status[r] = stateFailed
				nReap.WorkdirOwner[w] = -1
				nReap.Lease[r] = false
				nReap.Expired[r] = true
				nexts = append(nexts, step{state: nReap, action: "LeaseExpireAndReap"})

			case stateRunning:
				w := int(cur.RunWorkdir[r])
				nApp := cur
				nApp.Status[r] = stateNeedsApproval
				nexts = append(nexts, step{state: nApp, action: "EnterApproval"})

				for _, fin := range []runState{stateDone, stateFailed, stateCancelled} {
					nFin := cur
					nFin.Status[r] = fin
					nFin.WorkdirOwner[w] = -1
					nFin.Lease[r] = false
					nexts = append(nexts, step{state: nFin, action: "Complete"})
				}
				nReap := cur
				nReap.Status[r] = stateFailed
				nReap.WorkdirOwner[w] = -1
				nReap.Lease[r] = false
				nReap.Expired[r] = true
				nexts = append(nexts, step{state: nReap, action: "LeaseExpireAndReap"})

			case stateNeedsApproval:
				w := int(cur.RunWorkdir[r])
				nRes := cur
				nRes.Status[r] = stateRunning
				nexts = append(nexts, step{state: nRes, action: "ResumeApproval"})

				for _, fin := range []runState{stateDone, stateFailed, stateCancelled} {
					nFin := cur
					nFin.Status[r] = fin
					nFin.WorkdirOwner[w] = -1
					nFin.Lease[r] = false
					nexts = append(nexts, step{state: nFin, action: "Complete"})
				}
				nReap := cur
				nReap.Status[r] = stateFailed
				nReap.WorkdirOwner[w] = -1
				nReap.Lease[r] = false
				nReap.Expired[r] = true
				nexts = append(nexts, step{state: nReap, action: "LeaseExpireAndReap"})
			}

			// CascadeCancel(r) for any non-terminal existing run
			if !isTerminal(st) {
				nCas := cur
				var directMask uint8
				for d := 0; d < numRuns; d++ {
					if cur.Exists[d] && cur.Status[d] == stateWaiting && (cur.Deps[d]&(1<<r)) != 0 {
						directMask |= 1 << d
					}
				}
				var secondMask uint8
				for d := 0; d < numRuns; d++ {
					if cur.Exists[d] && cur.Status[d] == stateWaiting && (cur.Deps[d]&directMask) != 0 {
						secondMask |= 1 << d
					}
				}
				cancelMask := uint8(1<<r) | directMask | secondMask
				for idx := 0; idx < numRuns; idx++ {
					if cancelMask&(1<<idx) != 0 {
						nCas.Status[idx] = stateCancelled
					}
				}
				for w := 0; w < numWorkdirs; w++ {
					if nCas.WorkdirOwner[w] == int8(r) {
						nCas.WorkdirOwner[w] = -1
					}
				}
				nCas.Lease[r] = false
				nexts = append(nexts, step{state: nCas, action: "CascadeCancel"})
			}

			// Retry(rOld=r, rNew)
			if st == stateFailed || st == stateCancelled {
				for rNew := 0; rNew < numRuns; rNew++ {
					if !cur.Exists[rNew] {
						n := cur
						n.Exists[rNew] = true
						n.RetryOf[rNew] = int8(r)
						n.Scheduled[rNew] = cur.Scheduled[r]
						n.Deps[rNew] = cur.Deps[r]
						rebound := false
						for d := 0; d < numRuns; d++ {
							if d != rNew && cur.Exists[d] && cur.Status[d] == stateWaiting && (cur.Deps[d]&(1<<r)) != 0 {
								n.Deps[d] = (cur.Deps[d] &^ uint8(1<<r)) | uint8(1<<rNew)
								rebound = true
							}
						}
						if !cur.depsReady(r) || cur.Scheduled[r] {
							n.Status[rNew] = stateWaiting
						} else {
							n.Status[rNew] = stateQueued
						}
						nexts = append(nexts, step{state: n, action: "Retry", rebound: rebound})
					}
				}
			}
		}

		for _, s := range nexts {
			transitions++
			n := s.state
			switch s.action {
			case "ScheduleDue":
				sawScheduleDue++
			case "WakeWaiting":
				sawWakeWaiting++
				if s.wokeRet {
					sawWakeAfterRetry++
				}
			case "CancelWaiting":
				sawCancelWaiting++
			case "CascadeCancel":
				sawCascadeCancel++
			case "Retry":
				sawRetry++
				if s.rebound {
					sawRetryRebind++
				}
			}

			// RetryPreservesTerminalImmutability: terminal runs never leave terminal status, mutate deps, or hold lease
			for r := 0; r < numRuns; r++ {
				if cur.Exists[r] && isTerminal(cur.Status[r]) {
					if !n.Exists[r] || n.Status[r] != cur.Status[r] || n.Deps[r] != cur.Deps[r] || n.Lease[r] {
						t.Fatalf("RetryPreservesTerminalImmutability violated for run%d via %s: %+v -> %+v", r, s.action, cur, n)
					}
				}
			}

			if !visited[n] {
				visited[n] = true
				queue = append(queue, n)
			}
		}
	}

	if len(visited) < 200 {
		t.Fatalf("unexpectedly small state space: %d states", len(visited))
	}
	if sawWaiting == 0 || sawScheduleDue == 0 || sawWakeWaiting == 0 || sawCancelWaiting == 0 ||
		sawCascadeCancel == 0 || sawRetry == 0 || sawRetryRebind == 0 || sawWakeAfterRetry == 0 {
		t.Fatalf("vacuous model check coverage: waiting=%d scheduleDue=%d wake=%d cancelWait=%d cascade=%d retry=%d rebind=%d wakeAfterRetry=%d",
			sawWaiting, sawScheduleDue, sawWakeWaiting, sawCancelWaiting, sawCascadeCancel, sawRetry, sawRetryRebind, sawWakeAfterRetry)
	}
	t.Logf("RunLifecycle Slice 2 model check passed: %d reachable states, %d transitions verified (wake=%d, retry=%d, rebind=%d, wakeAfterRetry=%d)",
		len(visited), transitions, sawWakeWaiting, sawRetry, sawRetryRebind, sawWakeAfterRetry)
}
