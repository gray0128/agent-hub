---------------------------- MODULE RunLifecycle ----------------------------
EXTENDS Integers, FiniteSets

CONSTANTS Runs, Workdirs

VARIABLES status, workdirLocked, leaseActive, expired

vars == <<status, workdirLocked, leaseActive, expired>>

ActiveStates == {"claimed", "running", "needs_approval"}
TerminalStates == {"done", "failed", "cancelled"}
AllStates == {"queued"} \cup ActiveStates \cup TerminalStates

Init ==
  /\ status = [r \in Runs |-> "queued"]
  /\ workdirLocked = [w \in Workdirs |-> "none"]
  /\ leaseActive = [r \in Runs |-> FALSE]
  /\ expired = [r \in Runs |-> FALSE]

(* CAS queued -> claimed with workdir mutex *)
Claim(r, w) ==
  /\ status[r] = "queued"
  /\ workdirLocked[w] = "none"
  /\ status' = [status EXCEPT ![r] = "claimed"]
  /\ workdirLocked' = [workdirLocked EXCEPT ![w] = r]
  /\ leaseActive' = [leaseActive EXCEPT ![r] = TRUE]
  /\ expired' = [expired EXCEPT ![r] = FALSE]

StartExecution(r) ==
  /\ status[r] = "claimed"
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ UNCHANGED <<workdirLocked, leaseActive, expired>>

EnterApproval(r) ==
  /\ status[r] = "running"
  /\ status' = [status EXCEPT ![r] = "needs_approval"]
  /\ UNCHANGED <<workdirLocked, leaseActive, expired>>

ResumeApproval(r) ==
  /\ status[r] = "needs_approval"
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ UNCHANGED <<workdirLocked, leaseActive, expired>>

Complete(r, w, finalState) ==
  /\ finalState \in {"done", "failed", "cancelled"}
  /\ status[r] \in ActiveStates
  /\ workdirLocked[w] = r
  /\ status' = [status EXCEPT ![r] = finalState]
  /\ workdirLocked' = [workdirLocked EXCEPT ![w] = "none"]
  /\ leaseActive' = [leaseActive EXCEPT ![r] = FALSE]
  /\ UNCHANGED expired

CancelQueued(r) ==
  /\ status[r] = "queued"
  /\ status' = [status EXCEPT ![r] = "cancelled"]
  /\ UNCHANGED <<workdirLocked, leaseActive, expired>>

LeaseExpireAndReap(r, w) ==
  /\ status[r] \in ActiveStates
  /\ leaseActive[r] = TRUE
  /\ workdirLocked[w] = r
  /\ status' = [status EXCEPT ![r] = "failed"]
  /\ workdirLocked' = [workdirLocked EXCEPT ![w] = "none"]
  /\ leaseActive' = [leaseActive EXCEPT ![r] = FALSE]
  /\ expired' = [expired EXCEPT ![r] = TRUE]

Next ==
  \/ \E r \in Runs, w \in Workdirs : Claim(r, w)
  \/ \E r \in Runs : StartExecution(r)
  \/ \E r \in Runs : EnterApproval(r)
  \/ \E r \in Runs : ResumeApproval(r)
  \/ \E r \in Runs, w \in Workdirs, s \in TerminalStates : Complete(r, w, s)
  \/ \E r \in Runs : CancelQueued(r)
  \/ \E r \in Runs, w \in Workdirs : LeaseExpireAndReap(r, w)

TypeInvariant ==
  /\ \A r \in Runs : status[r] \in AllStates
  /\ \A w \in Workdirs : workdirLocked[w] \in (Runs \cup {"none"})

WorkdirMutexInvariant ==
  \A w \in Workdirs :
    Cardinality({r \in Runs : status[r] \in ActiveStates /\ workdirLocked[w] = r}) <= 1

NoActiveWithoutLease ==
  \A r \in Runs : status[r] \in ActiveStates => leaseActive[r] = TRUE

TerminalReleasesWorkdir ==
  \A w \in Workdirs :
    workdirLocked[w] # "none" => status[workdirLocked[w]] \in ActiveStates

Spec == Init /\ [][Next]_vars
=============================================================================
