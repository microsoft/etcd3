---------------------------- MODULE Etcd3Watcher ----------------------------

EXTENDS TLC

(***************************************************************************)
(* Declarations of the GRPC connection state                               *)
(***************************************************************************)
CONSTANT Idle, Connected, Connecting
CONSTANT Unsubscribing, Unsubscribed, Subscribing, Subscribed

(***************************************************************************
--algorithm Watch {
    variable socket = Idle, watcher = Unsubscribed;

    (************************************************************************)
    (* Small 'hack' to get around macro expansion only providing us access  *)
    (* to socket' rather than socket, which prevents us from verifying      *)
    (* transitions.                                                         *)
    (************************************************************************)
    define { prevWatcher == watcher }

    macro CheckInvariants() {
        assert socket \in {Idle, Connected, Connecting};
        assert watcher \in {Subscribed, Subscribing, Unsubscribed, Unsubscribing};
        assert socket = Connected \/ watcher # Subscribed;

        if (prevWatcher = Unsubscribing) {
            assert watcher \in {Unsubscribing, Unsubscribed}
        } else if (prevWatcher = Subscribing) {
            assert watcher \in {Subscribing, Subscribed}
        }
    }

    (************************************************************************)
    (* Watcher is the class attached to the manager that handles the state  *)
    (* of an individual subscription. It can requset to be subscribed or    *)
    (* unsubscribed at any time.                                            *)
    (************************************************************************)
    process (Watcher = 0) { l0: while (TRUE) {
            if (watcher = Subscribed) {
                watcher := Unsubscribing
            } else if (watcher = Unsubscribed) {
                watcher := Subscribing
            }
        }
    }

    (************************************************************************)
    (* The manager handles global socket state and reconnections.           *)
    (************************************************************************)
    process (Manager = 1) { l1: while (TRUE) {
            if (socket = Idle) {
                goto connect
            } else {
                either goto connected or goto disconnect
            };

        disconnect:
            (************************************************************)
            (* Transitioning from "connected" or "connecting" to        *)
            (* "disonnectined". The watcher gets kicked off if they ask *)
            (* to be, otherwise we mark it as reconnecting.             *)
            (************************************************************)
            if (watcher \in {Unsubscribed, Unsubscribing}) {
                watcher := Unsubscribed
            } else {
                watcher := Subscribing
            };

            socket := Idle;
            CheckInvariants();

        connect:
            (************************************************************)
            (* Transitioning from "disconnecting" to "connecting". If   *)
            (* the watcher wants to be unsubscribed, unsubscribe here!  *)
            (************************************************************)
            assert socket = Idle;
            if (watcher \in {Unsubscribed, Unsubscribing}) {
                watcher := Unsubscribed
            };
            socket := Connecting;
            CheckInvariants();

        connected:
            (************************************************************)
            (* In contact the server, the watcher will be unsubscribed  *)
            (* if it asked to be, or connecting if it's subscribing.    *)
            (************************************************************)
            socket := Connected;
            if (watcher = Subscribing) {
                watcher := Subscribed
            } else if (watcher = Unsubscribing) {
                watcher := Unsubscribed
            };

            CheckInvariants();
        }
    }
}
 ***************************************************************************)
\* BEGIN TRANSLATION
VARIABLES socket, watcher, pc

(* define statement *)
prevWatcher == watcher


vars == << socket, watcher, pc >>

ProcSet == {0} \cup {1}

Init == (* Global variables *)
        /\ socket = Idle
        /\ watcher = Unsubscribed
        /\ pc = [self \in ProcSet |-> CASE self = 0 -> "l0"
                                        [] self = 1 -> "l1"]

l0 == /\ pc[0] = "l0"
      /\ IF watcher = Subscribed
            THEN /\ watcher' = Unsubscribing
            ELSE /\ IF watcher = Unsubscribed
                       THEN /\ watcher' = Subscribing
                       ELSE /\ TRUE
                            /\ UNCHANGED watcher
      /\ pc' = [pc EXCEPT ![0] = "l0"]
      /\ UNCHANGED socket

Watcher == l0

l1 == /\ pc[1] = "l1"
      /\ IF socket = Idle
            THEN /\ pc' = [pc EXCEPT ![1] = "connect"]
            ELSE /\ \/ /\ pc' = [pc EXCEPT ![1] = "connected"]
                    \/ /\ pc' = [pc EXCEPT ![1] = "disconnect"]
      /\ UNCHANGED << socket, watcher >>

disconnect == /\ pc[1] = "disconnect"
              /\ IF watcher \in {Unsubscribed, Unsubscribing}
                    THEN /\ watcher' = Unsubscribed
                    ELSE /\ watcher' = Subscribing
              /\ socket' = Idle
              /\ Assert(socket' \in {Idle, Connected, Connecting},
                        "Failure of assertion at line 23, column 9 of macro called at line 71, column 13.")
              /\ Assert(watcher' \in {Subscribed, Subscribing, Unsubscribed, Unsubscribing},
                        "Failure of assertion at line 24, column 9 of macro called at line 71, column 13.")
              /\ Assert(socket' = Connected \/ watcher' # Subscribed,
                        "Failure of assertion at line 25, column 9 of macro called at line 71, column 13.")
              /\ IF prevWatcher = Unsubscribing
                    THEN /\ Assert(watcher' \in {Unsubscribing, Unsubscribed},
                                   "Failure of assertion at line 28, column 13 of macro called at line 71, column 13.")
                    ELSE /\ IF prevWatcher = Subscribing
                               THEN /\ Assert(watcher' \in {Subscribing, Subscribed},
                                              "Failure of assertion at line 30, column 13 of macro called at line 71, column 13.")
                               ELSE /\ TRUE
              /\ pc' = [pc EXCEPT ![1] = "connect"]

connect == /\ pc[1] = "connect"
           /\ Assert(socket = Idle,
                     "Failure of assertion at line 78, column 13.")
           /\ IF watcher \in {Unsubscribed, Unsubscribing}
                 THEN /\ watcher' = Unsubscribed
                 ELSE /\ TRUE
                      /\ UNCHANGED watcher
           /\ socket' = Connecting
           /\ Assert(socket' \in {Idle, Connected, Connecting},
                     "Failure of assertion at line 23, column 9 of macro called at line 83, column 13.")
           /\ Assert(watcher' \in {Subscribed, Subscribing, Unsubscribed, Unsubscribing},
                     "Failure of assertion at line 24, column 9 of macro called at line 83, column 13.")
           /\ Assert(socket' = Connected \/ watcher' # Subscribed,
                     "Failure of assertion at line 25, column 9 of macro called at line 83, column 13.")
           /\ IF prevWatcher = Unsubscribing
                 THEN /\ Assert(watcher' \in {Unsubscribing, Unsubscribed},
                                "Failure of assertion at line 28, column 13 of macro called at line 83, column 13.")
                 ELSE /\ IF prevWatcher = Subscribing
                            THEN /\ Assert(watcher' \in {Subscribing, Subscribed},
                                           "Failure of assertion at line 30, column 13 of macro called at line 83, column 13.")
                            ELSE /\ TRUE
           /\ pc' = [pc EXCEPT ![1] = "connected"]

connected == /\ pc[1] = "connected"
             /\ socket' = Connected
             /\ IF watcher = Subscribing
                   THEN /\ watcher' = Subscribed
                   ELSE /\ IF watcher = Unsubscribing
                              THEN /\ watcher' = Unsubscribed
                              ELSE /\ TRUE
                                   /\ UNCHANGED watcher
             /\ Assert(socket' \in {Idle, Connected, Connecting},
                       "Failure of assertion at line 23, column 9 of macro called at line 97, column 13.")
             /\ Assert(watcher' \in {Subscribed, Subscribing, Unsubscribed, Unsubscribing},
                       "Failure of assertion at line 24, column 9 of macro called at line 97, column 13.")
             /\ Assert(socket' = Connected \/ watcher' # Subscribed,
                       "Failure of assertion at line 25, column 9 of macro called at line 97, column 13.")
             /\ IF prevWatcher = Unsubscribing
                   THEN /\ Assert(watcher' \in {Unsubscribing, Unsubscribed},
                                  "Failure of assertion at line 28, column 13 of macro called at line 97, column 13.")
                   ELSE /\ IF prevWatcher = Subscribing
                              THEN /\ Assert(watcher' \in {Subscribing, Subscribed},
                                             "Failure of assertion at line 30, column 13 of macro called at line 97, column 13.")
                              ELSE /\ TRUE
             /\ pc' = [pc EXCEPT ![1] = "l1"]

Manager == l1 \/ disconnect \/ connect \/ connected

Next == Watcher \/ Manager

Spec == Init /\ [][Next]_vars

\* END TRANSLATION

=============================================================================
\* Modification History
\* Last modified Thu Jun 15 21:12:44 PDT 2017 by Connor
\* Created Thu Jun 15 08:07:31 PDT 2017 by Connor
