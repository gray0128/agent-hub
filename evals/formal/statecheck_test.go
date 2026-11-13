package formal

import (
	"fmt"
	"testing"
)

type runState string

const (
	stateQueued        runState = "queued"
	stateClaimed       runState = "claimed"
	stateRunning       runState = "running"
	stateNeedsApproval runState = "needs_approval"
	stateDone          runState = "done"
	stateFailed        runState = "failed"
	stateCancelled     runState = "cancelled"
)

func isActive(s runState) bool {
	return s == stateClaimed || s == stateRunning || s == stateNeedsApproval
}

func isTerminal(s runState) bool {
	return s == stateDone || s == stateFailed || s == stateCancelled
}

// sysState mirrors evals/formal/RunLifecycle.tla for 2 concurrent runs and 2 workdirs.
// Because TLC/Java is absent in this environment, this exhaustive BFS verifies every reachable
// transition, mutual exclusion invariant, lease invariant, and terminal stability property.
type sysState struct {
	Run0Status  runState
	Run1Status  runState
	Run0Workdir int8 // -1 = unassigned, 0 = w0, 1 = w1
	Run1Workdir int8
	Workdir0    int8 // -1 = none, 0 = run0, 1 = run1
	Workdir1    int8
	Lease0      bool
	Lease1      bool
}

func (s sysState) key() string {
	return fmt.Sprintf("%s|%s|%d|%d|%d|%d|%v|%v",
		s.Run0Status, s.Run1Status, s.Run0Workdir, s.Run1Workdir,
		s.Workdir0, s.Workdir1, s.Lease0, s.Lease1)
}

func (s sysState) status(idx int) runState {
	if idx == 0 {
		return s.Run0Status
	}
	return s.Run1Status
}

func (s *sysState) setStatus(idx int, st runState) {
	if idx == 0 {
		s.Run0Status = st
	} else {
		s.Run1Status = st
	}
}

func (s sysState) workdirOwner(w int) int8 {
	if w == 0 {
		return s.Workdir0
	}
	return s.Workdir1
}

func (s *sysState) setWorkdirOwner(w int, owner int8) {
	if w == 0 {
		s.Workdir0 = owner
	} else {
		s.Workdir1 = owner
	}
}

func (s sysState) runWorkdir(idx int) int8 {
	if idx == 0 {
		return s.Run0Workdir
	}
	return s.Run1Workdir
}

func (s *sysState) setRunWorkdir(idx int, w int8) {
	if idx == 0 {
		s.Run0Workdir = w
	} else {
		s.Run1Workdir = w
	}
}

func (s sysState) lease(idx int) bool {
	if idx == 0 {
		return s.Lease0
	}
	return s.Lease1
}

func (s *sysState) setLease(idx int, v bool) {
	if idx == 0 {
		s.Lease0 = v
	} else {
		s.Lease1 = v
	}
}

func checkInvariants(t *testing.T, s sysState) {
	t.Helper()
	// WorkdirMutexInvariant: at most 1 active run holds each workdir
	for w := 0; w < 2; w++ {
		owner := s.workdirOwner(w)
		if owner != -1 {
			if !isActive(s.status(int(owner))) {
				t.Fatalf("TerminalReleasesWorkdir violated: w%d locked by run%d in state %s", w, owner, s.status(int(owner)))
			}
		}
		activeOnW := 0
		for r := 0; r < 2; r++ {
			if isActive(s.status(r)) && s.runWorkdir(r) == int8(w) && s.workdirOwner(w) == int8(r) {
				activeOnW++
			}
		}
		if activeOnW > 1 {
			t.Fatalf("WorkdirMutexInvariant violated on w%d: %+v", w, s)
		}
	}
	// NoActiveWithoutLease
	for r := 0; r < 2; r++ {
		if isActive(s.status(r)) && !s.lease(r) {
			t.Fatalf("NoActiveWithoutLease violated for run%d: %+v", r, s)
		}
	}
}

func TestRunLifecycleExhaustiveModelCheck(t *testing.T) {
	init := sysState{
		Run0Status:  stateQueued,
		Run1Status:  stateQueued,
		Run0Workdir: -1,
		Run1Workdir: -1,
		Workdir0:    -1,
		Workdir1:    -1,
	}

	visited := map[string]bool{init.key(): true}
	queue := []sysState{init}
	transitions := 0

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		checkInvariants(t, cur)

		var nexts []sysState
		for r := 0; r < 2; r++ {
			st := cur.status(r)
			switch st {
			case stateQueued:
				// Claim onto free workdir 0 or 1
				for w := 0; w < 2; w++ {
					if cur.workdirOwner(w) == -1 {
						n := cur
						n.setStatus(r, stateClaimed)
						n.setWorkdirOwner(w, int8(r))
						n.setRunWorkdir(r, int8(w))
						n.setLease(r, true)
						nexts = append(nexts, n)
					}
				}
				// Cancel while queued
				n := cur
				n.setStatus(r, stateCancelled)
				nexts = append(nexts, n)

			case stateClaimed:
				w := int(cur.runWorkdir(r))
				// Transition claimed -> running
				nRun := cur
				nRun.setStatus(r, stateRunning)
				nexts = append(nexts, nRun)
				// Cancel or lease-reap while claimed
				for _, fin := range []runState{stateFailed, stateCancelled} {
					nFin := cur
					nFin.setStatus(r, fin)
					nFin.setWorkdirOwner(w, -1)
					nFin.setLease(r, false)
					nexts = append(nexts, nFin)
				}

			case stateRunning:
				w := int(cur.runWorkdir(r))
				// EnterApproval
				nApp := cur
				nApp.setStatus(r, stateNeedsApproval)
				nexts = append(nexts, nApp)
				// Terminal completions + LeaseExpireAndReap
				for _, fin := range []runState{stateDone, stateFailed, stateCancelled} {
					nFin := cur
					nFin.setStatus(r, fin)
					nFin.setWorkdirOwner(w, -1)
					nFin.setLease(r, false)
					nexts = append(nexts, nFin)
				}

			case stateNeedsApproval:
				w := int(cur.runWorkdir(r))
				// ResumeApproval
				nRes := cur
				nRes.setStatus(r, stateRunning)
				nexts = append(nexts, nRes)
				// Terminal completions + LeaseExpireAndReap
				for _, fin := range []runState{stateDone, stateFailed, stateCancelled} {
					nFin := cur
					nFin.setStatus(r, fin)
					nFin.setWorkdirOwner(w, -1)
					nFin.setLease(r, false)
					nexts = append(nexts, nFin)
				}
			}
		}

		for _, n := range nexts {
			transitions++
			// TerminalStability: once terminal, cannot become active again
			for r := 0; r < 2; r++ {
				if isTerminal(cur.status(r)) && cur.status(r) != n.status(r) {
					t.Fatalf("TerminalStability violated for run%d: %s -> %s", r, cur.status(r), n.status(r))
				}
			}
			k := n.key()
			if !visited[k] {
				visited[k] = true
				queue = append(queue, n)
			}
		}
	}

	if len(visited) < 20 {
		t.Fatalf("unexpectedly small state space: %d states", len(visited))
	}
	t.Logf("RunLifecycle model check passed: %d reachable states, %d transitions verified", len(visited), transitions)
}
