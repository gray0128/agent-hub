---------------------------- MODULE RunLifecycle ----------------------------
EXTENDS Integers, FiniteSets

CONSTANTS Runs, Workdirs

VARIABLES exists, status, workdirLocked, leaseActive, expired, deps, scheduled, retryOf

vars == <<exists, status, workdirLocked, leaseActive, expired, deps, scheduled, retryOf>>

ActiveStates == {"claimed", "running", "needs_approval"}
TerminalStates == {"done", "failed", "cancelled"}
AllStates == {"waiting", "queued"} \cup ActiveStates \cup TerminalStates

AcyclicDeps(d) ==
  /\ \A r \in Runs : r \notin d[r]
  /\ \A a, b \in Runs : ~(a \in d[b] /\ b \in d[a])

Init ==
  \E spare \in Runs :
    /\ exists = [r \in Runs |-> r # spare]
    /\ deps \in [Runs -> SUBSET (Runs \ {spare})]
    /\ deps[spare] = {}
    /\ AcyclicDeps(deps)
    /\ scheduled \in [Runs -> BOOLEAN]
    /\ scheduled[spare] = FALSE
    /\ status = [r \in Runs |->
         IF r = spare THEN "waiting"
         ELSE IF (deps[r] # {} \/ scheduled[r] = TRUE) THEN "waiting"
         ELSE "queued"]
    /\ workdirLocked = [w \in Workdirs |-> "none"]
    /\ leaseActive = [r \in Runs |-> FALSE]
    /\ expired = [r \in Runs |-> FALSE]
    /\ retryOf = [r \in Runs |-> "none"]

(* Cron / clock reaches scheduled_at for a waiting run *)
ScheduleDue(r) ==
  /\ exists[r]
  /\ status[r] = "waiting"
  /\ scheduled[r] = TRUE
  /\ scheduled' = [scheduled EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<exists, status, workdirLocked, leaseActive, expired, deps, retryOf>>

(* CAS waiting -> queued when all dependencies are done and schedule is satisfied *)
WakeWaiting(r) ==
  /\ exists[r]
  /\ status[r] = "waiting"
  /\ scheduled[r] = FALSE
  /\ \A d \in deps[r] : exists[d] /\ status[d] = "done"
  /\ status' = [status EXCEPT ![r] = "queued"]
  /\ UNCHANGED <<exists, workdirLocked, leaseActive, expired, deps, scheduled, retryOf>>

(* CAS waiting -> cancelled *)
CancelWaiting(r) ==
  /\ exists[r]
  /\ status[r] = "waiting"
  /\ status' = [status EXCEPT ![r] = "cancelled"]
  /\ UNCHANGED <<exists, workdirLocked, leaseActive, expired, deps, scheduled, retryOf>>

(* CAS queued -> claimed with workdir mutex *)
Claim(r, w) ==
  /\ exists[r]
  /\ status[r] = "queued"
  /\ workdirLocked[w] = "none"
  /\ status' = [status EXCEPT ![r] = "claimed"]
  /\ workdirLocked' = [workdirLocked EXCEPT ![w] = r]
  /\ leaseActive' = [leaseActive EXCEPT ![r] = TRUE]
  /\ expired' = [expired EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<exists, deps, scheduled, retryOf>>

StartExecution(r) ==
  /\ exists[r]
  /\ status[r] = "claimed"
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ UNCHANGED <<exists, workdirLocked, leaseActive, expired, deps, scheduled, retryOf>>

EnterApproval(r) ==
  /\ exists[r]
  /\ status[r] = "running"
  /\ status' = [status EXCEPT ![r] = "needs_approval"]
  /\ UNCHANGED <<exists, workdirLocked, leaseActive, expired, deps, scheduled, retryOf>>

ResumeApproval(r) ==
  /\ exists[r]
  /\ status[r] = "needs_approval"
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ UNCHANGED <<exists, workdirLocked, leaseActive, expired, deps, scheduled, retryOf>>

Complete(r, w, finalState) ==
  /\ exists[r]
  /\ finalState \in TerminalStates
  /\ status[r] \in ActiveStates
  /\ workdirLocked[w] = r
  /\ status' = [status EXCEPT ![r] = finalState]
  /\ workdirLocked' = [workdirLocked EXCEPT ![w] = "none"]
  /\ leaseActive' = [leaseActive EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<exists, expired, deps, scheduled, retryOf>>

CancelQueued(r) ==
  /\ exists[r]
  /\ status[r] = "queued"
  /\ status' = [status EXCEPT ![r] = "cancelled"]
  /\ UNCHANGED <<exists, workdirLocked, leaseActive, expired, deps, scheduled, retryOf>>

CascadeCancel(root) ==
  /\ exists[root]
  /\ status[root] \notin TerminalStates
  /\ LET directDeps == {d \in Runs : exists[d] /\ status[d] = "waiting" /\ root \in deps[d]}
         secondDeps == {d \in Runs : exists[d] /\ status[d] = "waiting" /\ \E m \in directDeps : m \in deps[d]}
         cancelledSet == {root} \cup directDeps \cup secondDeps
     IN
       /\ status' = [r \in Runs |-> IF r \in cancelledSet THEN "cancelled" ELSE status[r]]
       /\ workdirLocked' = [w \in Workdirs |-> IF workdirLocked[w] = root THEN "none" ELSE workdirLocked[w]]
       /\ leaseActive' = [r \in Runs |-> IF r = root THEN FALSE ELSE leaseActive[r]]
       /\ UNCHANGED <<exists, expired, deps, scheduled, retryOf>>

LeaseExpireAndReap(r, w) ==
  /\ exists[r]
  /\ status[r] \in ActiveStates
  /\ leaseActive[r] = TRUE
  /\ workdirLocked[w] = r
  /\ status' = [status EXCEPT ![r] = "failed"]
  /\ workdirLocked' = [workdirLocked EXCEPT ![w] = "none"]
  /\ leaseActive' = [leaseActive EXCEPT ![r] = FALSE]
  /\ expired' = [expired EXCEPT ![r] = TRUE]
  /\ UNCHANGED <<exists, deps, scheduled, retryOf>>

(* Explicit retry creates replacement run rNew while keeping terminal rOld immutable and rebinding waiting dependents *)
Retry(rOld, rNew) ==
  /\ exists[rOld]
  /\ status[rOld] \in {"failed", "cancelled"}
  /\ ~exists[rNew]
  /\ exists' = [exists EXCEPT ![rNew] = TRUE]
  /\ retryOf' = [retryOf EXCEPT ![rNew] = rOld]
  /\ scheduled' = [scheduled EXCEPT ![rNew] = scheduled[rOld]]
  /\ deps' = [r \in Runs |->
       IF r = rNew THEN deps[rOld]
       ELSE IF (exists[r] /\ status[r] = "waiting" /\ rOld \in deps[r])
         THEN (deps[r] \ {rOld}) \cup {rNew}
       ELSE deps[r]]
  /\ status' = [status EXCEPT ![rNew] =
       IF ((\E d \in deps[rOld] : ~exists[d] \/ status[d] # "done") \/ scheduled[rOld] = TRUE)
         THEN "waiting"
         ELSE "queued"]
  /\ UNCHANGED <<workdirLocked, leaseActive, expired>>

Next ==
  \/ \E r \in Runs : ScheduleDue(r)
  \/ \E r \in Runs : WakeWaiting(r)
  \/ \E r \in Runs : CancelWaiting(r)
  \/ \E r \in Runs, w \in Workdirs : Claim(r, w)
  \/ \E r \in Runs : StartExecution(r)
  \/ \E r \in Runs : EnterApproval(r)
  \/ \E r \in Runs : ResumeApproval(r)
  \/ \E r \in Runs, w \in Workdirs, s \in TerminalStates : Complete(r, w, s)
  \/ \E r \in Runs : CancelQueued(r)
  \/ \E r \in Runs : CascadeCancel(r)
  \/ \E r \in Runs, w \in Workdirs : LeaseExpireAndReap(r, w)
  \/ \E rOld, rNew \in Runs : Retry(rOld, rNew)

TypeInvariant ==
  /\ \A r \in Runs :
       /\ exists[r] \in BOOLEAN
       /\ status[r] \in AllStates
       /\ leaseActive[r] \in BOOLEAN
       /\ expired[r] \in BOOLEAN
       /\ deps[r] \subseteq Runs
       /\ r \notin deps[r]
       /\ scheduled[r] \in BOOLEAN
       /\ retryOf[r] \in (Runs \cup {"none"})
  /\ \A w \in Workdirs : workdirLocked[w] \in (Runs \cup {"none"})

WorkdirMutexInvariant ==
  \A w \in Workdirs :
    Cardinality({r \in Runs : exists[r] /\ status[r] \in ActiveStates /\ workdirLocked[w] = r}) <= 1

NoActiveWithoutLease ==
  \A r \in Runs : (exists[r] /\ status[r] \in ActiveStates) => leaseActive[r] = TRUE

TerminalReleasesWorkdir ==
  \A w \in Workdirs :
    workdirLocked[w] # "none" => (exists[workdirLocked[w]] /\ status[workdirLocked[w]] \in ActiveStates)

WaitingNeverHoldsWorkdir ==
  \A r \in Runs :
    status[r] = "waiting" =>
      /\ leaseActive[r] = FALSE
      /\ \A w \in Workdirs : workdirLocked[w] # r

NoClaimBeforeDepsDone ==
  \A r \in Runs :
    (exists[r] /\ status[r] \in ({"queued"} \cup ActiveStates \cup {"done"})) =>
      /\ scheduled[r] = FALSE
      /\ \A d \in deps[r] : exists[d] /\ status[d] = "done"

RetryTargetRemainsTerminal ==
  \A r \in Runs :
    (exists[r] /\ retryOf[r] # "none") =>
      /\ r # retryOf[r]
      /\ exists[retryOf[r]]
      /\ status[retryOf[r]] \in {"failed", "cancelled"}

RetryPreservesTerminalImmutability ==
  [][\A r \in Runs :
       (exists[r] /\ status[r] \in TerminalStates) =>
         /\ exists'[r]
         /\ status'[r] = status[r]
         /\ deps'[r] = deps[r]
         /\ leaseActive'[r] = FALSE
    ]_vars

Spec == Init /\ [][Next]_vars
=============================================================================
